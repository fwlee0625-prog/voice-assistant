/** Compose HTTP routes. Importing this file never opens a listening port. */
import express from "express";
import { settingsRoutes } from './settings/routes.ts';
import { chatRoutes } from './chat/routes.ts';
import { ttsRoutes } from './tts/routes.ts';
import type { SettingsStore } from './settings/store.ts';
import type { LlmCredentials } from './config.ts';
import { enhancementRoutes } from "./enhancement/routes.ts";
import type { EnhanceAudio } from "./enhancement/worker.ts";
import { errorHandler } from "./http/errors.ts";
import type { FillerDecision } from './chat/filler-decision.ts';
import { wakeRoutes } from './wake/routes.ts';

export function createApp(enhance: EnhanceAudio, settings: SettingsStore, credentials: LlmCredentials, origins: Set<string>, ttsCredentials?: LlmCredentials, decideFiller?: FillerDecision) {
  const app = express();
  app.disable("x-powered-by");
  app.get("/api/health", (_req, res) =>
    res.json({ status: "ok", service: "billiards_voice", backend: "express" }),
  );
  app.use(enhancementRoutes(enhance));
  app.use(express.json({ limit: '256kb' }));
  app.use(settingsRoutes(settings, credentials, origins, ttsCredentials));
  app.use(wakeRoutes(settings, credentials, origins));
  app.use(chatRoutes(settings, credentials, ttsCredentials, decideFiller));
  app.use(ttsRoutes(settings, ttsCredentials));
  app.use((_req, res) => {
    res.status(404).json({ status: "error", error: "接口不存在" });
  });
  app.use(errorHandler);
  return app;
}
