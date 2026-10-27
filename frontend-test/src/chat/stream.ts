export type ControlAction = 'pause_reply' | 'end_conversation' | 'disable_listening'
/** Normalized reply events; no provider-specific fields belong in this module. */
export type ReplyEvent = { type: 'control'; action: ControlAction }
  | { type: 'text'; delta: string }
  | { type: 'speech'; enabled: boolean }
  | { type: 'sentence_end'; sentenceId: number }
  | { type: 'audio'; data: string; sampleRate: number; format: 'pcm16'; channels: 1; text?: string; sentenceId?: number; start?: number; end?: number }
  | { type: 'filler_audio'; data: string; sampleRate: number; format: 'pcm16'; channels: 1; text: string }
  | { type: 'speech_error' | 'error'; error: string } | { type: 'done' }
export async function readReply(response: Response, receive: (event: ReplyEvent) => Promise<void>, signal?: AbortSignal) {
  if (!response.ok) {
    const data = await response.json()
    throw new Error(data.error || '模型回答失败')
  }
  if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream'))
    throw new Error('回答未返回流式数据')
  const reader = response.body.getReader()
  const abort = () => { void reader.cancel().catch(() => {}) }
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) abort()
  const decoder = new TextDecoder()
  let pending = ''; let finished = false
  try {
    while (true) {
      signal?.throwIfAborted()
      const { value, done } = await reader.read()
      signal?.throwIfAborted()
      pending += decoder.decode(value, { stream: !done })
      let match: RegExpExecArray | null
      while ((match = /\r?\n\r?\n/.exec(pending))) {
        const frame = pending.slice(0, match.index)
        pending = pending.slice(match.index + match[0].length)
        const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
        if (!data) continue
        const event = JSON.parse(data) as ReplyEvent
        if (event.type === 'error') throw new Error(event.error)
        if (event.type === 'done') { finished = true; break }
        if (!['control', 'speech', 'sentence_end', 'text', 'audio', 'filler_audio', 'speech_error'].includes(event.type)) throw new Error('回答事件格式无效')
        if (event.type === 'control' && !['pause_reply', 'end_conversation', 'disable_listening'].includes(event.action)) throw new Error('会话控制格式无效')
        await receive(event)
      }
      if (pending.length > 2 * 1024 * 1024) throw new Error('回答数据过大')
      if (finished || done) break
    }
    if (!finished) throw new Error('回答连接中断，请重试')
  } finally { signal?.removeEventListener('abort', abort); await reader.cancel().catch(() => {}); reader.releaseLock() }
}
