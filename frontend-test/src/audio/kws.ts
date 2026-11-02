/** Browser-only keyword spotting; no recognizer API or audio upload is involved. */
export type WakeKeyword = { text: string; phonemes: string; variants?: string[] }
export const defaultWakeKeywords: WakeKeyword[] = [
  { text: '你好助手', phonemes: 'n ǐ h ǎo zh ù sh ǒu' },
  { text: '台球助手', phonemes: 't ái q iú zh ù sh ǒu' },
]
export async function createKeywordSpotter(onWake: (keyword: string) => void, onError: (message: string) => void, signal?: AbortSignal, keywords: WakeKeyword[] = defaultWakeKeywords) {
  const worker = new Worker(new URL(import.meta.env.BASE_URL + 'kws-worker.js', location.origin))
  let disposed = false; let pending = 0
  const close = () => { disposed = true; worker.terminate() }
  const message = '本地唤醒模型加载或运行失败，请重试；仍可手动开始对话。'
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); close(); reject(new Error(message)) }, 30000)
      const aborted = () => { clearTimeout(timer); cleanup(); close(); reject(new Error('唤醒加载已取消')) }
      const cleanup = () => signal?.removeEventListener('abort', aborted)
      signal?.addEventListener('abort', aborted, { once: true })
      if (signal?.aborted) { aborted(); return }
      worker.onerror = () => { clearTimeout(timer); cleanup(); close(); reject(new Error(message)) }
      worker.onmessage = ({ data }) => {
        if (data.type === 'ready') { clearTimeout(timer); cleanup(); resolve() }
        else if (data.type === 'error') { clearTimeout(timer); cleanup(); close(); reject(new Error(data.message ? `${message}（${data.message}）` : message)) }
      }
    worker.postMessage({ type: 'init', assets: new URL(import.meta.env.BASE_URL + 'kws/', location.origin).href, keywords })
    })
  } catch (error) { close(); throw error }
  worker.onerror = () => { if (!disposed) { close(); onError(message) } }
  worker.onmessage = ({ data }) => {
    if (disposed) return
    if (data.type === 'processed') pending = Math.max(0, pending - 1)
    if (data.type === 'wake' && keywords.some(keyword => keyword.text === data.keyword)) onWake(data.keyword)
    if (data.type === 'error') { close(); onError(message) }
  }
  return {
    push(pcm: Int16Array) {
      if (disposed) return
      if (pending >= 32) { close(); onError('设备处理唤醒音频较慢，请关闭其他高负载页面后重试。'); return }
      const copy = pcm.slice(); pending++
      worker.postMessage({ type: 'audio', audio: copy.buffer }, [copy.buffer])
    },
    reset() { if (!disposed) worker.postMessage({ type: 'reset' }) },
    pause() { if (!disposed) worker.postMessage({ type: 'pause' }) },
    close,
  }
}
