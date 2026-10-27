/** One browser ↔ provider session: ordering, audio limits, deadlines and disposal. */
import { createTurnSession, type TurnEvent } from '../turns/session.ts';
import type { TurnDetector } from '../turns/worker.ts';
import WebSocket from "ws";
import type { RawData } from "ws";
import type { ConnectAsr } from "./tencent-client.ts";
import { cloudError, normalizeResult } from "./protocol.ts";
import type { AsrEvent, TencentFrame } from "./protocol.ts";

type Phase = "connecting" | "authenticating" | "listening" | "ending" | "closed";
const BACKLOG_LIMIT = 64 * 1024;

export function bridgeSession(browser: WebSocket, connect: ConnectAsr, detector?: TurnDetector, activated = false): void {
  const turns = detector ? createTurnSession(detector, event => send(event), activated) : undefined;
  let phase: Phase = "connecting";
  let provider: WebSocket | undefined;
  let deadline: ReturnType<typeof setTimeout>;
  const lifetime = setTimeout(() => fail("实时识别已达到两小时时限"), 7200000);

  function dispose(): void {
    if (phase === "closed") return;
    phase = "closed";
    clearTimeout(deadline);
    clearTimeout(lifetime);
    turns?.close();
    provider?.terminate();
    if (browser.readyState === WebSocket.OPEN) browser.close();
  }
  function send(event: AsrEvent | TurnEvent): void {
    if (browser.readyState !== WebSocket.OPEN) return;
    if (browser.bufferedAmount > BACKLOG_LIMIT) {
      dispose();
      return;
    }
    browser.send(JSON.stringify(event));
  }
  function fail(message: string): void {
    send({ type: "error", error: message });
    dispose();
  }
  function arm(ms: number, message: string): void {
    clearTimeout(deadline);
    deadline = setTimeout(() => fail(message), ms);
  }
  function upload(data: RawData, binary: boolean): void {
    if (phase === "closed") return;
    try {
      if (phase !== "listening") {
        fail("识别尚未就绪或已结束，请重新录音");
        return;
      }
      if (binary) {
        const audio = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
        if (!audio.length || audio.length > 1280 || audio.length % 2) {
          fail("音频包必须为不超过 40ms 的 16kHz 单声道 PCM16");
          return;
        }
        if (!provider || provider.bufferedAmount > BACKLOG_LIMIT) {
          fail("音频发送积压，请检查网络");
          return;
        }
        turns?.audio(audio);
        provider.send(audio);
        arm(20000, "长时间未收到音频，识别已停止");
      } else {
        const control = JSON.parse(data.toString());
        if (turns?.control(control)) return;
        if (control.type !== "end" || Object.keys(control).length !== 1) {
          fail("未知识别控制消息");
          return;
        }
        phase = "ending";
        provider?.send(JSON.stringify({ type: "end" }));
        arm(15000, "等待最终识别结果超时");
      }
    } catch {
      fail("识别请求格式错误");
    }
  }
  function receive(data: RawData): void {
    if (phase === "closed") return;
    try {
      const frame = JSON.parse(data.toString()) as TencentFrame;
      if (frame.code !== 0) {
        fail(cloudError(frame.code));
        return;
      }
      if (phase === "authenticating") {
        phase = "listening";
        send({ type: "ready" });
        arm(20000, "长时间未收到音频，识别已停止");
        return;
      }
      const result = normalizeResult(frame);
      if (result) {
        send(result);
        if (result.type === 'result') turns?.result(result.index, result.text, result.final, result.speaker_segments);
      }
      if (frame.final === 1) {
        send({ type: "done" });
        dispose();
      }
    } catch {
      fail("腾讯云 ASR 返回格式异常");
    }
  }

  browser.on("message", upload);
  browser.once("close", dispose);
  browser.on("error", dispose);
  try {
    const connection = connect();
    provider = connection.socket;
    provider.once("open", () => {
      if (phase === "closed") return;
      phase = "authenticating";
      provider?.send(JSON.stringify(connection.start));
      arm(10000, "腾讯云 ASR 鉴权超时");
    });
    provider.on("message", receive);
    provider.on("error", () => {
      if (phase !== "closed") fail("无法连接腾讯云 ASR，请检查网络与服务配置");
    });
    provider.once("close", () => {
      if (phase !== "closed") fail("腾讯云 ASR 未返回最终结果即断开");
    });
    arm(10000, "腾讯云 ASR 连接超时");
  } catch (error) {
    // Connector only throws local credential-validation errors before creating a socket.
    fail(error instanceof Error ? error.message : "实时识别配置无效");
  }
}
