/** Incremental phrase boundaries: early first phrase, longer later phrases. */
export interface SpeechSentence { text: string; start: number; end: number }
export function createSentenceSplitter() {
  let pending = ''; let first = true; let offset = 0;
  return {
    push(delta: string, flush = false): SpeechSentence[] {
      pending += delta;
      const result: SpeechSentence[] = [];
      while (pending) {
        const limit = first ? 24 : 80;
        const boundary = /[。！？!?；;\n，,：:]/.exec(pending);
        let end = boundary ? boundary.index + 1 : 0;
        if (!end && pending.length >= limit) end = limit;
        if (!end && flush) end = pending.length;
        if (!end) break;
        // Never cut between the UTF-16 halves of a character at the length limit.
        if (end < pending.length && /[\uD800-\uDBFF]/.test(pending[end - 1]!)) end++;
        const sentence = pending.slice(0, end).replace(/[*#`]/g, '').trim();
        pending = pending.slice(end);
        if (/[\p{L}\p{N}]/u.test(sentence)) { result.push({ text: sentence, start: offset, end: offset + end }); first = false; }
        offset += end;
      }
      return result;
    },
  };
}
