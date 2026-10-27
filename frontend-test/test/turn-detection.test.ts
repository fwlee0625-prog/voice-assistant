import test from 'node:test'
import assert from 'node:assert/strict'
import { createVoiceActivity } from '../src/audio/voiceActivity.ts'
import { filterEcho } from '../src/chat/echoGuard.ts'
import { endpointDelay } from '../src/chat/endpoint.ts'
const pcm = (level: number, ms = 40) => new Int16Array(ms * 16).fill(Math.round(level * 32768))

test('activity requires sustained energy and silence; clicks and low noise do not trigger', () => {
  const events: boolean[] = []
  const activity = createVoiceActivity(value => events.push(value))
  for (let i = 0; i < 50; i++) activity.push(pcm(0.003))
  activity.push(pcm(0.2)); activity.push(pcm(0)); activity.push(pcm(0))
  assert.deepEqual(events, [])
  for (let i = 0; i < 4; i++) activity.push(pcm(0.05))
  assert.deepEqual(events, [true])
  for (let i = 0; i < 5; i++) activity.push(pcm(0))
  assert.deepEqual(events, [true])
  activity.push(pcm(0)); assert.deepEqual(events, [true, false])
  for (let i = 0; i < 4; i++) activity.push(pcm(0.05))
  activity.reset(); assert.deepEqual(events, [true, false, true, false])
})
test('echo uses normalization, tolerates substitutions and retains new speech and commands', () => {
  const reference = ['先瞄准目标球，再平稳出杆。']
  assert.equal(filterEcho('先瞄准目标球。', reference), '')
  assert.equal(filterEcho('先瞄准木标球，再平稳出杆。', reference), '')
  assert.equal(filterEcho('先瞄准目标球，再平稳出竿。', reference), '')
  assert.equal(filterEcho('先瞄准目标球，换个问题', reference), '换个问题')
  assert.equal(filterEcho('等一下', ['请等一下']), '等一下')
  assert.equal(filterEcho('停止', ['需要停止']), '停止')
  assert.equal(filterEcho('我要问另一个问题', reference), '我要问另一个问题')
  assert.equal(filterEcho('先瞄准目标球。', []), '先瞄准目标球。')
})
test('endpoint budgets distinguish complete questions, short and unfinished phrases', () => {
  assert.equal(endpointDelay('怎么打？'), 450)
  assert.equal(endpointDelay('我想问这个问题。'), 550)
  assert.equal(endpointDelay('说一个长句'), 750)
  assert.equal(endpointDelay('你好'), 900)
  for (const text of ['然后', '我想，', '因为。', '还有', '帮我']) assert.equal(endpointDelay(text), 1300)
})

test('Silero probability gate uses hysteresis and rejects isolated high-confidence bursts', async () => {
  const { createProbabilityActivity } = await import('../src/audio/sileroActivity.ts')
  const events: boolean[] = []
  const activity = createProbabilityActivity(v => events.push(v))
  for (let i = 0; i < 4; i++) activity.push(0.9)
  assert.deepEqual(events, [])
  activity.push(0.1)
  for (let i = 0; i < 5; i++) activity.push(0.9)
  assert.deepEqual(events, [true])
  for (let i = 0; i < 9; i++) activity.push(0.1)
  assert.deepEqual(events, [true])
  activity.push(0.1); assert.deepEqual(events, [true, false])
  assert.throws(() => activity.push(Number.NaN))
  activity.reset()
})
