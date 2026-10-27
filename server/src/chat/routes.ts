import { Router } from 'express';
import type { SettingsStore } from '../settings/store.ts';
import type { LlmCredentials } from '../config.ts';
import { completeChat, streamChat, validateMessages } from './client.ts';
import { streamSpokenReply } from './speech.ts';
import { createXiaomiTts } from '../tts/xiaomi.ts';
import { HttpError } from '../http/errors.ts';
import type { FillerDecision } from './filler-decision.ts';

export function chatRoutes(store: SettingsStore, credentials: LlmCredentials, ttsCredentials?: LlmCredentials, decideFiller?: FillerDecision) {
  const router = Router();
  router.post('/api/chat/completions', async (req, res) => {
    const messages = validateMessages(req.body);
    const controller = new AbortController();
    const cancel = () => { if (!res.writableEnded) controller.abort(); };
    res.once('close', cancel);
    const timeout = setTimeout(() => controller.abort(), 240000);
    try {
      const settings = await store.read();
      if (req.body.stream !== true) {
        const result = await completeChat(settings, credentials.get(), messages, controller.signal);
        if (!controller.signal.aborted) res.set('Cache-Control', 'no-store').json(result);
        return;
      }
      res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
      res.flushHeaders();
      const emit = async (event: unknown) => {
        controller.signal.throwIfAborted();
        if (res.write('data: ' + JSON.stringify(event) + '\n\n')) return;
        await new Promise<void>((resolve, reject) => {
          const cleanup = () => { res.off('drain', drained); controller.signal.removeEventListener('abort', aborted); clearTimeout(timer); };
          const drained = () => { cleanup(); resolve(); };
          const aborted = () => { cleanup(); reject(new Error('Disconnected')); };
          const timer = setTimeout(() => controller.abort(), 10000);
          res.once('drain', drained); controller.signal.addEventListener('abort', aborted, { once: true });
          if (controller.signal.aborted) aborted();
        });
      };
      try {
        await streamSpokenReply(streamChat(settings, credentials.get(), messages, controller.signal, req.body.sessionControl === true ? async action => { await emit({ type: 'control', action }); } : undefined),
          settings.tts?.enabled ? createXiaomiTts(ttsCredentials?.get() || '') : undefined,
          settings.tts?.voice || '冰糖', controller.signal, emit,
          { filler: settings.tts?.filler !== false, fillers: settings.tts?.fillers, messages, decideFiller });
      } catch (error) {
        if (!controller.signal.aborted) await emit({ type: 'error', error: error instanceof HttpError ? error.message : '回答失败，请重试' });
      }
      if (!res.destroyed) res.end();
    } finally { clearTimeout(timeout); controller.abort(); res.off('close', cancel); }
  });
  return router;
}
