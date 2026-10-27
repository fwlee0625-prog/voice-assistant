import test from 'node:test'
import assert from 'node:assert/strict'
import { createWakeBuffer } from '../src/audio/wakeBuffer.ts'
import { createPcmUpload } from '../src/audio/pcmUpload.ts'

test('standby keeps only two seconds, wake freezes the prefix, transfer and reset are single-use', () => {
  const buffer = createWakeBuffer()
  for (let i = 0; i < 70; i++) assert.equal(buffer.push(new Int16Array(640).fill(i)), true)
  assert.equal(buffer.trigger(), true); assert.equal(buffer.trigger(), false)
  for (let i = 0; i < 100; i++) assert.equal(buffer.push(new Int16Array(640).fill(i + 70)), true)
  assert.equal(buffer.push(new Int16Array(640)), false)
  const frames = buffer.take(); assert.equal(frames.length, 150)
  assert.equal(frames[0]?.[0], 20); assert.equal(frames[149]?.[0], 169)
  assert.equal(buffer.take().length, 0)
  buffer.push(new Int16Array(640)); buffer.clear(); assert.equal(buffer.take().length, 0)
})
test('wake pre-roll and live frames stay ordered, with bounded paced catch-up and clean drain', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
  const sent: number[] = []; const status: boolean[] = []
  const upload = createPcmUpload(frame => { sent.push(frame[0]!); return true }, value => status.push(value), () => assert.fail('unexpected failure'))
  upload.start([new Int16Array([1]), new Int16Array([2]), new Int16Array([3])])
  upload.push(new Int16Array([4])); assert.deepEqual(sent, [])
  t.mock.timers.tick(20); assert.deepEqual(sent, [1, 2])
  const drained = upload.drain()
  t.mock.timers.tick(20); await drained
  assert.deepEqual(sent, [1, 2, 3, 4]); assert.deepEqual(status, [true, false])
  upload.push(new Int16Array([5])); assert.equal(sent.at(-1), 5)
  upload.dispose(); upload.push(new Int16Array([6])); assert.equal(sent.at(-1), 5)
})
test('backpressure cannot grow audio indefinitely and disposal clears pending drains', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
  const errors: string[] = []
  const upload = createPcmUpload(() => false, () => {}, message => errors.push(message))
  for (let i = 0; i < 151; i++) upload.push(new Int16Array(640))
  assert.equal(errors.length, 1)
  const other = createPcmUpload(() => false, () => {}, message => errors.push(message))
  other.push(new Int16Array(640)); const drain = other.drain(); other.dispose(); await drain
  t.mock.timers.tick(5000); assert.equal(errors.length, 1)
})
