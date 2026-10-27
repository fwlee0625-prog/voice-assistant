/** Bounded ordered PCM delivery, including wake pre-roll; steady live frames send immediately. */
export function createPcmUpload(send: (pcm: Int16Array) => boolean, catchup: (active: boolean) => void, fail: (message: string) => void) {
  const queue: Int16Array[] = []
  let timer: ReturnType<typeof setInterval> | undefined
  let closed = false
  let catchingUp = false
  let resolveDrain: (() => void) | undefined
  function endCatchup() { if (catchingUp) { catchingUp = false; catchup(false) } }
  function clear() { clearInterval(timer); timer = undefined; queue.length = 0; endCatchup(); resolveDrain?.(); resolveDrain = undefined }
  function pump() {
    if (closed) return
    for (let i = 0; i < 2 && queue.length; i++) {
      if (!send(queue[0]!)) return
      queue.shift()
    }
    if (!queue.length) { clearInterval(timer); timer = undefined; endCatchup(); resolveDrain?.(); resolveDrain = undefined }
  }
  function enqueue(pcm: Int16Array) {
    if (closed) return
    if (!pcm.length || pcm.length > 640 || queue.length >= 150) {
      closed = true; clear(); fail('语音发送积压，已停止识别，请重试。'); return
    }
    if (!queue.length && !timer && send(pcm)) return
    queue.push(pcm)
    if (!catchingUp) { catchingUp = true; catchup(true) }
    timer ??= setInterval(pump, 20)
  }
  return {
    start(frames: Int16Array[]) {
      if (frames.length > 150 || frames.some(frame => !frame.length || frame.length > 640)) { closed = true; clear(); fail('唤醒连接耗时过长，请重试。'); return }
      if (frames.length) {
        queue.push(...frames); catchingUp = true; catchup(true)
        timer ??= setInterval(pump, 20)
      }
    },
    push: enqueue,
    async drain() {
      if (!queue.length || closed) return
      await new Promise<void>(resolve => {
        const timeout = setTimeout(() => { closed = true; clear(); fail('等待语音发送完成超时'); resolve() }, 4000)
        resolveDrain = () => { clearTimeout(timeout); resolve() }
      })
    },
    dispose() { closed = true; clear() },
  }
}
