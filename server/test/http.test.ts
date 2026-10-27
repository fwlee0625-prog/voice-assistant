import test from "node:test";
import assert from "node:assert/strict";
import { HttpError } from "../src/http/errors.ts";
import { testServer } from "./helpers.ts";

function audioForm(bytes: Uint8Array = new Uint8Array([82, 73, 70, 70, 0, 1, 13, 10])) {
  const form = new FormData();
  form.append("audio", new Blob([bytes as Uint8Array<ArrayBuffer>]), "input.webm");
  return form;
}

test("health identifies Express, missing audio and unknown routes return JSON errors", async (t) => {
  const { base } = await testServer(t);
  assert.equal((await (await fetch(base + "/api/health")).json()).backend, "express");
  assert.equal((await fetch(base + "/api/voice/enhance", { method: "POST" })).status, 400);
  const missing = await fetch(base + "/api/voice/unknown");
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).status, "error");
});

test("multipart audio including trailing CRLF is unchanged; WAV headers match page contract", async (t) => {
  const source = new Uint8Array([82, 73, 70, 70, 0, 1, 13, 10]);
  const wav = Buffer.from("RIFF0000WAVEtest");
  const { base } = await testServer(t, {
    enhance: async (audio) => {
      assert.deepEqual(audio, Buffer.from(source));
      return wav;
    },
  });
  const response = await fetch(base + "/api/voice/enhance", {
    method: "POST",
    body: audioForm(source),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "audio/wav");
  assert.equal(response.headers.get("x-sample-rate"), "48000");
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), wav);
});

test("model errors and oversized upload are bounded and never expose stack traces", async (t) => {
  const { base } = await testServer(t, {
    enhance: async () => {
      throw new HttpError(422, "测试模型不可用");
    },
  });
  const response = await fetch(base + "/api/voice/enhance", { method: "POST", body: audioForm() });
  assert.equal(response.status, 422);
  assert.deepEqual(await response.json(), { status: "error", error: "测试模型不可用" });
  const large = await fetch(base + "/api/voice/enhance", {
    method: "POST",
    body: audioForm(new Uint8Array(32 * 1024 * 1024 + 1)),
  });
  assert.equal(large.status, 413);
  assert.match((await large.json()).error, /32MB/);
});

test("client disconnect aborts an in-flight enhancement", { timeout: 5000 }, async (t) => {
  let begin!: () => void;
  let cancelled!: () => void;
  const started = new Promise<void>((resolve) => {
    begin = resolve;
  });
  const aborted = new Promise<void>((resolve) => {
    cancelled = resolve;
  });
  const { base } = await testServer(t, {
    enhance: async (_audio, signal) => {
      begin();
      return new Promise((_resolve, reject) =>
        signal.addEventListener(
          "abort",
          () => {
            cancelled();
            reject(new HttpError(499, "cancelled"));
          },
          { once: true },
        ),
      );
    },
  });
  const controller = new AbortController();
  const request = fetch(base + "/api/voice/enhance", {
    method: "POST",
    body: audioForm(),
    signal: controller.signal,
  }).catch(() => undefined);
  await started;
  controller.abort();
  await aborted;
  await request;
});
