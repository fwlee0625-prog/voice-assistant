import test from 'node:test';
import assert from 'node:assert/strict';
import { explicitEnd } from '../src/chat/control.ts';
import { streamChat } from '../src/chat/client.ts';
import { defaults } from '../src/settings/store.ts';
import { createAudienceGate } from '../src/turns/audience.ts';
const messages = [{ role: 'user' as const, content: '先这样吧，今天不需要你了' }];
const sse = (chunks: unknown[]) => new Response(chunks.map(chunk => 'data: ' + JSON.stringify({ choices: [chunk] }) + '\n\n').join(''), { headers: { 'Content-Type': 'text/event-stream' } });
test('explicit end only matches whole commands, not negations, questions or table operations', () => {
  for (const text of ['退出', '请结束对话吧。', '再见', '你可以退下了']) assert.equal(explicitEnd(text), 'end_conversation', text);
  for (const text of ['关闭麦克风', '请不要再监听了']) assert.equal(explicitEnd(text), 'disable_listening', text);
  for (const text of ['不要退出', '怎么退出', '结束计时', '帮我关台', '他说退出', '退出是什么意思']) assert.equal(explicitEnd(text), undefined, text);
});
test('only stable owner or explicitly addressed speaker can end the session; final revision remains actionable', () => {
  const gate = createAudienceGate(Date.now, true);
  const part = (speaker_id: number, text: string, stable_flag = 1) => [{ speaker_id, text, stable_flag }];
  gate.decide(0, part(1, '你好'));
  assert.equal(gate.decide(1, part(2, '退出'))[0]?.action, 'ignore');
  assert.equal(gate.decide(2, part(1, '退出', 0))[0]?.action, 'wait');
  assert.equal(gate.decide(3, part(1, '退出'))[0]?.action, 'end_conversation');
  assert.equal(gate.decide(3, part(1, '退出'))[0]?.action, 'end_conversation');
  assert.equal(gate.decide(4, part(1, '停止监听'))[0]?.action, 'disable_listening');
});
test('fragmented model tool is validated and dispatched once, without a second model call', async t => {
  let requests = 0; const actions: string[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    requests++; const body = JSON.parse(init.body as string);
    assert.equal(body.tools.length, 3); assert.equal(body.tool_choice, 'auto');
    return sse([
      { delta: { tool_calls: [{ index: 0, function: { name: 'end_', arguments: '{' } }] } },
      { delta: { tool_calls: [{ index: 0, function: { name: 'conversation', arguments: '}' } }] } },
      { delta: {}, finish_reason: 'tool_calls' },
    ]);
  });
  const text = [];
  for await (const delta of streamChat(defaults, 'fake', messages, new AbortController().signal, async action => { actions.push(action); })) text.push(delta);
  assert.deepEqual(actions, ['end_conversation']); assert.deepEqual(text, []); assert.equal(requests, 1);
});
test('unknown, malformed, truncated and multiple tool calls never execute', async t => {
  for (const [name, args, finish, index] of [
    ['delete_everything', '{}', 'tool_calls', 0], ['end_conversation', '{', 'tool_calls', 0],
    ['end_conversation', '{"extra":true}', 'tool_calls', 0], ['end_conversation', '{}', undefined, 0],
    ['end_conversation', '{}', 'stop', 0], ['end_conversation', '{}', 'tool_calls', 1],
  ] as const) {
    t.mock.method(globalThis, 'fetch', async () => sse([{ delta: { tool_calls: [{ index, function: { name, arguments: args } }] }, finish_reason: finish }]));
    let called = false;
    await assert.rejects(async () => { for await (const _ of streamChat(defaults, 'fake', messages, new AbortController().signal, async () => { called = true; })) { /* consume */ } });
    assert.equal(called, false); t.mock.restoreAll();
  }
});
test('HTTP control opt-in emits normalized control and done, with no model text', async t => {
  const { once } = await import('node:events');
  const { createVoiceServer } = await import('../src/server.ts');
  const { readConfig } = await import('../src/config.ts');
  const { readSse } = await import('../src/http/sse.ts');
  const nativeFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    if (url !== defaults.baseUrl + '/chat/completions') return nativeFetch(url, init);
    assert.equal(JSON.parse(init!.body as string).tools.length, 3);
    return sse([{ delta: { tool_calls: [{ index: 0, function: { name: 'pause_reply', arguments: '{}' } }] }, finish_reason: 'tool_calls' }]);
  });
  const { server, closeAsr } = createVoiceServer(readConfig({}), {
    settings: { read: async () => ({ ...defaults, tts: { enabled: false, provider: 'xiaomi', voice: '冰糖' } }), write: async () => defaults },
    credentials: { get: () => 'fake', set: async () => {} },
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { closeAsr(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/chat/completions`;
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ stream: true, sessionControl: true, messages }) });
  const events = []; for await (const value of readSse(response)) events.push(JSON.parse(value));
  assert.deepEqual(events, [{ type: 'speech', enabled: false }, { type: 'control', action: 'pause_reply' }, { type: 'done' }]);
});
