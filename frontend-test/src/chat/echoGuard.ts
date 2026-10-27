/** Suppress residual ASR echo only against recently audible TTS phrases. */
function normalized(text: string) {
  const chars: string[] = []; const ends: number[] = []
  let offset = 0
  for (const char of text) {
    offset += char.length
    if (/[\p{L}\p{N}]/u.test(char)) { chars.push(char.toLowerCase()); ends.push(offset) }
  }
  return { text: chars.join(''), ends }
}
const command = /^(?:停|暂停|停止|别说|不要说|等一下|等等|打住|不是|不对|我说|换个|重新|继续|取消)/
export function filterEcho(text: string, references: string[]): string {
  const candidate = normalized(text)
  if (!candidate.text || command.test(candidate.text)) return text
  const refs = references.map(value => normalized(value).text).filter(Boolean)
  if (!refs.length) return text
  const joined = refs.join('')
  if (joined.includes(candidate.text)) return ''
  // Tolerate an isolated ASR substitution, including a phrase-ending homophone.
  if (candidate.text.length >= 6) {
    for (const ref of [...refs, joined]) {
      const width = candidate.text.length
      for (let start = 0; start + width <= ref.length; start++) {
        const window = ref.slice(start, start + width)
        let matches = 0
        for (let i = 0; i < width; i++) if (window[i] === candidate.text[i]) matches++
        if (matches / width >= 0.88 && (window.slice(-2) === candidate.text.slice(-2) ||
            (width === ref.length && width - matches <= 1))) return ''
      }
    }
  }
  // Preserve a new user request after a residual echoed prefix, including punctuation.
  for (let size = Math.min(candidate.text.length - 1, joined.length); size >= 4; size--) {
    if (joined.includes(candidate.text.slice(0, size))) {
      return text.slice(candidate.ends[size - 1]).replace(/^[\p{P}\s]+/u, '')
    }
  }
  return text
}
