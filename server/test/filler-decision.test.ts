import test from 'node:test';
import assert from 'node:assert/strict';
import { createFillerDecision } from '../src/chat/filler-decision.ts';
import { readConfig } from '../src/config.ts';

const messages = [{ role: 'user' as const, content: '上次说的低杆呢？' }];
const signal = () => new AbortController().signal;

test('sends recent dialogue and all configured phrases, selecting a group winner', async () => {
  const fillers = Array.from({ length: 20 }, (_, i) => `自定义${i}`);
  const decide = createFillerDecision(readConfig({}).decision, (async (_url, init) => {
    const body = JSON.parse(init!.body as string);
    assert.equal(body.state.utterance, '上次说的低杆呢？');
    assert.deepEqual(body.state.recent_conversation, [{ role: 'assistant', content: '之前讲过高杆。' }]);
    assert.deepEqual(Object.keys(body.questions), ['group0', 'group1', 'group2']);
    assert.equal(body.questions.group2.criteria.f19.startsWith('自定义19'), true);
    return Response.json({ usage: { truncated: false }, answers: {
      group0: { choice: 'silence', probabilities: { silence: 0.8 } },
      group1: { choice: 'f9', probabilities: { f9: 0.6, silence: 0.2 } },
      group2: { choice: 'f19', probabilities: { f19: 0.8, silence: 0.1 } },
    } });
  }) as typeof fetch);
  assert.equal(await decide([{ role: 'assistant', content: '之前讲过高杆。' }, ...messages], fillers, signal()), '自定义19');
});

test('silence, truncated or malformed decisions and unavailable model never choose random text', async () => {
  for (const body of [
    { usage: { truncated: false }, answers: { group0: { choice: 'silence', probabilities: { silence: 0.8 } } } },
    { usage: { truncated: true }, answers: { group0: { choice: 'f0', probabilities: { f0: 0.9, silence: 0.1 } } } },
    { usage: { truncated: false }, answers: { group0: { choice: 'other', probabilities: { other: 0.9, silence: 0.1 } } } },
    { usage: { truncated: false }, answers: { group0: { choice: 'f0', probabilities: { f0: 0.9 } } } },
  ]) {
    const decide = createFillerDecision(readConfig({}).decision, (async () => Response.json(body)) as typeof fetch);
    assert.equal(await decide(messages, ['嗯……'], signal()), undefined);
  }
  const unavailable = createFillerDecision(readConfig({}).decision, (async () => new Response(null, { status: 503 })) as typeof fetch);
  assert.equal(await unavailable(messages, ['嗯……'], signal()), undefined);
});

test('model request respects timeout and cancellation', async () => {
  let observed: AbortSignal | undefined;
  const fetcher = ((_url: unknown, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
    observed = init.signal as AbortSignal;
    const timer = setTimeout(() => reject(new Error('test timeout')), 300);
    observed.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')); }, { once: true });
  })) as typeof fetch;
  const decide = createFillerDecision({ ...readConfig({}).decision, timeoutMs: 50 }, fetcher);
  assert.equal(await decide(messages, ['嗯……'], signal()), undefined);
  assert.equal(observed?.aborted, true);
  const controller = new AbortController();
  const result = decide(messages, ['嗯……'], controller.signal);
  controller.abort();
  assert.equal(await result, undefined);
  assert.equal(observed?.aborted, true);
});

test('model service configuration permits only local HTTP origins', () => {
  assert.equal(readConfig({ MODEL_SERVICE_URL: 'http://localhost:9000/' }).decision.url, 'http://localhost:9000');
  for (const url of ['https://example.com', 'http://example.com', 'http://localhost/path', 'http://u:p@localhost']) {
    assert.throws(() => readConfig({ MODEL_SERVICE_URL: url }));
  }
});
