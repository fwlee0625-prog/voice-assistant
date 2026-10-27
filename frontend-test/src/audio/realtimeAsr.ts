import { createPcmUpload } from './pcmUpload.ts'
import { createSileroActivity } from './sileroActivity.ts'
import { createVoiceActivity } from './voiceActivity.ts'

export interface InteractionEvent {
  type: 'interaction'; index: number; final: boolean; owner?: number
  parts: { id: number; speakerId: number; text: string; action: 'accept' | 'ignore' | 'wait' | 'stop' | 'end_conversation' | 'disable_listening'; reason: string }[]
}
export interface SpeakerSegment {
  speaker_id: number
  text: string
  stable_flag?: number
}

export interface AsrState {
  status: 'idle' | 'connecting' | 'listening' | 'finishing' | 'done' | 'error'
  segments: Record<number, { text: string; final: boolean; speakers?: SpeakerSegment[] }>
  error: string
  vadStatus?: 'loading' | 'silero' | 'fallback'
}

export function transcriptText(state: AsrState) {
  return Object.entries(state.segments)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([, segment]) => segment.text)
    .join('')
}

// IDs are scoped to one recording; unknown/zero IDs must never be labelled as a person.
export function speakerLabel(id: number) {
  return Number.isInteger(id) && id > 0 ? `说话人 ${id}` : '待区分'
}

export function transcriptRows(state: AsrState) {
  return Object.entries(state.segments)
    .sort(([a], [b]) => Number(a) - Number(b))
    .flatMap(([index, segment]) => {
      const speakers = segment.speakers?.filter((part) => part.text.trim())
      const parts = speakers?.length ? speakers : [{ speaker_id: -1, text: segment.text }]
      return parts
        .filter((part) => part.text.trim())
        .map((part, offset) => ({
          key: `${index}-${offset}`,
          speakerId: part.speaker_id,
          label: speakerLabel(part.speaker_id),
          text: part.text,
          final: segment.final,
        }))
    })
}

export class RealtimeAsr {
  private socket: WebSocket | null = null
  private context: AudioContext | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private capture: AudioWorkletNode | null = null
  private timer: ReturnType<typeof setTimeout> | undefined
  private cancelled = false
  private activity: ReturnType<typeof createVoiceActivity>
  private upload: ReturnType<typeof createPcmUpload> | undefined
  private catchingUp = false
  private deferredInteractions: InteractionEvent[] = []
  private lastSpeech = false
  private lastSilenceMs = 320
  private activityEpoch = 0
  private lastPlayback = 0
  private flushResolve: (() => void) | undefined

  constructor(
    private state: AsrState,
    private onResult?: (index: number, text: string, final: boolean) => void,
    private onDone?: () => void,
    private onActivity?: (speaking: boolean, silenceMs?: number) => void,
    private onInteraction?: (event: InteractionEvent) => void,
    private onEndpoint?: (probability?: number) => void,
    private playback?: () => { active: boolean; references: string[]; question: string },
  ) { this.activity = createVoiceActivity(speaking => this.activityChanged(speaking, 240)) }

  private activityChanged(speaking: boolean, silenceMs: number) {
    if (this.cancelled) return
    if (speaking) this.activityEpoch++
    this.sendPlayback()
    if (this.socket?.readyState === WebSocket.OPEN && this.state.status === 'listening')
      this.socket.send(JSON.stringify({ type: 'activity', speaking, epoch: this.activityEpoch }))
    this.lastSpeech = speaking; this.lastSilenceMs = silenceMs
    if (!this.catchingUp) this.onActivity?.(speaking, silenceMs)
  }
  private sendPlayback() {
    if (this.socket?.readyState === WebSocket.OPEN && this.playback) {
      const context = this.playback()
      this.socket.send(JSON.stringify({ type: 'playback', active: context.active,
        references: context.references.slice(-6).map(text => text.slice(0, 120)), question: context.question.slice(-300) }))
      this.lastPlayback = performance.now()
    }
  }

  getStatus(): AsrState['status'] {
    return this.state.status
  }

  private releaseAudio() {
    this.deferredInteractions = []
    this.upload?.dispose(); this.upload = undefined
    this.activity.reset()
    this.source?.disconnect()
    this.capture?.disconnect()
    this.capture?.port.close()
    this.source = null
    this.capture = null
    void this.context?.close().catch(() => {})
    this.context = null
  }

  private fail(message: string) {
    if (this.cancelled || this.state.status === 'done') return
    this.state.status = 'error'
    this.state.error = message
    clearTimeout(this.timer)
    this.flushResolve?.()
    this.releaseAudio()
    this.socket?.close()
  }

  async start(stream: MediaStream, takePreroll?: () => Int16Array[], entry?: 'manual' | 'wake') {
    this.state.status = 'connecting'
    try {
      // Create/resume the audio context from the recording user action.
      this.context = new AudioContext({ sampleRate: 16000 })
      await this.context.resume()
      await this.context.audioWorklet.addModule(`${import.meta.env.BASE_URL}pcm-worklet.js`)
      if (this.cancelled) return
      const url = new URL('/api/voice/asr/realtime', location.href)
      url.searchParams.set('turns', '1')
      if (entry) url.searchParams.set('entry', entry)
      url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
      const socket = new WebSocket(url)
      this.socket = socket
      await new Promise<void>((resolve, reject) => {
        this.timer = setTimeout(() => {
          this.fail('实时识别连接超时，原录音仍会保存')
          reject(new Error('timeout'))
        }, 12000)
        socket.onmessage = ({ data }) => {
          if (this.cancelled) return
          try {
            const event = JSON.parse(data)
            if (event.type === 'ready') {
              clearTimeout(this.timer)
              this.state.status = 'listening'
              resolve()
            } else if (event.type === 'result') {
              const previous = this.state.segments[event.index]
              if (!previous?.final || event.final === true) {
                this.state.segments[event.index] = {
                  text: event.text,
                  final: event.final,
                  // Later final frames can refine speaker attribution for an existing sentence.
                  speakers:
                    event.speaker_segments ??
                    (previous?.text === event.text ? previous?.speakers : undefined),
                }
                this.onResult?.(event.index, event.text, event.final === true)
              }
            } else if (event.type === 'interaction') {
              if (this.catchingUp) {
                if (this.deferredInteractions.length >= 128) { this.fail('语音决策积压，请重新开始对话。'); return }
                this.deferredInteractions.push(event)
              } else this.onInteraction?.(event)
            } else if (event.type === 'endpoint') {
              if (!this.catchingUp && event.epoch === this.activityEpoch) this.onEndpoint?.(event.probability)
            } else if (event.type === 'done') {
              this.state.status = 'done'
              this.onDone?.()
              clearTimeout(this.timer)
              this.releaseAudio()
              socket.close()
            } else if (event.type === 'error') {
              this.fail(event.error || '实时识别失败')
              reject(new Error('ASR error'))
            }
          } catch {
            this.fail('实时识别返回了无效数据')
            reject(new Error('invalid response'))
          }
        }
        socket.onerror = () => {
          this.fail('无法连接实时识别服务，原录音仍会保存')
          reject(new Error('connection failed'))
        }
        socket.onclose = () => {
          if (!this.cancelled && this.state.status !== 'done' && this.getStatus() !== 'error') {
            this.fail('实时识别连接中断，已收到的文字和原录音仍会保留')
          }
          reject(new Error('connection closed'))
        }
      })
      if (this.cancelled || !this.context || this.getStatus() !== 'listening') return
      this.state.vadStatus = 'loading'
      const fallback = () => {
        if (this.cancelled || this.state.status !== 'listening') return
        this.activity = createVoiceActivity(speaking => this.activityChanged(speaking, 240))
        this.state.vadStatus = 'fallback'
      }
      try {
        const silero = await createSileroActivity(speaking => this.activityChanged(speaking, 320), fallback)
        if (this.cancelled || !this.context || this.getStatus() !== 'listening') { silero.reset(); return }
        this.activity = silero
        this.state.vadStatus = 'silero'
      } catch { fallback() }
      if (this.cancelled || !this.context || this.getStatus() !== 'listening') return
      this.source = this.context.createMediaStreamSource(stream)
      this.capture = new AudioWorkletNode(this.context, 'pcm-capture')
      this.capture.port.onmessage = ({ data }) => {
        if (data === 'flushed') {
          this.flushResolve?.()
        } else if (data instanceof ArrayBuffer && socket.readyState === WebSocket.OPEN) {
          this.upload?.push(new Int16Array(data))
        }
      }
      this.upload = createPcmUpload(pcm => {
        if (this.cancelled || socket.readyState !== WebSocket.OPEN) return false
        if (socket.bufferedAmount > 16000) return false
        if (this.state.status === 'listening') this.activity.push(pcm, this.context?.sampleRate || 16000)
        if (performance.now() - this.lastPlayback > 250) this.sendPlayback()
        socket.send(pcm.slice().buffer)
        return true
      }, active => {
        this.catchingUp = active
        if (!active) {
          const events = this.deferredInteractions; this.deferredInteractions = []
          for (const event of events) this.onInteraction?.(event)
        }
        this.onActivity?.(active ? true : this.lastSpeech, this.lastSilenceMs)
      }, message => this.fail(message))
      this.upload.start(takePreroll?.() || [])
      this.source.connect(this.capture)
      // The processor outputs silence; connecting ensures browsers keep rendering it.
      this.capture.connect(this.context.destination)
    } catch {
      if (!this.cancelled && this.getStatus() !== 'error') {
        this.fail('无法启动实时识别，请使用支持 AudioWorklet 的浏览器；原录音仍会保存')
      }
    }
  }

  async finish() {
    if (this.getStatus() !== 'listening') return
    this.state.status = 'finishing'
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, 250)
      this.flushResolve = () => {
        clearTimeout(timeout)
        resolve()
      }
      this.capture?.port.postMessage('flush')
    })
    this.flushResolve = undefined
    await this.upload?.drain()
    this.releaseAudio()
    if (this.getStatus() === 'error' || this.cancelled) return
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: 'end' }))
      this.timer = setTimeout(() => this.fail('最终识别结果等待超时，已收到的文字仍会保留'), 18000)
    }
  }

  dispose() {
    this.cancelled = true
    clearTimeout(this.timer)
    this.flushResolve?.()
    this.releaseAudio()
    this.socket?.close()
  }
}
