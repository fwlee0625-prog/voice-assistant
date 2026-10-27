import { Router } from 'express';
import type { SettingsStore } from './store.ts';
import type { LlmCredentials } from '../config.ts';
import { HttpError } from '../http/errors.ts';

export function settingsRoutes(store: SettingsStore, credentials: LlmCredentials, origins: Set<string>, ttsCredentials?: LlmCredentials) {
  const router = Router();
  // Browsers must originate from this app before changing server configuration.
  router.use('/api/settings', (req, _res, next) => {
    const origin = req.headers.origin;
    if ((origin && !origins.has(origin)) || req.headers['sec-fetch-site'] === 'cross-site')
      throw new HttpError(403, '不允许的请求来源');
    next();
  });
  router.get('/api/settings', async (_req, res) => {
    res.set('Cache-Control', 'no-store').json({ ...await store.read(), apiKeyConfigured: !!credentials.get(), ttsApiKeyConfigured: !!ttsCredentials?.get() });
  });
  router.put('/api/settings', async (req, res) => {
    const key = req.body?.apiKey;
    if (key !== undefined && (typeof key !== 'string' || key.length > 4096 || /[\s"'`#\\]/.test(key)))
      throw new HttpError(400, 'API Key 格式无效');
    const ttsKey = req.body?.ttsApiKey;
    if (ttsKey !== undefined && (typeof ttsKey !== 'string' || ttsKey.length > 4096 || /[\s"'`#\\]/.test(ttsKey)))
      throw new HttpError(400, 'TTS API Key 格式无效');
    const preferences = await store.write(req.body);
    if (typeof key === 'string' && key) await credentials.set(key);
    if (typeof ttsKey === 'string' && ttsKey) await ttsCredentials?.set(ttsKey);
    res.set('Cache-Control', 'no-store').json({ ...preferences, apiKeyConfigured: !!credentials.get(), ttsApiKeyConfigured: !!ttsCredentials?.get() });
  });
  return router;
}
