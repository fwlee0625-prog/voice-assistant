/** Provider-specific connection and start frame; no browser session state here. */
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import type { ServerConfig } from "../config.ts";
import { createUserSig } from "./signature.ts";

export interface AsrConnection {
  socket: WebSocket;
  start: object;
}
export type ConnectAsr = () => AsrConnection;

export function tencentConnector(config: ServerConfig["asr"]): ConnectAsr {
  return () => {
    if (!config.appId || !config.secretKey)
      throw new Error("请在 server/.env 配置 TENCENT_TRTC_SDK_APP_ID 和 TENCENT_TRTC_SECRET_KEY");
    if (
      !/^\d+$/.test(config.appId) ||
      !Number.isSafeInteger(Number(config.appId)) ||
      Number(config.appId) <= 0
    ) {
      throw new Error("TENCENT_TRTC_SDK_APP_ID 必须是数字 TRTC 应用 ID，不能填写 CAM SecretId");
    }
    const voiceId = randomUUID().replaceAll("-", "");
    return {
      socket: new WebSocket(`wss://asr.cloud-rtc.com/asr/v3?voice_id=${voiceId}`, {
        handshakeTimeout: 10000,
        maxPayload: 1024 * 1024,
        perMessageDeflate: false,
      }),
      start: {
        type: "start",
        auth: {
          sdkappid: config.appId,
          usersig: createUserSig(config.appId, config.secretKey, voiceId),
        },
        params: {
          voice_id: voiceId,
          engine_model_type: "bigmodel",
          language: "zh",
          voice_format: 1,
          needvad: 1,
          speaker_diarization: 1,
        },
      },
    };
  };
}
