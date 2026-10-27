/** Two seconds before a trigger, then at most six seconds total through ASR startup. */
export function createWakeBuffer() {
  let frames: Int16Array[] = []
  let triggered = false
  return {
    push(pcm: Int16Array) {
      if (triggered && frames.length >= 150) return false
      frames.push(pcm)
      if (!triggered && frames.length > 50) frames.shift()
      return true
    },
    trigger() { if (triggered) return false; triggered = true; return true },
    take() { const value = frames; frames = []; triggered = false; return value },
    clear() { frames = []; triggered = false },
  }
}
