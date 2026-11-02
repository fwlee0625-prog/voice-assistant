import { analyzeSpeechTimings } from './speechTiming.ts'
/** Bounded, opt-in local diagnostics. Never store prompts, credentials or microphone audio. */
type Fields = Record<string, string | number | boolean | null>
const MAX_EVENTS = 4000
const MAX_AUDIO_BYTES = 8 * 1024 * 1024
let enabled = false
let captureAudio = false
let dropped = 0
let startedAt = new Date().toISOString()
let origin = performance.now()
let sequence = 0
const events: { ms: number; event: string; fields: Fields }[] = []
let audio: { player: string; sampleRate: number; parts: Uint8Array[]; bytes: number; truncated: boolean } | undefined
export function diagnosticTime(timestamp = performance.now()) { return timestamp - origin }
export function speechTimingAnalysis() { return analyzeSpeechTimings(events) }
export function diagnosticId(prefix: string) { return `${prefix}-${++sequence}` }
export function diagnosticsEnabled() { return enabled }
export function diagnosticsState() { return { enabled, captureAudio, events: events.length, dropped, audioBytes: audio?.bytes || 0, audioTruncated: audio?.truncated || false } }
export function recordSpeechDiagnostic(event: string, fields: Fields = {}) {
  if (!enabled) return
  if (events.length === MAX_EVENTS) { events.shift(); dropped++ }
  events.push({ ms: Math.round((performance.now() - origin) * 100) / 100, event, fields })
}
export function clearSpeechDiagnostics() {
  events.length = 0; dropped = 0; audio = undefined
  startedAt = new Date().toISOString(); origin = performance.now()
}
export function configureSpeechDiagnostics(value: boolean, capture = false) {
  enabled = value; captureAudio = value && capture
  if (!captureAudio) audio = undefined
  recordSpeechDiagnostic('diagnostics.config', { captureAudio })
}
export function captureSpeechPcm(player: string, bytes: Uint8Array, sampleRate: number) {
  if (!enabled || !captureAudio) return
  if (!audio || audio.player !== player) audio = { player, sampleRate, parts: [], bytes: 0, truncated: false }
  if (audio.sampleRate !== sampleRate || audio.bytes + bytes.length > MAX_AUDIO_BYTES) {
    if (!audio.truncated) recordSpeechDiagnostic('capture.truncated', { player, bytes: audio.bytes })
    audio.truncated = true; return
  }
  if (audio.truncated) return
  audio.parts.push(bytes.slice()); audio.bytes += bytes.length
}
export function speechDiagnosticReport() {
  return { version: 2, analysis: speechTimingAnalysis(), startedAt, exportedAt: new Date().toISOString(), ...diagnosticsState(),
    environment: typeof navigator === 'undefined' ? {} : { userAgent: navigator.userAgent },
    audioPlayer: audio?.player, events: events.map(entry => ({ ...entry, fields: { ...entry.fields } })) }
}
export function capturedSpeechWav(): Uint8Array | undefined {
  if (!audio?.bytes) return
  const size = audio.bytes - audio.bytes % 2
  const wav = new Uint8Array(44 + size); const view = new DataView(wav.buffer)
  const ascii = (offset: number, text: string) => { for (let i = 0; i < text.length; i++) wav[offset + i] = text.charCodeAt(i) }
  ascii(0, 'RIFF'); view.setUint32(4, 36 + size, true); ascii(8, 'WAVEfmt ')
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
  view.setUint32(24, audio.sampleRate, true); view.setUint32(28, audio.sampleRate * 2, true)
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); ascii(36, 'data'); view.setUint32(40, size, true)
  let offset = 44
  for (const part of audio.parts) { const kept = part.subarray(0, wav.length - offset); wav.set(kept, offset); offset += kept.length }
  return wav
}
export function downloadSpeechDiagnostics(kind: 'json' | 'wav') {
  const wav = kind === 'wav' ? capturedSpeechWav() : undefined
  if (kind === 'wav' && !wav) return
  const blob = kind === 'json' ? new Blob([JSON.stringify(speechDiagnosticReport(), null, 2)], { type: 'application/json' })
    : new Blob([wav!.slice().buffer as ArrayBuffer], { type: 'audio/wav' })
  const url = URL.createObjectURL(blob); const link = document.createElement('a')
  link.href = url; link.download = `voice-diagnostic-${Date.now()}.${kind}`; link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
