import { Router } from 'express';
import type { SettingsStore } from '../settings/store.ts';
import type { LlmCredentials } from '../config.ts';
import { HttpError } from '../http/errors.ts';
import { generateWakePhonemes, validateWakeText } from './phonemes.ts';

export function wakeRoutes(store: SettingsStore, credentials: LlmCredentials, origins: Set<string>) {
  const router = Router();
  router.post('/api/wake/phonemes', async (req, res) => {
    const origin = req.headers.origin;
    if ((origin && !origins.has(origin)) || req.headers['sec-fetch-site'] === 'cross-site')
      throw new HttpError(403, '不允许的请求来源');
    const text = validateWakeText(req.body?.text);
    const controller = new AbortController();
    const cancel = () => { if (!res.writableEnded) controller.abort(); };
    res.once('close', cancel);
    try {
      const result = await generateWakePhonemes(text, await store.read(), credentials.get(), controller.signal);
      if (!controller.signal.aborted) res.set('Cache-Control', 'no-store').json(result);
    } finally { controller.abort(); res.off('close', cancel); }
  });
  return router;
}
