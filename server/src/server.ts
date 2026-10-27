/** Assemble HTTP + WebSocket transports with explicit dependencies for integration tests. */
import { createTurnDetector, type TurnDetector } from './turns/worker.ts';
import { resolve } from 'node:path';
import { createSettingsStore, type SettingsStore } from './settings/store.ts';
import { createLlmCredentials, createTtsCredentials, serverRoot, type LlmCredentials } from './config.ts';
import { createServer } from "node:http";
import type { ServerConfig } from "./config.ts";
import { createApp } from "./app.ts";
import { attachAsr } from "./asr/upgrade.ts";
import { tencentConnector } from "./asr/tencent-client.ts";
import type { ConnectAsr } from "./asr/tencent-client.ts";
import { createEnhancer } from "./enhancement/worker.ts";
import type { EnhanceAudio } from "./enhancement/worker.ts";
import { createFillerDecision, type FillerDecision } from './chat/filler-decision.ts';

export function createVoiceServer(
  config: ServerConfig,
  overrides: { connectAsr?: ConnectAsr; enhance?: EnhanceAudio; settings?: SettingsStore; credentials?: LlmCredentials; ttsCredentials?: LlmCredentials; turnDetector?: TurnDetector; decideFiller?: FillerDecision } = {},
) {
  const turnDetector = overrides.turnDetector || createTurnDetector(config.turns);
  const server = createServer(createApp(
    overrides.enhance || createEnhancer(config.enhancement),
    overrides.settings || createSettingsStore(resolve(serverRoot, 'data/settings.json')),
    overrides.credentials || createLlmCredentials(), config.allowedOrigins,
    overrides.ttsCredentials || createTtsCredentials(),
    overrides.decideFiller || createFillerDecision(config.decision),
  ));
  const detachAsr = attachAsr(
    server,
    config.allowedOrigins,
    overrides.connectAsr || tencentConnector(config.asr), turnDetector,
  );
  return { server, closeAsr() { detachAsr(); turnDetector.close(); } };
}
