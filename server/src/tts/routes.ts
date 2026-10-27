/** Pure TTS HTTP endpoint; provider protocols stay in the adapter. */
import { Router } from 'express';
import type { SettingsStore } from '../settings/store.ts';
import type { LlmCredentials } from '../config.ts';
import { HttpError } from '../http/errors.ts';
import { TTS_VOICES } from './provider.ts';
import { createXiaomiTts } from './xiaomi.ts';
import { pcmToWav } from './wav.ts';

export function ttsRoutes(store: SettingsStore, credentials?: LlmCredentials) {
  const router = Router();
  router.post('/api/tts', async (req, res) => {
    const body = req.body;
    if (!body || typeof body.text !== 'string' || !body.text.trim() || body.text.length > 16000)
      throw new HttpError(400, 'text 必须是 1–16000 字符的非空文本');
    if (body.stream !== undefined && typeof body.stream !== 'boolean')
      throw new HttpError(400, 'stream 必须是布尔值');
    if (body.voice !== undefined && (typeof body.voice !== 'string' || !TTS_VOICES.includes(body.voice)))
      throw new HttpError(400, '不支持的 TTS 音色');
    const voice = body.voice ?? (await store.read()).tts?.voice ?? '冰糖';
    const key = credentials?.get();
    if (!key) throw new HttpError(503, '请在设置中配置小米 TTS API Key');
    const streaming = body.stream === true;
    const controller = new AbortController();
    const cancel = () => { if (!res.writableEnded) controller.abort(); };
    res.once('close', cancel);
    const timeout = setTimeout(() => controller.abort(), 60000);
    const emit = async (event: unknown) => {
      controller.signal.throwIfAborted();
      if (res.write('data: ' + JSON.stringify(event) + '\n\n')) return;
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => { clearTimeout(timer); res.off('drain', drained); controller.signal.removeEventListener('abort', aborted); };
        const drained = () => { cleanup(); resolve(); };
        const aborted = () => { cleanup(); reject(new Error('Cancelled')); };
        const timer = setTimeout(() => controller.abort(), 10000);
        res.once('drain', drained); controller.signal.addEventListener('abort', aborted, { once: true });
        if (controller.signal.aborted) aborted();
      });
    };
    try {
      res.set('Cache-Control', 'no-store');
      const buffers: Buffer[] = [];
      let bytes = 0;
      let sampleRate = 0;
      for await (const chunk of createXiaomiTts(key).synthesize({ text: body.text.trim(), voice, signal: controller.signal })) {
        controller.signal.throwIfAborted();
        if (sampleRate && sampleRate !== chunk.sampleRate) throw new HttpError(502, '语音音频格式不一致');
        sampleRate = chunk.sampleRate;
        const pcm = Buffer.from(chunk.data, 'base64');
        bytes += pcm.length;
        if (bytes > 32 * 1024 * 1024) throw new HttpError(502, '合成音频超过 32MB 限制');
        if (streaming) {
          if (!res.headersSent) {
            res.set({ 'Content-Type': 'text/event-stream', 'X-Accel-Buffering': 'no' });
            res.flushHeaders();
          }
          await emit({ type: 'audio', ...chunk });
        } else buffers.push(pcm);
      }
      controller.signal.throwIfAborted();
      if (!bytes || bytes % 2) throw new HttpError(502, '合成音频为空或不完整');
      if (streaming) { await emit({ type: 'done' }); res.end(); }
      else res.type('audio/wav').send(pcmToWav(Buffer.concat(buffers, bytes), sampleRate));
    } catch (error) {
      if (res.destroyed) return;
      const safe = controller.signal.aborted ? new HttpError(504, '语音合成超时')
        : error instanceof HttpError ? error : new HttpError(502, '语音合成失败');
      if (!res.headersSent) throw safe;
      // After SSE begins, failures are terminal events and never claim success.
      res.end('data: ' + JSON.stringify({ type: 'error', error: safe.message }) + '\n\n');
    } finally {
      clearTimeout(timeout); controller.abort(); res.off('close', cancel);
    }
  });
  return router;
}
