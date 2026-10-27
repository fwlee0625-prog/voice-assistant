/** Estimate character progress from audible PCM time, excluding buffering gaps. */
export interface SpeechSentence { sentenceId: number; start: number; end: number; text: string }
export type SpeechProgress = SpeechSentence & { progress: number }
export function createSpeechTimeline(receive: (progress: SpeechProgress) => void) {
  const sentences = new Map<number, SpeechSentence & {
    chunks: { start: number; end: number }[]; complete: boolean; progress: number
  }>()
  return {
    append(sentence: SpeechSentence, start: number, end: number) {
      let entry = sentences.get(sentence.sentenceId)
      if (!entry) {
        entry = { ...sentence, chunks: [], complete: false, progress: 0 }
        sentences.set(sentence.sentenceId, entry)
      }
      entry.chunks.push({ start, end })
    },
    end(sentenceId: number) { const entry = sentences.get(sentenceId); if (entry) entry.complete = true },
    complete() { for (const entry of sentences.values()) entry.complete = true },
    update(now: number) {
      for (const [id, entry] of sentences) {
        if (now < entry.chunks[0]!.start) continue
        const duration = entry.chunks.reduce((sum, chunk) => sum + chunk.end - chunk.start, 0)
        const elapsed = entry.chunks.reduce((sum, chunk) => sum + Math.max(0, Math.min(now, chunk.end) - chunk.start), 0)
        // Before the final chunk is known, reserve the tail and use a modest speaking rate.
        const estimate = entry.complete ? elapsed / duration
          : Math.min(0.9, elapsed / Math.max(duration, Array.from(entry.text).length / 5))
        const progress = Math.max(entry.progress, Math.min(1, estimate))
        if (progress > entry.progress) {
          entry.progress = progress
          receive({ sentenceId: id, start: entry.start, end: entry.end, text: entry.text, progress })
        }
        if (entry.complete && progress === 1) sentences.delete(id)
      }
      return sentences.size > 0
    },
    clear() { sentences.clear() },
  }
}
