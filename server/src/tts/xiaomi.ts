import { readSse } from '../http/sse.ts';
import { HttpError } from '../http/errors.ts';
import type { TtsProvider } from './provider.ts';

export function createXiaomiTts(key: string): TtsProvider {
  return {
    async *synthesize({ text, voice, style, signal }) {
      if (!key) throw new HttpError(503, '请在设置中配置小米 TTS API Key');
      try {
        const response = await fetch('https://api.xiaomimimo.com/v1/chat/completions', {
          method: 'POST', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
          body: JSON.stringify({ model: 'mimo-v2.5-tts', stream: true,
            messages: [...(style ? [{ role: 'user', content: `请用以下语气朗读，保持所选音色，只读正文：${style}` }] : []), { role: 'assistant', content: text }], audio: { format: 'pcm16', voice } }),
        });
        if (!response.ok) { await response.body?.cancel(); throw new HttpError(502,
          response.status === 401 || response.status === 403 ? '小米 TTS 鉴权失败，请检查密钥' : `小米 TTS 请求失败（${response.status}）`); }
        let received = false; let finished = false;
        for await (const data of readSse(response)) {
          if (data === '[DONE]') { finished = true; break; }
          const chunk = JSON.parse(data);
          if (chunk.error) throw new Error('Provider stream error');
          const choice = chunk.choices?.[0];
          const audio = choice?.delta?.audio?.data;
          if (typeof audio === 'string' && audio) {
            if (!/^[A-Za-z0-9+/]*={0,2}$/.test(audio) || audio.length % 4 !== 0) throw new Error('Invalid audio');
            received = true;
            yield { data: audio, sampleRate: 24000, channels: 1, format: 'pcm16' };
          }
          if (choice?.finish_reason) {
            if (choice.finish_reason !== 'stop') throw new Error('Incomplete audio');
            finished = true;
          }
        }
        if (!received || !finished) throw new Error('Empty or incomplete audio');
      } catch (error) {
        if (error instanceof HttpError) throw error;
        if (signal.aborted) throw new HttpError(499, '语音合成已取消');
        throw new HttpError(502, '小米语音合成失败或超时，文字回答仍可查看');
      }
    },
  };
}
