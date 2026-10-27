import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

function harness() {
  const sockets = []
  const contexts = []
  const captures = []
  class Socket {
    static OPEN = 1
    readyState = 1
    bufferedAmount = 0
    sent = []
    constructor() {
      sockets.push(this)
    }
    send(value) {
      this.sent.push(value)
    }
    close() {
      this.readyState = 3
      this.onclose?.()
    }
    event(value) {
      this.onmessage({ data: JSON.stringify(value) })
    }
  }
  class Context {
    audioWorklet = { addModule: async () => {} }
    destination = {}
    constructor(options) {
      contexts.push(this)
      assert.equal(options.sampleRate, 16000)
    }
    async resume() {}
    async close() {
      this.closed = true
    }
    createMediaStreamSource() {
      return { connect() {}, disconnect() {} }
    }
  }
  class Capture {
    port = {
      close() {},
      postMessage: () => {
        this.port.onmessage({ data: new ArrayBuffer(4) })
        this.port.onmessage({ data: 'flushed' })
      },
    }
    constructor() {
      captures.push(this)
    }
    connect() {}
    disconnect() {}
  }
  const source = fs
    .readFileSync(new URL('../src/audio/realtimeAsr.ts', import.meta.url), 'utf8')
    .replace('import.meta.env.BASE_URL', "'/'")
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const sandbox = {
    exports: {},
    URL,
    location: { href: 'http://localhost:5178/record', protocol: 'http:' },
    WebSocket: Socket,
    AudioContext: Context,
    AudioWorkletNode: Capture,
    setTimeout,
    clearTimeout,
  }
  vm.runInNewContext(compiled, sandbox)
  const { RealtimeAsr, transcriptText, transcriptRows } = sandbox.exports
  const state = () => ({ status: 'idle', segments: {}, error: '' })
  return { RealtimeAsr, transcriptText, transcriptRows, sockets, contexts, captures, state }
}

async function connect(h, state) {
  const session = new h.RealtimeAsr(state)
  const pending = session.start({})
  await new Promise(setImmediate)
  h.sockets.at(-1).event({ type: 'ready' })
  await pending
  return session
}

test('interim replaces sentence; stable sentences survive duplicate events', async () => {
  const h = harness()
  const state = h.state()
  const session = await connect(h, state)
  const socket = h.sockets[0]
  socket.event({ type: 'result', index: 0, text: '台', final: false })
  socket.event({ type: 'result', index: 0, text: '台球。', final: true })
  socket.event({ type: 'result', index: 0, text: '重复', final: false })
  socket.event({ type: 'result', index: 1, text: '你好。', final: true })
  assert.equal(h.transcriptText(state), '台球。你好。')
  await session.finish()
  assert.equal(socket.sent[0].byteLength, 4, 'tail PCM sent before end')
  assert.equal(socket.sent[1], '{"type":"end"}')
  assert.equal(state.status, 'finishing')
  socket.event({ type: 'done' })
  assert.equal(state.status, 'done')
  assert.equal(h.contexts[0].closed, true)
  session.dispose()
})

test('late final for previous recording cannot alter next recording', async () => {
  const h = harness()
  const first = h.state()
  const second = h.state()
  const one = await connect(h, first)
  await one.finish()
  const two = await connect(h, second)
  h.sockets[0].event({ type: 'result', index: 0, text: '上一条', final: true })
  h.sockets[0].event({ type: 'done' })
  h.sockets[1].event({ type: 'result', index: 0, text: '下一条', final: false })
  assert.equal(h.transcriptText(first), '上一条')
  assert.equal(h.transcriptText(second), '下一条')
  one.dispose()
  two.dispose()
})

test('cloud configuration failure releases audio and preserves explicit error', async () => {
  const h = harness()
  const state = h.state()
  const session = new h.RealtimeAsr(state)
  const pending = session.start({})
  await new Promise(setImmediate)
  h.sockets[0].event({ type: 'error', error: '请配置 backend/.env' })
  await pending
  assert.equal(state.status, 'error')
  assert.equal(state.error, '请配置 backend/.env')
  assert.equal(h.contexts[0].closed, true)
  session.dispose()
})

test('worklet emits 40ms PCM16 frames and flushes tail exactly once', () => {
  let Processor
  const messages = []
  class Base {
    port = { postMessage: (data) => messages.push(data) }
  }
  vm.runInNewContext(
    fs.readFileSync(new URL('../public/pcm-worklet.js', import.meta.url), 'utf8'),
    {
      AudioWorkletProcessor: Base,
      registerProcessor: (_, klass) => {
        Processor = klass
      },
    },
  )
  const capture = new Processor()
  for (let i = 0; i < 6; i++) capture.process([[new Float32Array(128).fill(0.5)]])
  assert.equal(messages[0].byteLength, 1280)
  assert.equal(new Int16Array(messages[0])[0], 16384)
  capture.port.onmessage({ data: 'flush' })
  assert.equal(messages[1].byteLength, 256)
  assert.equal(messages[2], 'flushed')
  capture.process([[new Float32Array(128)]])
  assert.equal(messages.length, 3)
})

test('record page saves original audio even when cloud ASR is unavailable', async () => {
  const view = fs.readFileSync(new URL('../src/views/RecordView.vue', import.meta.url), 'utf8')
  const script = view.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1]
  const compiled = ts.transpileModule(
    script + '\nexport { startRecording, stopRecording, recordings, elapsedMs, isRecording };',
    {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    },
  ).outputText
  let mediaRecorder
  let unmount
  const track = {
    stopped: false,
    stop() {
      this.stopped = true
    },
  }
  class Recorder {
    static isTypeSupported() {
      return true
    }
    state = 'inactive'
    mimeType = 'audio/webm;codecs=opus'
    listeners = {}
    constructor() {
      mediaRecorder = this
    }
    addEventListener(name, callback) {
      this.listeners[name] = callback
    }
    start() {
      this.state = 'recording'
    }
    stop() {
      this.state = 'inactive'
      this.listeners.stop()
    }
  }
  class UnavailableAsr {
    constructor(state) {
      this.state = state
    }
    async start() {
      this.state.status = 'error'
      this.state.error = '缺少云端凭证'
    }
    async finish() {}
    dispose() {}
    getStatus() {
      return this.state.status
    }
  }
  const vue = {
    ref: (value) => ({ value }),
    reactive: (value) => value,
    computed: (getter) => ({
      get value() {
        return getter()
      },
    }),
    onMounted() {},
    onBeforeUnmount: (callback) => {
      unmount = callback
    },
  }
  const sandbox = {
    exports: {},
    require: (name) =>
      name === 'vue' ? vue : { RealtimeAsr: UnavailableAsr, transcriptRows: () => [] },
    navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [track] }) } },
    window: { setInterval: () => 1, clearInterval() {} },
    performance: { now: () => 0 },
    MediaRecorder: Recorder,
    Blob,
    URL,
    DOMException,
    cancelAnimationFrame() {},
    setTimeout,
    clearTimeout,
  }
  vm.runInNewContext(compiled, sandbox)
  const page = sandbox.exports
  await page.startRecording()
  assert.equal(page.isRecording.value, true)
  const original = new Blob(['original microphone bytes'], { type: 'audio/webm' })
  mediaRecorder.listeners.dataavailable({ data: original })
  page.elapsedMs.value = 1400
  page.stopRecording()
  assert.equal(page.isRecording.value, false)
  assert.equal(page.recordings.value.length, 1)
  const item = page.recordings.value[0]
  assert.equal(await item.blob.text(), await original.text())
  assert.equal(item.transcript.status, 'error')
  assert.equal(item.duration, 1.4)
  assert.equal(track.stopped, true)
  assert.match(item.url, /^blob:/)
  unmount()
})

test('speaker snapshots replace interim rows and final attribution can be refined', async () => {
  const h = harness()
  const state = h.state()
  const session = await connect(h, state)
  const socket = h.sockets[0]
  socket.event({ type: 'result', index: 0, text: '你好，我来。', final: false })
  assert.equal(h.transcriptRows(state)[0].label, '待区分')
  socket.event({
    type: 'result',
    index: 0,
    text: '你好，我来。',
    final: true,
    speaker_segments: [
      { speaker_id: 1, text: '你好。' },
      { speaker_id: 2, text: '我来。' },
    ],
  })
  assert.deepEqual(
    Array.from(h.transcriptRows(state), (row) => row.label),
    ['说话人 1', '说话人 2'],
  )
  assert.equal(
    h
      .transcriptRows(state)
      .map((row) => row.text)
      .join(''),
    '你好。我来。',
  )
  // Reclassification of a finalized sentence must update labels without appending duplicates.
  socket.event({
    type: 'result',
    index: 0,
    text: '你好，我来。',
    final: true,
    speaker_segments: [
      { speaker_id: 2, text: '你好。' },
      { speaker_id: 1, text: '我来。' },
    ],
  })
  assert.deepEqual(
    Array.from(h.transcriptRows(state), (row) => row.label),
    ['说话人 2', '说话人 1'],
  )
  assert.equal(h.transcriptRows(state).length, 2)
  socket.event({
    type: 'result',
    index: 1,
    text: '还未确认',
    final: false,
    speaker_segments: [{ speaker_id: 0, text: '还未确认' }],
  })
  assert.equal(h.transcriptRows(state)[2].label, '待区分')
  session.dispose()
})
