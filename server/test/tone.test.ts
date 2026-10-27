import test from 'node:test';
import assert from 'node:assert/strict';
import { createToneDecoder, voiceReplyPrompt } from '../src/chat/tone.ts';
import { streamSpokenReply, type ReplyEvent } from '../src/chat/speech.ts';
import { completeChat } from '../src/chat/client.ts';
import { defaults } from '../src/settings/store.ts';
import { createXiaomiTts } from '../src/tts/xiaomi.ts';
const signal = () => new AbortController().signal;
const audio = { data: 'AAA=', sampleRate: 24000, channels: 1 as const, format: 'pcm16' as const };

test('tone markup survives every split point without leaking or removing ordinary brackets', () => {
  const source = '〖语气：温柔、语速稍慢〗嗯，瞄准（目标球）[1]。〖语气：轻快〗好呀！';
  for (let i = 0; i <= source.length; i++) {
    const decoder = createToneDecoder();
    const parts = [...decoder.push(source.slice(0, i)), ...decoder.push(source.slice(i), true)];
    assert.equal(parts.filter(p => p.type === 'text').map(p => p.value).join(''), '嗯，瞄准（目标球）[1]。好呀！');
    assert.deepEqual(parts.filter(p => p.type === 'style').map(p => p.value), ['温柔、语速稍慢', '轻快']);
  }
  for (const invalid of ['〖语气：温柔', '〖语', '〖语气：' + '长'.repeat(200) + '〗', '〖语气：坏\n指令〗']) {
    const parts = createToneDecoder().push('正文。' + invalid, true);
    assert.equal(parts.filter(p => p.type === 'text').map(p => p.value).join(''), '正文。');
  }
});

test('bridge snapshots styles for queued sentences, emits only clean text and clean offsets', async () => {
  const events: ReplyEvent[] = []; const requests: { text: string; style?: string }[] = [];
  const source = '〖语气：温柔〗先站稳。再瞄准〖语气：轻快〗好呀！';
  async function* text() { for (const char of source) yield char; }
  await streamSpokenReply(text(), { async *synthesize(req) {
    requests.push({ text: req.text, style: req.style }); yield audio;
  } }, '冰糖', signal(), async event => { events.push(event); });
  const visible = events.filter(e => e.type === 'text').map(e => e.delta).join('');
  assert.equal(visible, '先站稳。再瞄准好呀！');
  assert.deepEqual(requests, [{ text: '先站稳。', style: '温柔' }, { text: '再瞄准', style: '温柔' }, { text: '好呀！', style: '轻快' }]);
  assert.deepEqual(events.filter(e => e.type === 'audio').map(e => [e.start, e.end]), [[0, 4], [4, 7], [7, 10]]);
  assert.ok(!JSON.stringify(events).includes('语气'));
  const silent: ReplyEvent[] = [];
  await streamSpokenReply(text(), undefined, '冰糖', signal(), async e => { silent.push(e); });
  assert.equal(silent.filter(e => e.type === 'text').map(e => e.delta).join(''), visible);
});

test('existing configured prompt receives tone rules; nonstreaming reply is clean', async t => {
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    assert.equal(body.messages[0].content, '原业务规则\n\n' + voiceReplyPrompt);
    return Response.json({ choices: [{ message: { content: '〖语气：亲切〗好呀。' } }] });
  });
  const result = await completeChat({ ...defaults, systemPrompt: '原业务规则' }, 'fake', [{ role: 'user', content: '你好' }], signal());
  assert.equal(result.text, '好呀。');
});

test('Xiaomi gets separate natural language direction and spoken body', async t => {
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    assert.equal(body.messages[0].role, 'user');
    assert.match(body.messages[0].content, /温柔、语速稍慢/);
    assert.deepEqual(body.messages[1], { role: 'assistant', content: '嗯，先站稳。' });
    return new Response('data: ' + JSON.stringify({ choices: [{ delta: { audio: { data: 'AAA=' } } }] }) + '\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
  });
  for await (const chunk of createXiaomiTts('fake').synthesize({ text: '嗯，先站稳。', style: '温柔、语速稍慢', voice: '冰糖', signal: signal() })) assert.deepEqual(chunk, audio);
});
