import test from 'node:test';
import assert from 'node:assert/strict';
import { createAudienceGate } from '../src/turns/audience.ts';
import { createTurnSession, type TurnEvent } from '../src/turns/session.ts';
import { createTurnDetector } from '../src/turns/worker.ts';
const part = (id: number, text: string, stable = 1) => ({ speaker_id: id, text, stable_flag: stable });

test('owner is established by a stable explicit call, not the first person to speak', () => {
  const gate = createAudienceGate();
  assert.equal(gate.decide(0, [part(1, '今晚吃什么')])[0]?.action, 'wait');
  assert.equal(gate.owner(), undefined);
  assert.equal(gate.decide(1, [part(2, '你好助手，给三号台开台', 0)])[0]?.action, 'wait');
  assert.equal(gate.owner(), undefined);
  assert.equal(gate.decide(1, [part(2, '你好助手，给三号台开台')])[0]?.action, 'accept');
  assert.equal(gate.owner(), 2);
  assert.equal(gate.decide(2, [part(1, '这个球该打低杆')])[0]?.action, 'ignore');
  assert.equal(gate.decide(3, [part(2, '这个球怎么打低杆')])[0]?.action, 'accept');
  assert.equal(gate.decide(4, [part(2, '今晚吃什么')])[0]?.action, 'ignore');
});
test('same-index multiple speakers stay separate, takeover and late revisions are safe', () => {
  const gate = createAudienceGate();
  gate.decide(0, [part(1, '你好助手')]);
  const result = gate.decide(1, [part(1, '帮我开一号台'), part(2, '你好助手，开二号台'), part(3, '今晚吃饭')]);
  assert.equal(result.length, 3);
  assert.deepEqual(result.filter(p => p.action === 'accept').map(p => p.speakerId), [2]);
  gate.decide(0, [part(1, '你好助手')]);
  assert.equal(gate.owner(), 2);
  assert.equal(gate.decide(2, [part(-1, '你好助手')])[0]?.action, 'wait');
});
test('wait commands are independent of billiards, contextual short replies are admitted', () => {
  let now = 0; const gate = createAudienceGate(() => now);
  gate.decide(0, [part(1, '你好助手')]);
  assert.equal(gate.decide(1, [part(1, '我接个电话')])[0]?.action, 'stop');
  assert.equal(gate.decide(2, [part(1, '这个球怎么打')])[0]?.action, 'accept');
  assert.equal(gate.decide(3, [part(1, '继续')])[0]?.action, 'accept');
  gate.context({ active: false, references: [], question: '你要开哪个台？' });
  assert.equal(gate.decide(4, [part(1, '三号')])[0]?.action, 'accept');
  gate.context({ active: true, references: [], question: '你要开哪个台？' });
  assert.equal(gate.decide(4, [part(1, '三号')])[0]?.action, 'accept');
  gate.context({ active: true, references: ['如果想停止请告诉我'], question: '' });
  assert.equal(gate.decide(4, [part(1, '停止')])[0]?.action, 'stop');
  gate.decide(5, [part(1, '继续')]);
  assert.equal(gate.decide(4, [part(1, '停止')])[0]?.reason, 'duplicate_control');
  gate.context({ active: true, references: ['这个球应该打低杆'], question: '' });
  assert.equal(gate.decide(5, [part(1, '这个球应该打低杆')])[0]?.reason, 'echo');
  gate.context({ active: false, references: [], question: '' }); now = 120001;
  assert.equal(gate.decide(6, [part(1, '帮我开台')])[0]?.reason, 'call_assistant');
});
test('the follow-up question releases the wait gate', () => {
  const gate = createAudienceGate(Date.now, true);
  gate.decide(0, [part(1, '你好')]);
  gate.decide(1, [part(1, '等等')]);
  gate.context({ active: true, references: [], question: '我在，还需要什么帮助吗？' });
  assert.equal(gate.decide(3, [part(1, '帮我看看')])[0]?.action, 'accept');
});
test('turn session bounds audio, ignores stale inference and preserves all speaker decisions', async () => {
  const events: TurnEvent[] = []; const requests: { audio: Buffer; signal: AbortSignal; resolve(value?: number): void }[] = [];
  let warmed = 0;
  const session = createTurnSession({ warm() { warmed++; }, close() {}, predict(audio, signal) {
    return new Promise(resolve => requests.push({ audio, signal, resolve }));
  } }, e => events.push(e));
  assert.equal(warmed, 1);
  for (let i = 0; i < 250; i++) session.audio(Buffer.alloc(1280));
  session.control({ type: 'activity', epoch: 1, speaking: true });
  session.control({ type: 'activity', epoch: 1, speaking: false });
  assert.equal(requests[0]?.audio.length, 256000);
  session.control({ type: 'activity', epoch: 2, speaking: true });
  requests[0]!.resolve(0.9); await new Promise(r => setImmediate(r));
  assert.equal(events.length, 0); assert.equal(requests[0]?.signal.aborted, true);
  session.control({ type: 'activity', epoch: 2, speaking: false });
  requests[1]!.resolve(0.8); await new Promise(r => setImmediate(r));
  assert.deepEqual(events[0], { type: 'endpoint', epoch: 2, probability: 0.8, mode: 'model' });
  session.result(0, '你好助手。旁边闲聊。', true, [part(1, '你好助手'), part(2, '旁边闲聊')]);
  const result = events[1]; assert.equal(result?.type, 'interaction');
  if (result?.type === 'interaction') { assert.equal(result.owner, 1); assert.equal(result.parts.length, 2); }
  assert.throws(() => session.control({ type: 'playback', active: true, references: [123], question: '' }));
  assert.throws(() => session.control({ type: 'activity', speaking: false, epoch: -1 }));
  assert.throws(() => session.control({ type: 'activity', epoch: 3, speaking: false }));
  session.close();
});
test('disabled model falls back without starting a worker or throwing', async () => {
  const detector = createTurnDetector({ enabled: false, python: 'missing-python', model: 'missing-model' });
  detector.warm(); assert.equal(await detector.predict(Buffer.alloc(16000), new AbortController().signal), undefined);
  detector.close();
});


test('negotiated ASR transport carries raw transcript, speaker decisions and model scores', { timeout: 5000 }, async t => {
  const { fakeCloud, testServer, client } = await import('./helpers.ts');
  const connectAsr = await fakeCloud(t, cloud => {
    cloud.on('message', (data, binary) => {
      if (binary) return;
      const request = JSON.parse(data.toString());
      if (request.type === 'start') {
        cloud.send(JSON.stringify({ code: 0 }));
        cloud.send(JSON.stringify({ code: 0, result: { index: 0, slice_type: 2, voice_text_str: '你好助手。今晚吃饭。', speaker_segments: [part(1, '你好助手'), part(2, '今晚吃饭')] } }));
      }
      if (request.type === 'end') cloud.send(JSON.stringify({ code: 0, final: 1 }));
    });
  });
  const { wsUrl } = await testServer(t, { connectAsr, turnDetector: { warm() {}, close() {}, predict: async () => 0.9 } });
  const { socket, next } = client(wsUrl + '?turns=1');
  assert.equal((await next()).type, 'ready');
  assert.equal((await next()).type, 'result');
  const interaction = await next(); assert.equal(interaction.owner, 1);
  assert.deepEqual(interaction.parts.map((p: { action: string }) => p.action), ['accept', 'ignore']);
  socket.send(JSON.stringify({ type: 'playback', active: false, references: [], question: '' }));
  socket.send(Buffer.alloc(1280));
  socket.send(JSON.stringify({ type: 'activity', epoch: 1, speaking: true }));
  socket.send(JSON.stringify({ type: 'activity', epoch: 1, speaking: false }));
  assert.deepEqual(await next(), { type: 'endpoint', epoch: 1, probability: 0.9, mode: 'model' });
  socket.send(JSON.stringify({ type: 'end' })); assert.equal((await next()).type, 'done');
});

test('activated entry accepts ordinary speech without a call, retains speaker stability and bystander controls', () => {
  const gate = createAudienceGate(Date.now, true);
  assert.equal(gate.decide(0, [part(1, '你好', 0)])[0]?.reason, 'speaker_unstable');
  assert.equal(gate.owner(), undefined);
  assert.equal(gate.decide(0, [part(1, '你好')])[0]?.action, 'accept');
  assert.equal(gate.owner(), 1);
  assert.equal(gate.decide(1, [part(1, '今天怎么样')])[0]?.action, 'accept');
  assert.equal(gate.decide(2, [part(2, '今天怎么样')])[0]?.reason, 'bystander');
  assert.equal(gate.decide(3, [part(1, '等一下')])[0]?.action, 'stop');
  assert.equal(gate.decide(4, [part(1, '今天怎么样')])[0]?.action, 'accept');
  assert.equal(gate.decide(5, [part(1, '继续')])[0]?.action, 'accept');
  gate.context({ active: true, question: '', references: ['今天很好'] });
  assert.equal(gate.decide(6, [part(1, '今天很好')])[0]?.reason, 'echo');
});

test('manual and wake entry propagate through WebSocket to the audience gate', { timeout: 5000 }, async t => {
  const { fakeCloud, testServer, client } = await import('./helpers.ts');
  const connectAsr = await fakeCloud(t, cloud => {
    cloud.on('message', (data, binary) => {
      if (binary) return;
      const request = JSON.parse(data.toString());
      if (request.type === 'start') {
        cloud.send(JSON.stringify({ code: 0 }));
        cloud.send(JSON.stringify({ code: 0, result: { index: 0, slice_type: 2, voice_text_str: '今天怎么样', speaker_segments: [part(1, '今天怎么样')] } }));
      }
    });
  });
  const { wsUrl } = await testServer(t, { connectAsr, turnDetector: { warm() {}, close() {}, predict: async () => undefined } });
  for (const entry of ['manual', 'wake', 'unknown']) {
    const { socket, next } = client(wsUrl + '?turns=1&entry=' + entry);
    assert.equal((await next()).type, 'ready');
    assert.equal((await next()).type, 'result');
    const event = await next();
    assert.equal(event.type, 'interaction');
    assert.equal(event.parts[0].action, entry === 'unknown' ? 'wait' : 'accept');
    socket.close();
  }
});
