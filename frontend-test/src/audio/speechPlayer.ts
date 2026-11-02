/** Provider-independent PCM16 mono playback; preserve odd-byte network boundaries. */
import { createSpeechTimeline, type SpeechSentence, type SpeechProgress } from './speechTimeline.ts'
import { captureSpeechPcm, diagnosticId, diagnosticsEnabled, recordSpeechDiagnostic } from './speechDiagnostics.ts'
export type { SpeechProgress } from './speechTimeline.ts'
let audioContext: AudioContext | undefined
export async function prepareSpeechPlayback() {
  audioContext ??= new AudioContext()
  if (audioContext.state !== 'running') await audioContext.resume()
  return audioContext
}
export interface SpeechPlayer {
  diagnosticId?: string
  append(data: string, sampleRate: number, signal: AbortSignal, text?: string, sentence?: SpeechSentence): Promise<void>
  endSentence?(sentenceId: number): void
  finish(signal: AbortSignal): Promise<void>
  stop(): void
  isPlaying?(): boolean
  referenceText?(): string[]
  duck?(enabled: boolean): void
}
export function createSpeechPlayer(onProgress: (progress: SpeechProgress) => void = () => {}): SpeechPlayer {
  const player = diagnosticId('player')
  const log = (event: string, fields: Record<string, string | number | boolean | null> = {}) => recordSpeechDiagnostic(event, { player, ...fields })
  log('player.create')
  const sources = new Set<AudioBufferSourceNode>()
  let nextTime = 0
  let oddByte: number | undefined
  let stopped = false
  let gain: GainNode | undefined
  let ducked = false
  let lastSample: number | undefined
  let lastArrival: number | undefined
  let chunkIndex = 0
  const references: { start: number; end: number; text: string }[] = []
  const timeline = createSpeechTimeline(onProgress)
  let progressTimer: ReturnType<typeof setInterval> | undefined
  function updateProgress() {
    if (!timeline.update(audioContext?.currentTime || 0)) {
      clearInterval(progressTimer); progressTimer = undefined
    }
  }
  async function wait(ms: number, signal: AbortSignal) {
    await new Promise<void>((resolve, reject) => {
      const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(new Error('播放已取消')) }
      const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, ms)
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    })
  }
  return {
    diagnosticId: player,
    async append(data, sampleRate, signal, text, sentence) {
      signal.throwIfAborted()
      if (stopped) return
      if (sampleRate < 8000 || sampleRate > 96000) throw new Error('语音采样率无效')
      if (!audioContext || audioContext.state !== 'running') throw new Error('浏览器未允许语音播放，请重新点击开始对话')
      const ctx = audioContext
      const arrival = performance.now()
      const arrivalGapMs = lastArrival === undefined ? 0 : arrival - lastArrival
      lastArrival = arrival
      while (nextTime - ctx.currentTime > 15) {
        if (ctx.state !== 'running') throw new Error('语音播放已暂停，请重新开始对话')
        await wait(100, signal)
        if (stopped) return
      }
      const raw = atob(data)
      const bytes = new Uint8Array(raw.length + (oddByte === undefined ? 0 : 1))
      let offset = 0
      if (oddByte !== undefined) bytes[offset++] = oddByte
      for (let i = 0; i < raw.length; i++) bytes[offset + i] = raw.charCodeAt(i)
      oddByte = bytes.length % 2 ? bytes[bytes.length - 1] : undefined
      const samples = Math.floor(bytes.length / 2)
      if (!samples) return
      captureSpeechPcm(player, bytes.subarray(0, samples * 2), sampleRate)
      const buffer = ctx.createBuffer(1, samples, sampleRate)
      const channel = buffer.getChannelData(0)
      const view = new DataView(bytes.buffer)
      for (let i = 0; i < samples; i++) channel[i] = view.getInt16(i * 2, true) / 32768
      let peak = 0; let energy = 0; let clipped = 0; let maxStep = 0; let pcmHash = 2166136261
      if (diagnosticsEnabled()) {
        for (let i = 0; i < samples; i++) {
          const value = channel[i]!
          peak = Math.max(peak, Math.abs(value)); energy += value * value
          pcmHash = Math.imul(pcmHash ^ view.getUint16(i * 2, true), 16777619)
          if (Math.abs(value) >= 0.999) clipped++
          if (i) maxStep = Math.max(maxStep, Math.abs(value - channel[i - 1]!))
        }
      }
      const boundaryStep = lastSample === undefined ? 0 : Math.abs(channel[0]! - lastSample)
      lastSample = channel[samples - 1]
      const source = ctx.createBufferSource()
      if (!gain) {
        gain = ctx.createGain(); gain.gain.value = ducked ? 0.08 : 1; gain.connect(ctx.destination)
      }
      source.buffer = buffer; source.connect(gain)
      sources.add(source)
      const chunk = chunkIndex++
      source.onended = () => { log('playback.ended', { chunk, contextTime: ctx.currentTime, contextState: ctx.state }); sources.delete(source); source.disconnect() }
      // Buffer only at startup or after an actual underrun. Applying a lead time
      // to every chunk inserts silence even when the previous chunk is still playing.
      const queueMs = (nextTime - ctx.currentTime) * 1000
      const underrun = nextTime > 0 && nextTime <= ctx.currentTime
      if (nextTime <= ctx.currentTime) nextTime = ctx.currentTime + 0.12
      log('playback.chunk', { chunk, sentenceId: sentence?.sentenceId ?? -1, samples, sampleRate,
        outputSampleRate: ctx.sampleRate, contextState: ctx.state, contextTime: ctx.currentTime,
        arrivalGapMs, queueMs, underrun, scheduledAt: nextTime, durationMs: buffer.duration * 1000,
        peak, rms: Math.sqrt(energy / samples), clipped, maxStep, boundaryStep, pcmHash: pcmHash >>> 0,
        firstSample: channel[0]!, lastSample: lastSample!, oddByte: oddByte !== undefined })
      source.start(nextTime)
      if (sentence) {
        timeline.append(sentence, nextTime, nextTime + buffer.duration)
        progressTimer ??= setInterval(updateProgress, 30)
      }
      if (text) references.push({ start: nextTime, end: nextTime + buffer.duration, text })
      while (references.length && references[0]!.end < ctx.currentTime - 2) references.shift()
      nextTime += buffer.duration
    },
    async finish(signal) {
      log('player.finish', { contextTime: audioContext?.currentTime || 0, oddByte: oddByte !== undefined })
      if (oddByte !== undefined) throw new Error('语音数据不完整')
      timeline.complete()
      while (!stopped && audioContext && nextTime > audioContext.currentTime) {
        if (audioContext.state !== 'running') throw new Error('语音播放已暂停')
        await wait(100, signal)
      }
      if (!stopped) updateProgress()
    },
    endSentence(sentenceId) { timeline.end(sentenceId); if (!stopped) updateProgress() },
    isPlaying: () => !stopped && !!audioContext && nextTime > audioContext.currentTime,
    referenceText() {
      const now = audioContext?.currentTime || 0
      return [...new Set(references.filter(ref => ref.start <= now && ref.end >= now - 2).map(ref => ref.text))]
    },
    duck(enabled) {
      log('player.volume', { ducked: enabled, contextTime: audioContext?.currentTime || 0 })
      ducked = enabled
      if (gain && audioContext) gain.gain.setTargetAtTime(enabled ? 0.08 : 1, audioContext.currentTime, 0.015)
    },
    stop() {
      log('player.stop', { sources: sources.size, contextTime: audioContext?.currentTime || 0 })
      const now = audioContext?.currentTime || 0
      for (let i = references.length - 1; i >= 0; i--) {
        if (references[i]!.start > now) references.splice(i, 1)
        else references[i]!.end = Math.min(references[i]!.end, now)
      }
      stopped = true; oddByte = undefined; nextTime = 0
      clearInterval(progressTimer); progressTimer = undefined; timeline.clear()
      gain?.disconnect()
      for (const source of sources) { source.onended = null; source.stop(); source.disconnect() }
      sources.clear()
    },
  }
}
