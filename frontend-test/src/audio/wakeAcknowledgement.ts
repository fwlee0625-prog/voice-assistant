import { prepareSpeechPlayback } from './speechPlayer.ts'

/** Preload from the user's enable gesture; each wake waits for actual playback end. */
export function createWakeAcknowledgement() {
  let context: AudioContext | undefined
  let buffer: AudioBuffer | undefined
  let source: AudioBufferSourceNode | undefined
  let settle: (() => void) | undefined
  let closed = false
  const controller = new AbortController()
  function stop() {
    if (source) { source.onended = null; source.stop(); source.disconnect(); source = undefined }
    settle?.(); settle = undefined
  }
  return {
    async prepare(signal?: AbortSignal) {
      context = await prepareSpeechPlayback()
      const response = await fetch(`${import.meta.env.BASE_URL}audio/wake-ack.wav`, {
        signal: AbortSignal.any([controller.signal, ...(signal ? [signal] : []), AbortSignal.timeout(10000)]),
      })
      if (!response.ok) throw new Error('唤醒提示音加载失败，请重新开启语音唤醒。')
      const bytes = await response.arrayBuffer()
      if (bytes.byteLength > 256000) throw new Error('唤醒提示音文件异常。')
      const decoded = await context.decodeAudioData(bytes)
      if (closed || signal?.aborted) return
      if (!decoded.duration || decoded.duration > 3) throw new Error('唤醒提示音时长异常。')
      buffer = decoded
    },
    async play() {
      if (closed || !buffer || !context || context.state !== 'running') throw new Error('浏览器未允许提示音播放，请重新开启语音唤醒。')
      stop()
      const node = context.createBufferSource(); source = node
      node.buffer = buffer; node.connect(context.destination)
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => { clearTimeout(timer); node.onended = null; node.disconnect(); if (source === node) source = undefined; settle = undefined }
        const timer = setTimeout(() => { cleanup(); node.stop(); reject(new Error('唤醒提示音播放中断，请重新开启语音唤醒。')) }, 4000)
        settle = () => { cleanup(); resolve() }
        node.onended = settle
        try { node.start() } catch { cleanup(); reject(new Error('唤醒提示音无法播放。')) }
      })
    },
    dispose() { closed = true; controller.abort(); stop(); buffer = undefined },
  }
}
