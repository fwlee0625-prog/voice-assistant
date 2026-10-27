/** Silence budget after the last speech activity, always gated by ASR final. */
export function endpointDelay(text: string) {
  const value = text.trim()
  if (/[，,、：:]$/.test(value) || /(?:然后|因为|所以|如果|但是|还有|以及|或者|比如|就是|我想|帮我|等一下|和)[。！？!?\s]*$/.test(value)) return 1300
  if (/[？?！!]$/.test(value) || /(?:吗|呢|么)[。\s]*$/.test(value)) return 450
  if (value.replace(/[\p{P}\s]/gu, '').length < 4) return 900
  return /[。.]$/.test(value) ? 550 : 750
}
