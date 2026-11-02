import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createApp } from '../src/app.ts';
import { createSettingsStore, defaults } from '../src/settings/store.ts';
import { wakeTokensPath } from '../src/config.ts';
import { generateWakePhonemes, parsePronunciations, validateWakeText, expandToneVariants } from '../src/wake/phonemes.ts';

const standard = 'n ǐ h ǎo x iǎo m ěi';
const sandhi = 'n í h ǎo x iáo m ěi';
const vocabulary = new Set((await readFile(wakeTokensPath, 'utf8')).trim().split(/\r?\n/).map(line => line.split(/\s+/)[0]!));
const expectedVariants = expandToneVariants([standard, sandhi], vocabulary).slice(1);

test('tone tolerance covers single wrong tones and uniform tones, bounded without changing syllables', () => {
  const variants = expandToneVariants([standard, sandhi, 'm ǐ h ǎo x iǎo m ěi'], vocabulary);
  assert.equal(variants[0], standard);
  assert.ok(variants.includes('n ì h ǎo x iǎo m ěi'));
  assert.ok(variants.includes('n ǐ h ǎo x iǎo m èi'));
  assert.ok(variants.includes('n ī h āo x iāo m ēi'));
  assert.ok(!variants.includes('m ǐ h ǎo x iǎo m ěi'));
  assert.ok(variants.every(value => value.startsWith('n ')), 'consonant n must never become syllabic ń');
  assert.ok(variants.length <= 96);
  assert.equal(new Set(variants).size, variants.length);
  for (const variant of variants) for (const token of variant.split(' ')) assert.ok(vocabulary.has(token));
});

test('phoneme output rejects invalid JSON, empty/unsupported/too many pronunciations and deduplicates', () => {
  for (const output of ['oops', 'null', '{}', '{"pronunciations":[]}', '{"pronunciations":["nǐ hǎo"]}', '{"pronunciations":[""]}', JSON.stringify({ pronunciations: Array(7).fill(standard) })]) {
    assert.throws(() => parsePronunciations(output, vocabulary), /有效发音/);
  }
  assert.deepEqual(parsePronunciations(JSON.stringify({ pronunciations: [standard, sandhi, standard] }), vocabulary), [standard, sandhi]);
  for (const text of ['', 'a', '你'.repeat(21), null]) assert.throws(() => validateWakeText(text));
  assert.equal(validateWakeText(' 你好小美 '), '你好小美');
});

test('generation uses existing model credentials with its own conversion prompt, no dialogue persona or TTS', async t => {
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(url, defaults.baseUrl + '/chat/completions');
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer fake');
    const body = JSON.parse(init?.body as string);
    assert.equal(body.model, defaults.model); assert.equal(body.stream, false);
    assert.equal(body.messages[1].content, '你好小美');
    assert.match(body.messages[0].content, /常见自然变调/);
    assert.ok(!body.messages[0].content.includes('secret-persona'));
    return Response.json({ choices: [{ message: { content: JSON.stringify({ pronunciations: [standard, sandhi] }) } }] });
  });
  assert.deepEqual(await generateWakePhonemes('你好小美', { ...defaults, systemPrompt: 'secret-persona' }, 'fake', new AbortController().signal), { text: '你好小美', phonemes: standard, variants: expectedVariants });
});

test('wake HTTP contract validates input/origin, handles upstream errors and missing credentials safely', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'wake-settings-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let key = 'fake'; let mode = 'ok';
  const originalFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).startsWith('http://127.0.0.1:')) return originalFetch(input, init);
    if (mode === 'fail') return new Response('private upstream details', { status: 500 });
    if (mode === 'invalid') return Response.json({ choices: [{ message: { content: 'not JSON' } }] });
    return Response.json({ choices: [{ message: { content: JSON.stringify({ pronunciations: [standard, sandhi] }) } }] });
  });
  const app = createApp(async () => { throw new Error('unused'); }, createSettingsStore(join(dir, 'settings.json')), { get: () => key, set: async () => {} }, new Set(['http://localhost:5178']));
  const server = createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/wake/phonemes`;
  const request = (body: unknown, origin = 'http://localhost:5178') => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body) });
  assert.equal((await request({ text: '你好小美' }, 'https://other.example')).status, 403);
  assert.equal((await request({ text: 'invalid' })).status, 400);
  const result = await request({ text: '你好小美' });
  assert.equal(result.status, 200); assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await result.json(), { text: '你好小美', phonemes: standard, variants: expectedVariants });
  mode = 'fail'; const failure = await request({ text: '你好小美' });
  assert.equal(failure.status, 502); assert.ok(!(await failure.text()).includes('private upstream'));
  mode = 'invalid'; assert.equal((await request({ text: '你好小美' })).status, 502);
  key = ''; assert.equal((await request({ text: '你好小美' })).status, 503);
});

test('aborting generation cancels the upstream request', async t => {
  let cancelled = false;
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => { cancelled = true; reject(new Error('cancelled')); }, { once: true });
      started();
    });
  });
  const controller = new AbortController();
  const pending = generateWakePhonemes('你好小美', defaults, 'fake', controller.signal);
  await ready; controller.abort();
  await assert.rejects(pending, /取消/); assert.equal(cancelled, true);
});
