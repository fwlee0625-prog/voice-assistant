import test from 'node:test'
import assert from 'node:assert/strict'
import { createSpeechPlayer, prepareSpeechPlayback } from '../src/audio/speechPlayer.ts'

test('PCM playback preserves odd bytes, schedules chunks in order and stops sources', async t => {
  const buffers: Float32Array[] = []
  const starts: number[] = []
  let stops = 0
  let context!: FakeContext
  const volumes: number[] = []
  class FakeContext {
    constructor() { context = this }
    state = 'suspended'
    currentTime = 0
    destination = {}
    async resume() { this.state = 'running' }
    createGain() { return { gain: { value: 1, setTargetAtTime(value: number) { volumes.push(value) } }, connect() {}, disconnect() {} } }
    createBuffer(_channels: number, samples: number, sampleRate: number) {
      const data = new Float32Array(samples); buffers.push(data)
      return { duration: samples / sampleRate, getChannelData: () => data }
    }
    createBufferSource() {
      return { buffer: null, onended: null, connect() {}, disconnect() {}, start(time: number) { starts.push(time) }, stop() { stops++ } }
    }
  }
  Object.defineProperty(globalThis, 'AudioContext', { configurable: true, value: FakeContext })
  t.after(() => { Reflect.deleteProperty(globalThis, 'AudioContext') })
  await prepareSpeechPlayback()
  const player = createSpeechPlayer()
  const signal = new AbortController().signal
  // Samples -32768, 32767, 0 split across an odd byte boundary.
  await player.append(Buffer.from([0, 128, 255]).toString('base64'), 24000, signal, '已开始播报')
  await player.append(Buffer.from([127, 0, 0]).toString('base64'), 24000, signal, '尚未播报')
  assert.deepEqual(buffers.map(b => [...b]), [[-1], [32767 / 32768, 0]])
  assert.ok(starts[1]! > starts[0]!)
  assert.deepEqual(player.referenceText?.(), [])
  context.currentTime = 0.03002
  assert.deepEqual(player.referenceText?.(), ['已开始播报'])
  assert.equal(player.isPlaying?.(), true)
  player.duck?.(true); player.duck?.(false); assert.deepEqual(volumes, [0.08, 1])
  player.stop(); assert.equal(stops, 2)
  assert.deepEqual(player.referenceText?.(), ['已开始播报'])
  context.currentTime = 3
  assert.deepEqual(player.referenceText?.(), [])
  await player.append('AAA=', 24000, signal)
  assert.equal(buffers.length, 2)
  await player.finish(signal)
  const controller = new AbortController(); controller.abort()
  await assert.rejects(player.append('AAA=', 24000, controller.signal))
})
