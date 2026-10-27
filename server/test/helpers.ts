import { once } from "node:events";
import type { TurnDetector } from '../src/turns/worker.ts';
import type { TestContext } from "node:test";
import WebSocket, { WebSocketServer } from "ws";
import type { ServerConfig } from "../src/config.ts";
import { readConfig } from "../src/config.ts";
import { createVoiceServer } from "../src/server.ts";
import type { ConnectAsr } from "../src/asr/tencent-client.ts";
import type { EnhanceAudio } from "../src/enhancement/worker.ts";

export function inbox(socket: WebSocket) {
  const queue: unknown[] = [];
  const waiting: ((value: any) => void)[] = [];
  socket.on("message", (data) => {
    const value = JSON.parse(data.toString());
    const resolve = waiting.shift();
    if (resolve) resolve(value);
    else queue.push(value);
  });
  return () =>
    queue.length
      ? Promise.resolve(queue.shift() as any)
      : new Promise<any>((resolve) => waiting.push(resolve));
}

export async function testServer(
  t: TestContext,
  options: { config?: ServerConfig; connectAsr?: ConnectAsr; enhance?: EnhanceAudio; turnDetector?: TurnDetector } = {},
) {
  const config = options.config || readConfig({});
  const instance = createVoiceServer(config, options);
  instance.server.listen(0, "127.0.0.1");
  await once(instance.server, "listening");
  const address = instance.server.address();
  if (!address || typeof address === "string") throw new Error("Invalid test address");
  t.after(async () => {
    instance.closeAsr();
    await new Promise<void>((resolve) => instance.server.close(() => resolve()));
  });
  const base = `http://127.0.0.1:${address.port}`;
  return { base, wsUrl: base.replace("http:", "ws:") + "/api/voice/asr/realtime" };
}

export async function fakeCloud(
  t: TestContext,
  onConnect: (socket: WebSocket) => void,
): Promise<ConnectAsr> {
  const cloud = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  cloud.on("connection", onConnect);
  await once(cloud, "listening");
  t.after(async () => {
    for (const ws of cloud.clients) ws.terminate();
    await new Promise<void>((resolve) => cloud.close(() => resolve()));
  });
  const address = cloud.address();
  if (!address || typeof address === "string") throw new Error("Invalid test address");
  return () => ({
    socket: new WebSocket(`ws://127.0.0.1:${address.port}`),
    start: { type: "start", auth: { sdkappid: "test-app", usersig: "test-signature" }, params: {} },
  });
}

export function client(url: string) {
  const socket = new WebSocket(url, { origin: "http://localhost:5178" });
  const next = inbox(socket);
  return { socket, next };
}
