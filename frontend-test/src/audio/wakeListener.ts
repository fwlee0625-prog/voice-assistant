import { createKeywordSpotter, type WakeKeyword } from './kws.ts'
import { createWakeBuffer } from './wakeBuffer.ts'
export interface WakeInput { stream: MediaStream; takePreroll: () => Int16Array[] }
/** Owns local capture and KWS only. It never opens a WebSocket or uploads audio. */
export class WakeListener {
  private kws!: Awaited<ReturnType<typeof createKeywordSpotter>>
  private context: AudioContext | undefined
  private source: MediaStreamAudioSourceNode | undefined
  private capture: AudioWorkletNode | undefined
  private stream: MediaStream | undefined
  private phase: 'idle' | 'standby' | 'connecting' | 'awake' | 'closed' = 'idle'
  private suppressed = false
  private promptPlaying = false
  private releaseTimer: ReturnType<typeof setTimeout> | undefined
  private generation = 0
  private buffer = createWakeBuffer()
  private constructor(private onWake: (input: WakeInput, keyword: string) => void, private onError: (message: string) => void) {}
  static async create(onWake: (input: WakeInput, keyword: string) => void, onError: (message: string) => void, signal?: AbortSignal, keywords?: WakeKeyword[]) {
    const listener = new WakeListener(onWake, onError)
    listener.kws = await createKeywordSpotter(keyword => {
      if (listener.phase !== 'standby' || listener.suppressed || !listener.stream || !listener.buffer.trigger()) return
      listener.phase = 'connecting'
      listener.onWake(listener.input(), keyword)
    }, message => { listener.dispose(); onError(message) }, signal, keywords)
    return listener
  }
  private isClosed() { return this.phase === 'closed' }
  private closeCapture() {
    this.generation++
    this.source?.disconnect(); this.capture?.disconnect(); this.capture?.port.close()
    this.source = undefined; this.capture = undefined
    void this.context?.close().catch(() => {}); this.context = undefined
  }
  private input(): WakeInput {
    return { stream: this.stream!, takePreroll: () => {
      if (this.phase !== 'connecting') return []
      this.phase = 'awake'; this.closeCapture(); return this.buffer.take()
    } }
  }
  beginManual(): WakeInput | undefined {
    if (this.phase !== 'standby' || !this.stream) return undefined
    this.buffer.clear(); this.buffer.trigger(); this.phase = 'connecting'; this.kws.pause()
    return this.input()
  }
  async listen(stream: MediaStream) {
    if (this.phase === 'closed') return
    this.closeCapture(); this.stream = stream; this.buffer.clear(); this.phase = 'idle'
    const context = new AudioContext({ sampleRate: 16000 }); this.context = context
    const generation = this.generation
    try {
      await context.resume()
      await context.audioWorklet.addModule(`${import.meta.env.BASE_URL}pcm-worklet.js`)
      if (generation !== this.generation || this.isClosed()) return
      const source = context.createMediaStreamSource(stream)
      const capture = new AudioWorkletNode(context, 'pcm-capture')
      this.source = source; this.capture = capture
      capture.port.onmessage = ({ data }) => {
        if (!(data instanceof ArrayBuffer) || this.phase === 'closed' || this.phase === 'awake' || this.phase === 'idle') return
        if ((this.suppressed && this.phase === 'standby') || this.promptPlaying) return
        const pcm = new Int16Array(data)
        if (!this.buffer.push(pcm)) { this.dispose(); this.onError('唤醒后连接过慢，请重试。'); return }
        if (this.phase === 'standby') this.kws.push(pcm)
      }
      this.phase = 'standby'; this.kws.reset(); if (this.suppressed) this.kws.pause()
      source.connect(capture); capture.connect(context.destination)
    } catch {
      if (generation === this.generation && !this.isClosed()) { this.dispose(); this.onError('无法启动本地唤醒收音，请重试。') }
    }
  }
  /** Preserve the wake pre-roll, but discard microphone frames during the acknowledgement. */
  setPromptPlaying(value: boolean) { this.promptPlaying = value }
  setSuppressed(value: boolean) {
    clearTimeout(this.releaseTimer)
    if (value) {
      this.suppressed = true
      if (this.phase === 'standby') { this.kws.pause(); this.buffer.clear() }
    } else {
      // Keep a tail window so the assistant cannot wake itself after playback.
      this.releaseTimer = setTimeout(() => {
        this.suppressed = false
        if (this.phase === 'standby') { this.buffer.clear(); this.kws.reset() }
      }, 1200)
    }
  }
  dispose() {
    this.phase = 'closed'; clearTimeout(this.releaseTimer)
    this.closeCapture(); this.buffer.clear(); this.kws?.close()
  }
}
