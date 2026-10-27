/** Lightweight activity detector on post-browser-AEC PCM, not speaker identification. */
export function createVoiceActivity(onChange: (speaking: boolean) => void) {
  let noise = 0.003
  let voicedMs = 0
  let silentMs = 0
  let speaking = false
  return {
    push(pcm: Int16Array, sampleRate = 16000) {
      if (!pcm.length) return
      const ms = pcm.length / sampleRate * 1000
      let energy = 0
      for (const sample of pcm) energy += (sample / 32768) ** 2
      const rms = Math.sqrt(energy / pcm.length)
      const threshold = Math.max(0.012, noise * (speaking ? 2 : 3.5))
      if (rms >= threshold) {
        voicedMs += ms; silentMs = 0
        if (!speaking && voicedMs >= 160) { speaking = true; onChange(true) }
      } else {
        if (!speaking) noise = Math.min(0.015, noise * 0.98 + rms * 0.02)
        silentMs += ms
        // One quiet 40ms frame should not erase a nearly complete onset.
        if (silentMs >= 80) voicedMs = 0
        if (speaking && silentMs >= 240) { speaking = false; voicedMs = 0; onChange(false) }
      }
    },
    reset() {
      if (speaking) onChange(false)
      speaking = false; voicedMs = 0; silentMs = 0; noise = 0.003
    },
  }
}
