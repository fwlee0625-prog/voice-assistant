import test from 'node:test';
import assert from 'node:assert/strict';
import { streamChat } from '../src/chat/client.ts';
import { defaults } from '../src/settings/store.ts';
import { readSse } from '../src/http/sse.ts';
import { createXiaomiTts } from '../src/tts/xiaomi.ts';
import { streamSpokenReply, type ReplyEvent } from '../src/chat/speech.ts';
const signal = () => new AbortController().signal;
const fillerOptions = { filler: true, messages: [{ role: 'user' as const, content: '低杆怎么打？' }],
  decideFiller: async (_messages: unknown, fillers: string[]) => fillers[0] };
const sse = (...events: unknown[]) => new Response(events.map(e => 'data: ' + (typeof e === 'string' ? e : JSON.stringify(e)) + '\n\n').join(''), { headers: { 'Content-Type': 'text/event-stream' } });
const chunk = (text: string) => ({ choices: [{ delta: { content: text } }] });
const stop = { choices: [{ delta: {}, finish_reason: 'stop' }] };
const collect = async <T>(items: AsyncIterable<T>) => { const out: T[] = []; for await (const item of items) out.push(item); return out; };
test('SSE reconstructs split UTF-8, CRLF, multiline data and releases the reader', async () => {
  const bytes = new TextEncoder().encode(': heartbeat\r\ndata: 你\r\ndata: 好\r\n\r\n');
  let cancelled = false;
  const body = new ReadableStream({ start(c) { for (const b of bytes) c.enqueue(Uint8Array.of(b)); }, cancel() { cancelled = true; } });
  const iterator = readSse(new Response(body, { headers: { 'content-type': 'text/event-stream' } }));
  assert.equal((await iterator.next()).value, '你\n好');
  await iterator.return(); assert.equal(cancelled, true);
});
test('DeepSeek streams only answer content and rejects truncated/limited output', async t => {
  const mock = t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    assert.equal(JSON.parse(init.body as string).stream, true);
    return sse({ choices: [{ delta: { reasoning_content: 'private' } }] }, chunk('你好'), chunk('！'), stop, '[DONE]');
  });
  const messages = [{ role: 'user' as const, content: 'hello' }];
  assert.deepEqual(await collect(streamChat(defaults, 'fake', messages, signal())), ['你好', '！']);
  mock.mock.mockImplementation(async () => sse(chunk('partial')));
  await assert.rejects(collect(streamChat(defaults, 'fake', messages, signal())), /中断/);
  mock.mock.mockImplementation(async () => sse(chunk('partial'), { choices: [{ finish_reason: 'length' }] }));
  await assert.rejects(collect(streamChat(defaults, 'fake', messages, signal())), /未完整/);
});
test('Xiaomi normalizes audio and sanitizes upstream failures', async t => {
  const mock = t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.equal(url, 'https://api.xiaomimimo.com/v1/chat/completions');
    const body = JSON.parse(init.body as string);
    assert.deepEqual(body.audio, { format: 'pcm16', voice: '冰糖' });
    assert.deepEqual(body.messages, [{ role: 'assistant', content: '你好。' }]);
    return sse({ choices: [{ delta: { audio: { data: 'AAA=' } } }] }, stop, '[DONE]');
  });
  const provider = createXiaomiTts('fake');
  const request = { text: '你好。', voice: '冰糖', signal: signal() };
  assert.deepEqual(await collect(provider.synthesize(request)), [{ data: 'AAA=', sampleRate: 24000, channels: 1, format: 'pcm16' }]);
  mock.mock.mockImplementation(async () => new Response('secret', { status: 401 }));
  await assert.rejects(collect(provider.synthesize(request)), /鉴权/);
  mock.mock.mockImplementation(async () => sse({ choices: [{ delta: { audio: { data: 'AAA=' } } }] }));
  await assert.rejects(collect(provider.synthesize(request)), /失败或超时/);
  await assert.rejects(collect(createXiaomiTts('').synthesize(request)), /配置/);
});
test('bridge speaks first phrase before model finishes and keeps phrase order', async () => {
  let release!: () => void;
  const firstSpoken = new Promise<void>(resolve => { release = resolve; });
  const phrases: string[] = []; const events: ReplyEvent[] = [];
  async function* text() { yield '第一句。'; await firstSpoken; yield '第二句'; }
  await streamSpokenReply(text(), { async *synthesize(req) {
    phrases.push(req.text);
    yield { data: 'AAA=', sampleRate: 24000, channels: 1, format: 'pcm16' };
    release();
  } }, '冰糖', signal(), async e => { events.push(e); });
  assert.deepEqual(phrases, ['第一句。', '第二句']);
  assert.deepEqual(events.filter(e => e.type === 'audio').map(e => e.text), ['第一句。', '第二句']);
  assert.equal(events.at(-1)?.type, 'done');
  assert.ok(events.findIndex(e => e.type === 'audio') < events.findIndex(e => e.type === 'text' && e.delta === '第二句'));
});
test('TTS failure preserves text; model failure cancels active synthesis', async () => {
  const events: ReplyEvent[] = [];
  async function* text() { yield '第一句。'; yield '第二句。'; }
  await streamSpokenReply(text(), { async *synthesize() { throw new Error('secret-body'); } }, '冰糖', signal(), async e => { events.push(e); });
  assert.equal(events.filter(e => e.type === 'text').length, 2);
  assert.equal(events.filter(e => e.type === 'speech_error').length, 1);
  assert.equal(events.at(-1)?.type, 'done');
  assert.ok(!JSON.stringify(events).includes('secret-body'));
  let speechSignal: AbortSignal | undefined;
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  async function* broken() { yield '第一句。'; await ready; throw new Error('model failed'); }
  await assert.rejects(streamSpokenReply(broken(), { async *synthesize(req) {
    speechSignal = req.signal; started();
    await new Promise<void>(resolve => req.signal.addEventListener('abort', () => resolve(), { once: true }));
  } }, '冰糖', signal(), async () => {}), /model failed/);
  assert.equal(speechSignal?.aborted, true);
});

test('HTTP stream returns normalized events and disconnect aborts upstream', async t => {
  const { once } = await import('node:events');
  const { createVoiceServer } = await import('../src/server.ts');
  const { readConfig } = await import('../src/config.ts');
  const nativeFetch = globalThis.fetch;
  let upstreamSignal: AbortSignal | undefined;
  let disconnect = false;
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    if (url !== defaults.baseUrl + '/chat/completions') return nativeFetch(url, init);
    upstreamSignal = init!.signal as AbortSignal;
    if (!disconnect) return sse(chunk('你好。'), stop, '[DONE]');
    return new Response(new ReadableStream({ start(c) {
      c.enqueue(new TextEncoder().encode('data: ' + JSON.stringify(chunk('partial')) + '\n\n'));
      upstreamSignal!.addEventListener('abort', () => c.error(new Error('aborted')), { once: true });
    } }), { headers: { 'content-type': 'text/event-stream' } });
  });
  const { server, closeAsr } = createVoiceServer(readConfig({}), {
    settings: { read: async () => ({ ...defaults, tts: { enabled: false, provider: 'xiaomi', voice: '冰糖' } }), write: async () => defaults },
    credentials: { get: () => 'fake', set: async () => {} },
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { closeAsr(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/chat/completions`;
  const request = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ stream: true, messages: [{ role: 'user', content: 'hello' }] }) };
  const normal = await fetch(url, request);
  assert.equal(normal.headers.get('X-Voice-Trace'), null);
  const normalEvents = (await collect(readSse(normal))).map(s => JSON.parse(s));
  assert.deepEqual(normalEvents.map(event => event.type), ['speech', 'text', 'done']);
  assert.ok(normalEvents.every(event => event.diagnostic === undefined));
  const traced = await fetch(url, { ...request, headers: { ...request.headers, 'X-Voice-Diagnostics': '1' } });
  assert.match(traced.headers.get('X-Voice-Trace')!, /^[a-f0-9-]{36}$/);
  const tracedEvents = (await collect(readSse(traced))).map(s => JSON.parse(s));
  assert.deepEqual(tracedEvents.map(event => event.diagnostic.sequence), tracedEvents.map((_, i) => i));
  assert.deepEqual(tracedEvents.filter(event => event.type === 'timing').map(event => event.stage),
    ['request.ready', 'model.request', 'model.headers', 'model.first_delta', 'model.end']);
  assert.ok(tracedEvents.every((event, i) => event.diagnostic.elapsedMs >= (tracedEvents[i - 1]?.diagnostic.elapsedMs ?? 0)));
  disconnect = true;
  const controller = new AbortController();
  const response = await fetch(url, { ...request, signal: controller.signal });
  const reader = response.body!.getReader();
  while (true) { const item = await reader.read(); if (new TextDecoder().decode(item.value).includes('partial')) break; }
  const aborted = new Promise<void>(resolve => upstreamSignal!.addEventListener('abort', () => resolve(), { once: true }));
  controller.abort(); await reader.cancel().catch(() => {}); await aborted;
  assert.equal(upstreamSignal?.aborted, true);
});

test('HTTP dialogue sends context to decision service and speaks its selected configured filler', async t => {
  const { once } = await import('node:events');
  const { createVoiceServer } = await import('../src/server.ts');
  const { readConfig } = await import('../src/config.ts');
  const nativeFetch = globalThis.fetch;
  let state: unknown;
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    if (url === 'http://127.0.0.1:8030/v1/decisions') {
      state = JSON.parse(init!.body as string).state;
      return Response.json({ usage: { truncated: false }, answers: { group0: {
        choice: 'f0', probabilities: { f0: 0.8, silence: 0.2 },
      } } });
    }
    if (url === defaults.baseUrl + '/chat/completions') {
      return new Response(new ReadableStream({ start(c) {
        setTimeout(() => { c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk('正文。'))}\n\ndata: ${JSON.stringify(stop)}\n\ndata: [DONE]\n\n`)); c.close(); }, 600);
      } }), { headers: { 'Content-type': 'text/event-stream' } });
    }
    if (url === 'https://api.xiaomimimo.com/v1/chat/completions')
      return sse({ choices: [{ delta: { audio: { data: 'AAA=' } } }] }, stop, '[DONE]');
    return nativeFetch(url, init);
  });
  const { server, closeAsr } = createVoiceServer(readConfig({}), {
    settings: { read: async () => ({ ...defaults, tts: { enabled: true, provider: 'xiaomi', voice: '冰糖', filler: true, fillers: ['让我想一想……'] } }), write: async () => defaults },
    credentials: { get: () => 'fake', set: async () => {} },
    ttsCredentials: { get: () => 'fake', set: async () => {} },
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { closeAsr(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/chat/completions`;
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ stream: true, messages: [
    { role: 'user', content: '上一题' }, { role: 'assistant', content: '上一个回答。' }, { role: 'user', content: '低杆怎么打？' },
  ] }) });
  const events = (await collect(readSse(response))).map(s => JSON.parse(s));
  assert.deepEqual(state, { utterance: '低杆怎么打？', recent_conversation: [
    { role: 'user', content: '上一题' }, { role: 'assistant', content: '上一个回答。' },
  ] });
  assert.equal(events.find(e => e.type === 'filler_audio')?.text, '让我想一想……');
  assert.ok(events.findIndex(e => e.type === 'filler_audio') < events.findIndex(e => e.type === 'audio'));
  assert.equal(events.at(-1)?.type, 'done');
});

test('sentence events preserve source offsets, repeated text IDs and final chunk boundaries', async () => {
  const events: ReplyEvent[] = [];
  async function* text() { yield '**你好。**\n'; yield '你好。 结尾'; }
  await streamSpokenReply(text(), { async *synthesize() {
    yield { data: 'AAA=', sampleRate: 24000, channels: 1, format: 'pcm16' };
    yield { data: 'AAA=', sampleRate: 24000, channels: 1, format: 'pcm16' };
  } }, '冰糖', signal(), async event => { events.push(event); });
  assert.deepEqual(events[0], { type: 'speech', enabled: true });
  assert.deepEqual(events.filter(e => e.type === 'audio').map(e => [e.sentenceId, e.text, e.start, e.end]), [
    [0, '你好。', 0, 5], [0, '你好。', 0, 5],
    [1, '你好。', 8, 11], [1, '你好。', 8, 11],
    [2, '结尾', 11, 14], [2, '结尾', 11, 14],
  ]);
  assert.deepEqual(events.filter(e => e.type === 'sentence_end').map(e => e.sentenceId), [0, 1, 2]);
  assert.equal(events.at(-1)?.type, 'done');
});
test('interjection fills the thinking gap and precedes the answer', async () => {
  const phrases: string[] = []; const events: ReplyEvent[] = [];
  async function* text() { await new Promise(resolve => setTimeout(resolve, 600)); yield '第一句。'; }
  await streamSpokenReply(text(), { async *synthesize(req) {
    phrases.push(req.text);
    yield { data: 'AAA=', sampleRate: 24000, channels: 1, format: 'pcm16' };
  } }, '冰糖', signal(), async e => { events.push(e); }, fillerOptions);
  assert.equal(phrases.length, 2);
  assert.notEqual(phrases[0], '第一句。');
  assert.equal(phrases[1], '第一句。');
  const fillers = events.filter(e => e.type === 'filler_audio');
  assert.equal(fillers.length, 1);
  assert.equal(fillers[0]?.text, phrases[0]);
  assert.ok(events.findIndex(e => e.type === 'filler_audio') < events.findIndex(e => e.type === 'audio'));
});
test('an immediate answer skips the interjection and its synthesis call', async () => {
  const phrases: string[] = []; const events: ReplyEvent[] = [];
  async function* text() { yield '马上回答。'; }
  await streamSpokenReply(text(), { async *synthesize(req) {
    phrases.push(req.text);
    yield { data: 'AAA=', sampleRate: 24000, channels: 1, format: 'pcm16' };
  } }, '冰糖', signal(), async e => { events.push(e); }, fillerOptions);
  assert.deepEqual(phrases, ['马上回答。']);
  assert.equal(events.filter(e => e.type === 'filler_audio').length, 0);
});
test('a failed interjection never breaks the answer', async () => {
  const events: ReplyEvent[] = [];
  async function* text() { await new Promise(resolve => setTimeout(resolve, 600)); yield '第一句。'; }
  await streamSpokenReply(text(), { async *synthesize(req) {
    if (req.text !== '第一句。') throw new Error('interjection failed');
    yield { data: 'AAA=', sampleRate: 24000, channels: 1, format: 'pcm16' };
  } }, '冰糖', signal(), async e => { events.push(e); }, fillerOptions);
  assert.equal(events.filter(e => e.type === 'filler_audio').length, 0);
  assert.equal(events.filter(e => e.type === 'audio').length, 1);
  assert.equal(events.filter(e => e.type === 'speech_error').length, 0);
  assert.equal(events.at(-1)?.type, 'done');
});
test('the configured interjection list replaces the built-in words', async () => {
  const phrases: string[] = []; const events: ReplyEvent[] = [];
  async function* text() { await new Promise(resolve => setTimeout(resolve, 600)); yield '第一句。'; }
  await streamSpokenReply(text(), { async *synthesize(req) {
    phrases.push(req.text);
    yield { data: 'AAA=', sampleRate: 24000, channels: 1, format: 'pcm16' };
  } }, '冰糖', signal(), async e => { events.push(e); }, { ...fillerOptions, fillers: ['稍等一下……'] });
  assert.deepEqual(phrases, ['稍等一下……', '第一句。']);
  assert.equal(events.filter(e => e.type === 'filler_audio')[0]?.text, '稍等一下……');
});
test('an empty interjection list keeps the assistant silent while thinking', async () => {
  const phrases: string[] = []; const events: ReplyEvent[] = [];
  async function* text() { await new Promise(resolve => setTimeout(resolve, 600)); yield '第一句。'; }
  await streamSpokenReply(text(), { async *synthesize(req) {
    phrases.push(req.text);
    yield { data: 'AAA=', sampleRate: 24000, channels: 1, format: 'pcm16' };
  } }, '冰糖', signal(), async e => { events.push(e); }, { filler: true, fillers: [] });
  assert.deepEqual(phrases, ['第一句。']);
  assert.equal(events.filter(e => e.type === 'filler_audio').length, 0);
  assert.equal(events.filter(e => e.type === 'audio').length, 1);
});

test('a silent or failed decision does not invent a filler', async () => {
  for (const decideFiller of [async () => undefined, async () => { throw new Error('offline'); }]) {
    const phrases: string[] = [];
    async function* text() { await new Promise(resolve => setTimeout(resolve, 350)); yield '正文。'; }
    await streamSpokenReply(text(), { async *synthesize(req) {
      phrases.push(req.text); yield { data: 'AAA=', sampleRate: 24000, channels: 1, format: 'pcm16' };
    } }, '冰糖', signal(), async () => {}, { ...fillerOptions, decideFiller });
    assert.deepEqual(phrases, ['正文。']);
  }
});

test('an answer arriving during filler synthesis cancels it without delaying speech', async () => {
  let started!: () => void; let release!: () => void; let fillerSignal: AbortSignal | undefined;
  const fillerStarted = new Promise<void>(resolve => { started = resolve; });
  const fillerRelease = new Promise<void>(resolve => { release = resolve; });
  const events: ReplyEvent[] = [];
  async function* text() { await fillerStarted; yield '正文。'; }
  const task = streamSpokenReply(text(), { async *synthesize(req) {
    if (req.text !== '正文。') { fillerSignal = req.signal; started(); await fillerRelease; }
    yield { data: 'AAA=', sampleRate: 24000, channels: 1, format: 'pcm16' };
  } }, '冰糖', signal(), async event => { events.push(event); }, fillerOptions);
  try {
    await Promise.race([task, new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('正文被衔接词阻塞')), 1200))]);
    assert.equal(fillerSignal?.aborted, true);
    assert.equal(events.some(event => event.type === 'filler_audio'), false);
    assert.equal(events.some(event => event.type === 'audio' && event.text === '正文。'), true);
  } finally { release(); }
});


test('timing stages cover each TTS phrase and stop on synthesis failure', async () => {
  const stages: string[] = [];
  async function* text() { yield '第一句。第二句。'; }
  await streamSpokenReply(text(), { async *synthesize() {
    yield { data: 'AAA=', sampleRate: 24000, channels: 1, format: 'pcm16' };
  } }, '冰糖', signal(), async () => {}, { onStage: async (stage, id) => { stages.push(`${stage}:${id}`); } });
  assert.deepEqual(stages, ['tts.request:0', 'tts.first_audio:0', 'tts.end:0', 'tts.request:1', 'tts.first_audio:1', 'tts.end:1']);
  stages.length = 0;
  await streamSpokenReply(text(), { async *synthesize() { throw new Error('failed'); } }, '冰糖', signal(), async () => {},
    { onStage: async (stage, id) => { stages.push(`${stage}:${id}`); } });
  assert.deepEqual(stages, ['tts.request:0']);
});

test('model timing reports first content once and never marks a truncated stream complete', async t => {
  t.mock.method(globalThis, 'fetch', async () => sse(chunk('partial'), chunk('two')));
  const stages: string[] = [];
  await assert.rejects(collect(streamChat(defaults, 'fake', [{ role: 'user', content: 'hello' }], signal(), undefined,
    async stage => { stages.push(stage); })), /中断/);
  assert.deepEqual(stages, ['model.request', 'model.headers', 'model.first_delta']);
});
