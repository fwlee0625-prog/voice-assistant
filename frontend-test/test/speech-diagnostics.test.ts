import test from 'node:test'
import assert from 'node:assert/strict'
import { captureSpeechPcm, capturedSpeechWav, clearSpeechDiagnostics, configureSpeechDiagnostics,
  diagnosticsState, recordSpeechDiagnostic, speechDiagnosticReport } from '../src/audio/speechDiagnostics.ts'
import { readReply } from '../src/chat/stream.ts'

test('diagnostics are opt-in, bounded, and keep audio capture separate', () => {
  clearSpeechDiagnostics(); configureSpeechDiagnostics(false)
  recordSpeechDiagnostic('ignored'); captureSpeechPcm('p', new Uint8Array([1, 2]), 24000)
  assert.equal(diagnosticsState().events, 0); assert.equal(capturedSpeechWav(), undefined)
  configureSpeechDiagnostics(true)
  captureSpeechPcm('p', new Uint8Array([1, 2]), 24000)
  assert.equal(capturedSpeechWav(), undefined)
  for (let i = 0; i < 4001; i++) recordSpeechDiagnostic('chunk', { i })
  assert.equal(diagnosticsState().events, 4000); assert.ok(diagnosticsState().dropped > 0)
  const snapshot = speechDiagnosticReport(); snapshot.events[0]!.fields.i = -1
  assert.notEqual(speechDiagnosticReport().events[0]!.fields.i, -1)
  configureSpeechDiagnostics(true, true)
  const part = Uint8Array.from([0, 128, 255, 127]); captureSpeechPcm('p', part, 24000); part.fill(0)
  const wav = capturedSpeechWav()!
  assert.equal(new TextDecoder().decode(wav.subarray(0, 4)), 'RIFF')
  assert.equal(new DataView(wav.buffer).getUint32(24, true), 24000)
  assert.deepEqual([...wav.subarray(44)], [0, 128, 255, 127])
  captureSpeechPcm('next', new Uint8Array([1, 0]), 24000)
  assert.deepEqual([...capturedSpeechWav()!.subarray(44)], [1, 0])
  captureSpeechPcm('next', new Uint8Array(8 * 1024 * 1024), 24000)
  assert.equal(diagnosticsState().audioTruncated, true)
  captureSpeechPcm('next', new Uint8Array([2, 0]), 24000)
  assert.deepEqual([...capturedSpeechWav()!.subarray(44)], [1, 0])
  configureSpeechDiagnostics(false); assert.equal(capturedSpeechWav(), undefined)
  clearSpeechDiagnostics(); assert.equal(diagnosticsState().events, 0)
})

test('stream diagnostics correlate server events without retaining text or PCM and record truncation', async () => {
  clearSpeechDiagnostics(); configureSpeechDiagnostics(true)
  const response = (events: unknown[]) => new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(''),
    { headers: { 'Content-Type': 'text/event-stream', 'X-Voice-Trace': 'request-test' } })
  const events = [
    { type: 'text', delta: 'private-dialogue', diagnostic: { sequence: 0, elapsedMs: 10 } },
    { type: 'audio', data: 'secret-audio', sentenceId: 3, diagnostic: { sequence: 1, elapsedMs: 30 } },
    { type: 'done', diagnostic: { sequence: 2, elapsedMs: 40 } },
  ]
  await readReply(response(events), async () => {})
  const report = speechDiagnosticReport()
  assert.ok(report.events.some(entry => entry.fields.requestId === 'request-test' && entry.fields.sequence === 1))
  assert.ok(!JSON.stringify(report).includes('private-dialogue'))
  assert.ok(!JSON.stringify(report).includes('secret-audio'))
  await assert.rejects(readReply(response(events.slice(0, 1)), async () => {}), /中断/)
  assert.ok(speechDiagnosticReport().events.some(entry => entry.event === 'stream.error'))
  configureSpeechDiagnostics(false); clearSpeechDiagnostics()
})

test('timing stream events are accepted and exported without leaking answer data', async () => {
  clearSpeechDiagnostics(); configureSpeechDiagnostics(true)
  recordSpeechDiagnostic('reply.request', { trace: 'turn-timing', player: 'p', turn: 1 })
  recordSpeechDiagnostic('reply.response', { player: 'p', requestId: 'timing' })
  const payload = [
    { type: 'timing', stage: 'model.request', diagnostic: { sequence: 0, elapsedMs: 10 } },
    { type: 'timing', stage: 'model.first_delta', diagnostic: { sequence: 1, elapsedMs: 90 } },
    { type: 'text', delta: 'private-answer' },
    { type: 'done' },
  ]
  const response = new Response(payload.map(e => `data: ${JSON.stringify(e)}\n\n`).join(''),
    { headers: { 'Content-Type': 'text/event-stream', 'X-Voice-Trace': 'timing' } })
  await readReply(response, async () => {})
  const report = speechDiagnosticReport()
  assert.equal(report.version, 2)
  assert.equal(report.analysis[0]!.metrics.modelFirstDeltaMs, 80)
  assert.ok(!JSON.stringify(report).includes('private-answer'))
  configureSpeechDiagnostics(false); clearSpeechDiagnostics()
})
