/** Parse SSE across arbitrary UTF-8/network boundaries, with bounded frames. */
export async function* readSse(response: Response): AsyncGenerator<string> {
  if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream'))
    throw new Error('Expected SSE response');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let match: RegExpExecArray | null;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        if (match.index > 2 * 1024 * 1024) throw new Error('SSE frame too large');
        const frame = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:'))
          .map(line => line.slice(5).replace(/^ /, '')).join('\n');
        if (data) yield data;
      }
      if (buffer.length > 2 * 1024 * 1024) throw new Error('SSE frame too large');
      if (done) {
        if (buffer.trim()) throw new Error('Truncated SSE frame');
        break;
      }
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
