import test from 'node:test'
import assert from 'node:assert/strict'
import { analyzeSpeechTimings, type DiagnosticEvent } from '../src/audio/speechTiming.ts'
const e = (ms: number, event: string, fields: DiagnosticEvent['fields']): DiagnosticEvent => ({ ms, event, fields })
test('analysis correlates requests and uses separate browser/server clocks, excludes filler playback', () => {
  const events = [
    e(400, 'turn.commit', { trace: 't', silenceAtMs: 0, finalAtMs: 300 }),
    e(420, 'reply.request', { trace: 't', player: 'p', turn: 1 }),
    e(450, 'reply.response', { player: 'p', requestId: 'r' }),
    e(500, 'playback.chunk', { player: 'p', sentenceId: -1, scheduledAt: 1.12, contextTime: 1 }),
    e(700, 'stream.event', { requestId: 'r', stage: 'model.request', serverElapsedMs: 10 }),
    e(800, 'stream.event', { requestId: 'r', stage: 'model.first_delta', serverElapsedMs: 110 }),
    e(810, 'stream.event', { requestId: 'r', type: 'text', textChars: 2 }),
    e(900, 'stream.event', { requestId: 'r', stage: 'tts.request', sentenceId: 0, serverElapsedMs: 210 }),
    e(1100, 'stream.event', { requestId: 'r', stage: 'tts.first_audio', sentenceId: 0, serverElapsedMs: 410 }),
    e(1101, 'stream.event', { requestId: 'r', type: 'audio' }),
    e(1110, 'playback.chunk', { player: 'p', sentenceId: 0, scheduledAt: 2.12, contextTime: 2, underrun: true }),
    e(1150, 'stream.event', { requestId: 'r', stage: 'tts.end', sentenceId: 0, serverElapsedMs: 460 }),
    e(1500, 'reply.end', { player: 'p', status: 'interrupted' }),
    e(1600, 'reply.request', { trace: 'other', player: 'other', turn: 2 }),
  ]
  const [row, other] = analyzeSpeechTimings(events)
  assert.equal(row!.metrics.turnWaitMs, 400)
  assert.equal(row!.metrics.modelFirstDeltaMs, 100)
  assert.equal(row!.metrics.firstPhraseMs, 100)
  assert.equal(row!.metrics.ttsFirstAudioMs, 200)
  assert.equal(row!.metrics.requestToPlaybackMs, 810)
  assert.equal(row!.metrics.silenceToPlaybackMs, 1230)
  assert.equal(row!.largestObservedStage?.label, '话轮等待')
  assert.equal(row!.status, 'interrupted'); assert.equal(row!.underruns, 1)
  assert.equal(row!.sentences[0]!.synthesisMs, 250)
  assert.equal(other!.metrics.ttsFirstAudioMs, null)
  assert.equal(other!.metrics.silenceToPlaybackMs, null)
})
test('missing/evicted nodes and negative differences remain unknown', () => {
  const [row] = analyzeSpeechTimings([
    e(100, 'reply.request', { player: 'p' }),
    e(110, 'reply.response', { player: 'p', requestId: '' }),
    e(120, 'stream.event', { requestId: '', stage: 'model.first_delta', serverElapsedMs: 0 }),
  ])
  assert.equal(row!.metrics.modelFirstDeltaMs, null)
  assert.equal(row!.largestObservedStage, null)
})
