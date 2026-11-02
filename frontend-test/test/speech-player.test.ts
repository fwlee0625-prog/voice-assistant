import test from 'node:test'
import assert from 'node:assert/strict'
import { createSpeechPlayer, prepareSpeechPlayback } from '../src/audio/speechPlayer.ts'
import { capturedSpeechWav, clearSpeechDiagnostics, configureSpeechDiagnostics, speechDiagnosticReport } from '../src/audio/speechDiagnostics.ts'

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
  clearSpeechDiagnostics(); configureSpeechDiagnostics(true, true)
  t.after(() => { configureSpeechDiagnostics(false); clearSpeechDiagnostics() })
  const player = createSpeechPlayer()
  const signal = new AbortController().signal
  // Samples -32768, 32767, 0 split across an odd byte boundary.
  await player.append(Buffer.from([0, 128, 255]).toString('base64'), 24000, signal, '已开始播报')
  await player.append(Buffer.from([127, 0, 0]).toString('base64'), 24000, signal, '尚未播报')
  assert.deepEqual(buffers.map(b => [...b]), [[-1], [32767 / 32768, 0]])
  assert.deepEqual([...capturedSpeechWav()!.subarray(44)], [0, 128, 255, 127, 0, 0])
  const diagnosticChunks = speechDiagnosticReport().events.filter(entry => entry.event === 'playback.chunk')
  assert.equal(diagnosticChunks[0]!.fields.peak, 1)
  assert.equal(diagnosticChunks[0]!.fields.clipped, 1)
  assert.equal(diagnosticChunks[1]!.fields.boundaryStep, 1 + 32767 / 32768)
  assert.ok(starts[1]! > starts[0]!)
  assert.deepEqual(player.referenceText?.(), [])
  context.currentTime = 0.12002
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

  // Network jitter leaves only 20ms queued. The next chunk must still join
  // the previous sample exactly, rather than adding another scheduling margin.
  context.currentTime = 0
  const streaming = createSpeechPlayer()
  const packet = Buffer.alloc(2400 * 2).toString('base64') // 100ms at 24kHz
  const first = starts.length
  await streaming.append(packet, 24000, signal)
  context.currentTime = 0.20
  await streaming.append(packet, 24000, signal)
  context.currentTime = 0.30
  await streaming.append(packet, 24000, signal)
  assert.equal(starts[first], 0.12)
  assert.equal(starts[first + 1], starts[first]! + 0.1)
  assert.equal(starts[first + 2], starts[first + 1]! + 0.1)
  context.currentTime = 0.60 // Actual underrun: replenish the startup margin.
  await streaming.append(packet, 24000, signal)
  assert.equal(starts[first + 3], 0.72)
  assert.ok(speechDiagnosticReport().events.some(entry => entry.event === 'playback.chunk' && entry.fields.underrun === true))
  context.currentTime = 1
  await streaming.finish(signal)
  streaming.stop()
})
