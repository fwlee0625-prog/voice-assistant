/** Silero runs in a dedicated Worker, sharing existing PCM instead of opening a mic. */
export function createProbabilityActivity(onChange: (speaking: boolean) => void) {
  let speaking = false; let positive = 0; let quiet = 0
  return {
    push(probability: number) {
      if (!Number.isFinite(probability) || probability < 0 || probability > 1) throw new Error('Invalid probability')
      if (probability >= 0.5) { positive++; quiet = 0 }
      else if (probability < 0.35) { positive = 0; quiet++ }
      if (!speaking && positive >= 5) { speaking = true; onChange(true) }
      if (speaking && quiet >= 10) { speaking = false; positive = 0; onChange(false) }
    },
    reset() { if (speaking) onChange(false); speaking = false; positive = 0; quiet = 0 },
  }
}
export async function createSileroActivity(onChange: (speaking: boolean) => void, onError: () => void) {
  const worker = new Worker(new URL('./silero.worker.ts', import.meta.url), { type: 'module' })
  const activity = createProbabilityActivity(onChange)
  let disposed = false; let outstanding = 0; let pending: number[] = []
  const close = () => { if (disposed) return; disposed = true; worker.terminate(); activity.reset(); pending = [] }
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { close(); reject(new Error('Silero initialization timed out')) }, 15000)
      worker.onerror = () => { clearTimeout(timer); close(); reject(new Error('Silero initialization failed')) }
      worker.onmessage = ({ data }) => {
        if (data.type === 'ready') { clearTimeout(timer); resolve() }
        if (data.type === 'error') { clearTimeout(timer); close(); reject(new Error('Silero initialization failed')) }
      }
      worker.postMessage({ type: 'init', assets: new URL(import.meta.env.BASE_URL + 'vad/', location.origin).href })
    })
  } catch (error) { close(); throw error }
  worker.onerror = () => { close(); onError() }
  worker.onmessage = ({ data }) => {
    if (disposed) return
    if (data.type === 'error') { close(); onError(); return }
    if (data.type === 'probability') { outstanding--; activity.push(data.probability) }
  }
  return {
    push(pcm: Int16Array) {
      if (disposed) return
      for (const sample of pcm) pending.push(sample / 32768)
      while (pending.length >= 512) {
        if (outstanding >= 16) { close(); onError(); return }
        const frame = Float32Array.from(pending.splice(0, 512))
        outstanding++; worker.postMessage({ type: 'frame', audio: frame.buffer }, [frame.buffer])
      }
    },
    reset: close,
  }
}
