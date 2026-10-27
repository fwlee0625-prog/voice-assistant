import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { inflateSync } from "node:zlib";
import { createHmac } from "node:crypto";
import WebSocket from "ws";
import { createUserSig } from "../src/asr/signature.ts";
import { tencentConnector } from "../src/asr/tencent-client.ts";
import { client, fakeCloud, testServer } from "./helpers.ts";

test("UserSig binds identifier, numeric AppID and lifetime, compatible with TLS v2", () => {
  const encoded = createUserSig("1400000001", "test-key", "stream-one", 1700000000);
  const signature = JSON.parse(
    inflateSync(
      Buffer.from(encoded.replaceAll("*", "+").replaceAll("-", "/").replaceAll("_", "="), "base64"),
    ).toString(),
  );
  assert.equal(signature["TLS.ver"], "2.0");
  assert.equal(signature["TLS.identifier"], "stream-one");
  assert.equal(signature["TLS.sdkappid"], 1400000001);
  assert.equal(signature["TLS.expire"], 86400);
  const input =
    "TLS.identifier:stream-one\nTLS.sdkappid:1400000001\nTLS.time:1700000000\nTLS.expire:86400\n";
  assert.equal(
    signature["TLS.sig"],
    createHmac("sha256", "test-key").update(input).digest("base64"),
  );
});

test("credential errors are explicit and do not establish a cloud connection", () => {
  assert.throws(tencentConnector({ appId: "", secretKey: "" }), /server\/.env/);
  assert.throws(tencentConnector({ appId: "CAM-id", secretKey: "test" }), /不能填写 CAM/);
});

test(
  "PCM bytes, interim text, multiple speakers and final result preserve frontend protocol",
  { timeout: 5000 },
  async (t) => {
    const audio: Buffer[] = [];
    const connectAsr = await fakeCloud(t, (cloud) => {
      cloud.on("message", (data, binary) => {
        if (binary) {
          audio.push(Buffer.from(data as Buffer));
          return;
        }
        const frame = JSON.parse(data.toString());
        if (frame.type === "start") cloud.send(JSON.stringify({ code: 0 }));
        if (frame.type === "end") {
          cloud.send(
            JSON.stringify({
              code: 0,
              result: { index: 0, slice_type: 1, voice_text_str: "你好" },
            }),
          );
          cloud.send(
            JSON.stringify({
              code: 0,
              result: {
                index: 0,
                slice_type: 2,
                voice_text_str: "你好。我来。",
                speaker_segments: [
                  { speaker_id: 1, text: "你好。", stable_flag: 1 },
                  { speaker_id: 2, text: "我来。", stable_flag: 1 },
                ],
              },
            }),
          );
          cloud.send(JSON.stringify({ code: 0, final: 1 }));
        }
      });
    });
    const { wsUrl } = await testServer(t, { connectAsr });
    const { socket, next } = client(wsUrl);
    assert.deepEqual(await next(), { type: "ready" });
    socket.send(Buffer.alloc(1280, 42));
    socket.send(JSON.stringify({ type: "end" }));
    assert.deepEqual(await next(), {
      type: "result",
      index: 0,
      text: "你好",
      final: false,
      speaker_segments: [],
    });
    const result = await next();
    assert.equal(result.final, true);
    assert.deepEqual(
      result.speaker_segments.map((p: { speaker_id: number }) => p.speaker_id),
      [1, 2],
    );
    assert.deepEqual(await next(), { type: "done" });
    assert.deepEqual(audio, [Buffer.alloc(1280, 42)]);
  },
);

test(
  "auth failure emits only a safe error, never a ready or raw provider message",
  { timeout: 5000 },
  async (t) => {
    const connectAsr = await fakeCloud(t, (cloud) => {
      cloud.once("message", () =>
        cloud.send(JSON.stringify({ code: 4002, message: "must-not-expose-this-secret" })),
      );
    });
    const { wsUrl } = await testServer(t, { connectAsr });
    const { next } = client(wsUrl);
    const error = await next();
    assert.equal(error.type, "error");
    assert.match(error.error, /4002/);
    assert.doesNotMatch(JSON.stringify(error), /must-not-expose/);
  },
);

test(
  "unknown Origin is rejected before opening a provider connection",
  { timeout: 5000 },
  async (t) => {
    let connected = false;
    const { wsUrl } = await testServer(t, {
      connectAsr: () => {
        connected = true;
        throw new Error("should not execute");
      },
    });
    const socket = new WebSocket(wsUrl, { origin: "https://example.com" });
    const [error] = await once(socket, "error");
    assert.match(String(error), /403/);
    assert.equal(connected, false);
  },
);

test(
  "invalid PCM terminates the upstream; browser disconnect also releases it",
  { timeout: 5000 },
  async (t) => {
    let disconnects = 0;
    const connectAsr = await fakeCloud(t, (cloud) => {
      cloud.once("message", () => cloud.send(JSON.stringify({ code: 0 })));
      cloud.once("close", () => disconnects++);
    });
    const { wsUrl } = await testServer(t, { connectAsr });
    const first = client(wsUrl);
    await first.next();
    first.socket.send(Buffer.from([1]));
    assert.match((await first.next()).error, /PCM16/);
    const second = client(wsUrl);
    await second.next();
    const closed = once(second.socket, "close");
    second.socket.close();
    await closed;
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(disconnects, 2);
  },
);

test(
  "unexpected provider close preserves an explicit failure instead of success",
  { timeout: 5000 },
  async (t) => {
    const connectAsr = await fakeCloud(t, (cloud) =>
      cloud.once("message", () => {
        cloud.send(JSON.stringify({ code: 0 }));
        cloud.close();
      }),
    );
    const { wsUrl } = await testServer(t, { connectAsr });
    const { next } = client(wsUrl);
    assert.equal((await next()).type, "ready");
    assert.match((await next()).error, /未返回最终结果/);
  },
);
