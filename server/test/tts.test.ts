import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createVoiceServer } from '../src/server.ts';
import { readConfig } from '../src/config.ts';
import { defaults } from '../src/settings/store.ts';
import { readSse } from '../src/http/sse.ts';

const audio = (data = 'AQACAAMA') => ({ choices: [{ delta: { audio: { data } } }] });
const stop = { choices: [{ delta: {}, finish_reason: 'stop' }] };
const sse = (...events: unknown[]) => new Response(events.map(e => 'data: ' + JSON.stringify(e) + '\n\n').join(''), { headers: { 'Content-Type': 'text/event-stream' } });
async function setup(t: TestContext, key = 'fake-tts') {
  const instance = createVoiceServer(readConfig({}), {
    settings: { read: async () => ({ ...defaults, tts: { enabled: false, provider: 'xiaomi', voice: '茉莉' } }), write: async () => defaults },
    credentials: { get: () => '', set: async () => {} },
    ttsCredentials: { get: () => key, set: async () => {} },
  });
  instance.server.listen(0, '127.0.0.1'); await once(instance.server, 'listening');
  t.after(async () => { instance.closeAsr(); instance.server.closeAllConnections(); await new Promise<void>(resolve => instance.server.close(() => resolve())); });
  const url = `http://127.0.0.1:${(instance.server.address() as { port: number }).port}/api/tts`;
  return (body: unknown, signal?: AbortSignal) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
}
test('pure TTS returns WAV or SSE without LLM and honors default/explicit voices', async t => {
  const post = await setup(t); const nativeFetch = globalThis.fetch; const voices: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    if (url !== 'https://api.xiaomimimo.com/v1/chat/completions') return nativeFetch(url, init);
    const body = JSON.parse(init!.body as string);
    assert.deepEqual(body.messages, [{ role: 'assistant', content: '你好。' }]);
    voices.push(body.audio.voice); return sse(audio(), audio('BAA='), stop);
  });
  const full = await post({ text: ' 你好。 ' });
  assert.equal(full.status, 200); assert.match(full.headers.get('content-type')!, /audio\/wav/);
  const wav = Buffer.from(await full.arrayBuffer());
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF'); assert.equal(wav.readUInt32LE(4), wav.length - 8);
  assert.equal(wav.toString('ascii', 8, 16), 'WAVEfmt ');
  assert.equal(wav.readUInt16LE(22), 1); assert.equal(wav.readUInt32LE(24), 24000);
  assert.equal(wav.readUInt16LE(34), 16); assert.equal(wav.readUInt32LE(40), 8);
  assert.deepEqual(wav.subarray(44), Buffer.from([1, 0, 2, 0, 3, 0, 4, 0]));
  const stream = await post({ text: '你好。', stream: true, voice: '冰糖' });
  assert.match(stream.headers.get('content-type')!, /text\/event-stream/);
  const events = []; for await (const data of readSse(stream)) events.push(JSON.parse(data));
  assert.deepEqual(events, [
    { type: 'audio', data: 'AQACAAMA', sampleRate: 24000, channels: 1, format: 'pcm16' },
    { type: 'audio', data: 'BAA=', sampleRate: 24000, channels: 1, format: 'pcm16' }, { type: 'done' },
  ]);
  assert.deepEqual(voices, ['茉莉', '冰糖']);
});
test('invalid TTS input and missing credentials are rejected', async t => {
  const post = await setup(t, '');
  for (const body of [null, {}, { text: '' }, { text: ' ' }, { text: 12 }, { text: 'a'.repeat(16001) }, { text: 'hi', stream: 'true' }, { text: 'hi', voice: 'unknown' }])
    assert.equal((await post(body)).status, 400);
  assert.equal((await post({ text: 'hi', stream: true })).status, 503);
});
test('provider errors are safe JSON before audio and terminal SSE errors after audio', async t => {
  const post = await setup(t); const nativeFetch = globalThis.fetch; let mode = 'auth';
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    if (url !== 'https://api.xiaomimimo.com/v1/chat/completions') return nativeFetch(url, init);
    if (mode === 'auth') return new Response('secret-key-body', { status: 401 });
    if (mode === 'odd') return sse(audio('AQ=='), stop);
    return sse(audio());
  });
  for (const stream of [false, true]) {
    const response = await post({ text: 'hi', stream });
    assert.equal(response.status, 502); assert.ok(!(await response.text()).includes('secret-key-body'));
  }
  mode = 'truncated'; assert.equal((await post({ text: 'hi' })).status, 502);
  const response = await post({ text: 'hi', stream: true });
  const events = []; for await (const data of readSse(response)) events.push(JSON.parse(data));
  assert.deepEqual(events.map(e => e.type), ['audio', 'error']);
  mode = 'odd'; assert.equal((await post({ text: 'hi' })).status, 502);
});
test('audio arrives before synthesis ends and disconnect cancels upstream', async t => {
  const post = await setup(t); const nativeFetch = globalThis.fetch;
  let upstreamSignal: AbortSignal | undefined; let cancelled!: () => void;
  const aborted = new Promise<void>(resolve => { cancelled = resolve; });
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    if (url !== 'https://api.xiaomimimo.com/v1/chat/completions') return nativeFetch(url, init);
    upstreamSignal = init!.signal as AbortSignal;
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('data: ' + JSON.stringify(audio()) + '\n\n'));
      upstreamSignal!.addEventListener('abort', () => { controller.error(new Error('abort')); cancelled(); }, { once: true });
    } }), { headers: { 'Content-Type': 'text/event-stream' } });
  });
  const controller = new AbortController();
  const response = await post({ text: 'hi', stream: true }, controller.signal);
  const reader = response.body!.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /"type":"audio"/);
  assert.equal(upstreamSignal?.aborted, false); controller.abort(); await aborted;
  assert.equal(upstreamSignal?.aborted, true); await reader.cancel().catch(() => {});
});
