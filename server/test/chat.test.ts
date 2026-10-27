import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { completeChat, validateMessages } from '../src/chat/client.ts';
import { createSettingsStore, defaults } from '../src/settings/store.ts';
import { createLlmCredentials, readConfig } from '../src/config.ts';
import { createVoiceServer } from '../src/server.ts';

test('settings persist, credentials stay out of JSON, invalid updates are rejected', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'voice-settings-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'settings.json');
  const credentials = createLlmCredentials(join(dir, '.env'), '');
  const settings = createSettingsStore(path);
  const { server, closeAsr } = createVoiceServer(readConfig({}), { settings, credentials });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { closeAsr(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/settings`;
  const save = (body: unknown, origin?: string) => fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify(body) });
  assert.equal((await (await fetch(url)).json()).apiKeyConfigured, false);
  const data = await (await save({ ...defaults, model: 'custom', apiKey: 'fake-test-key' })).json();
  assert.equal(data.apiKeyConfigured, true); assert.equal(data.apiKey, undefined);
  assert.equal((await createSettingsStore(path).read()).model, 'custom');
  assert.ok(!(await readFile(path, 'utf8')).includes('fake-test-key'));
  assert.match(await readFile(join(dir, '.env'), 'utf8'), /OPENAI_API_KEY=fake-test-key/);
  assert.equal((await save({ ...defaults, baseUrl: 'file:///tmp' })).status, 400);
  assert.equal((await save(defaults, 'https://untrusted.example')).status, 403);
  assert.equal((await save({ ...defaults, apiKey: 'bad\nkey' })).status, 400);
  assert.equal((await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{' })).status, 400);
  const nativeFetch = globalThis.fetch;
  let providerCalls = 0;
  t.mock.method(globalThis, 'fetch', async (input: string, init?: RequestInit) => {
    if (input === defaults.baseUrl + '/chat/completions') {
      providerCalls++;
      return Response.json({ choices: [{ message: { content: 'route answer' } }] });
    }
    return nativeFetch(input, init);
  });
  const chatUrl = url.replace('/settings', '/chat/completions');
  const answer = await fetch(chatUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] }) });
  assert.equal(answer.status, 200);
  assert.deepEqual(await answer.json(), { text: 'route answer', model: 'custom' });
  const invalid = await fetch(chatUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: [] }) });
  assert.equal(invalid.status, 400); assert.equal(providerCalls, 1);

});
test('interjection list persists and rejects empty, oversized or duplicated entries', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'voice-fillers-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'settings.json');
  const credentials = createLlmCredentials(join(dir, '.env'), '');
  const settings = createSettingsStore(path);
  const { server, closeAsr } = createVoiceServer(readConfig({}), { settings, credentials });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { closeAsr(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/settings`;
  const save = (tts: unknown) => fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...defaults, tts }) });
  const tts = { enabled: true, provider: 'xiaomi', voice: '冰糖', filler: true, fillers: ['稍等一下……', '好的……'] };
  const saved = await (await save(tts)).json();
  assert.deepEqual(saved.tts.fillers, ['稍等一下……', '好的……']);
  assert.deepEqual((await (await fetch(url)).json()).tts.fillers, ['稍等一下……', '好的……']);
  assert.deepEqual((await createSettingsStore(path).read()).tts?.fillers, ['稍等一下……', '好的……']);
  assert.equal((await save({ ...tts, fillers: [] })).status, 200);
  assert.deepEqual((await (await fetch(url)).json()).tts.fillers, []);
  assert.equal((await save({ ...tts, fillers: ['   '] })).status, 400);
  assert.equal((await save({ ...tts, fillers: ['好'.repeat(21)] })).status, 400);
  assert.equal((await save({ ...tts, fillers: Array.from({ length: 21 }, (_, i) => `词${i}`) })).status, 400);
});
test('OpenAI adapter sends configured model, system prompt and ordered context', async t => {
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.equal(url, defaults.baseUrl + '/chat/completions');
    assert.equal((init.headers as Record<string, string>).Authorization, 'Bearer fake-key');
    const body = JSON.parse(init.body as string);
    assert.equal(body.model, defaults.model);
    assert.deepEqual(body.messages.map((m: { role: string }) => m.role), ['system', 'user', 'assistant', 'user']);
    return Response.json({ choices: [{ message: { content: '你好！' } }] });
  });
  const result = await completeChat(defaults, 'fake-key', [{ role: 'user', content: '你好' }, { role: 'assistant', content: '你好' }, { role: 'user', content: '继续' }], new AbortController().signal);
  assert.equal(result.text, '你好！');
});
test('invalid messages, missing credentials and upstream failures return safe errors', async t => {
  assert.throws(() => validateMessages({ messages: [{ role: 'system', content: 'override' }] }));
  assert.throws(() => validateMessages({ messages: [] }));
  const messages = [{ role: 'user' as const, content: 'hello' }];
  await assert.rejects(completeChat(defaults, '', messages, new AbortController().signal), /API Key/);
  const mock = t.mock.method(globalThis, 'fetch', async () => new Response('secret-upstream-body', { status: 401 }));
  await assert.rejects(completeChat(defaults, 'fake', messages, new AbortController().signal), /鉴权失败/);
  mock.mock.mockImplementation(async () => Response.json({ choices: [] }));
  await assert.rejects(completeChat(defaults, 'fake', messages, new AbortController().signal), /未返回文本/);
  mock.mock.mockImplementation(async () => { throw new Error('secret-network-error'); });
  await assert.rejects(completeChat(defaults, 'fake', messages, new AbortController().signal), /连接失败或超时/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(completeChat(defaults, 'fake', messages, controller.signal), /取消/);
});

test('separate LLM/TTS credentials update the same env without overwriting each other', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'voice-keys-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, '.env');
  const llm = createLlmCredentials(path, '');
  const tts = createLlmCredentials(path, '', 'MIMO_API_KEY');
  await Promise.all([llm.set('fake-llm'), tts.set('fake-tts')]);
  const content = await readFile(path, 'utf8');
  assert.match(content, /OPENAI_API_KEY=fake-llm/);
  assert.match(content, /MIMO_API_KEY=fake-tts/);
  assert.equal(llm.get(), 'fake-llm'); assert.equal(tts.get(), 'fake-tts');
});
