import test from 'node:test'
import assert from 'node:assert/strict'
import { createConversation } from '../src/chat/conversation.ts'
import type { SpeechPlayer } from '../src/audio/speechPlayer.ts'
const reply = (text: string) => new Response('data: ' + JSON.stringify({ type: 'text', delta: text }) + '\n\ndata: {"type":"done"}\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
const tick = () => new Promise(resolve => setImmediate(resolve))
const player = (): SpeechPlayer => ({ append: async () => {}, finish: async () => {}, stop() {} })

test('wait prompt fires once, respects speech settings, and is cancelled by resuming or ending', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json({ tts: { enabled: false } }) })
  const chat = createConversation(player)
  const stop = (index: number) => chat.interaction({ type: 'interaction', index, final: true, owner: 1,
    parts: [{ id: index, speakerId: 1, text: '等等', action: 'stop', reason: 'user_wait' }] })
  stop(10); t.mock.timers.tick(1999); assert.equal(chat.state.turns.length, 0)
  t.mock.timers.tick(1); await tick()
  assert.equal(chat.state.turns[0]?.visibleAssistant, '我在，还需要什么帮助吗？')
  assert.equal(calls, 1)
  t.mock.timers.tick(60000); assert.equal(chat.state.turns.length, 1)
  stop(11); chat.cancelWait(); t.mock.timers.tick(30000); assert.equal(chat.state.turns.length, 1)
  stop(12)
  chat.interaction({ type: 'interaction', index: 13, final: true, owner: 1,
    parts: [{ id: 13, speakerId: 1, text: '继续', action: 'accept', reason: 'owner' }] })
  chat.dispose(); t.mock.timers.tick(30000); assert.equal(chat.state.turns.length, 1)
})

test('complete turns keep ordered context; duplicate final never repeats requests', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const bodies: { messages: { role: string; content: string }[] }[] = []
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(init.body as string)); return reply(`answer ${bodies.length}`)
  })
  const chat = createConversation(player)
  chat.accept(0, 'first'); chat.accept(0, 'first refined'); t.mock.timers.tick(750); await tick()
  chat.accept(0, 'first refined'); t.mock.timers.tick(2000); await tick()
  assert.equal(bodies.length, 1)
  chat.accept(1, 'second'); t.mock.timers.tick(750); await tick()
  assert.deepEqual(bodies[1]?.messages.map(m => m.content), ['first refined', 'answer 1', 'second'])
  assert.deepEqual(chat.state.turns.map(turn => turn.status), ['done', 'done']); chat.dispose()
})
test('new partial speech cancels old model, stops audio and discards late results', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const signals: AbortSignal[] = []; let resolveOld!: (response: Response) => void
  let stopped = 0
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    signals.push(init.signal as AbortSignal)
    if (signals.length === 1) return new Promise<Response>(resolve => { resolveOld = resolve })
    return reply('new answer')
  })
  const chat = createConversation(() => ({ ...player(), stop() { stopped++ } }))
  chat.accept(0, 'first question'); t.mock.timers.tick(750); await tick()
  chat.accept(1, 'second', false)
  assert.equal(signals[0]?.aborted, true); assert.equal(stopped, 1)
  assert.equal(chat.state.turns[0]?.status, 'interrupted')
  chat.accept(1, 'second question', true); t.mock.timers.tick(750); await tick()
  assert.equal(chat.state.turns[1]?.assistant, 'new answer')
  resolveOld(reply('late old answer')); await tick()
  assert.equal(chat.state.turns[0]?.assistant, '')
  assert.equal(chat.state.turns[0]?.status, 'interrupted')
  assert.equal(chat.state.turns[1]?.status, 'done'); chat.dispose()
})
test('interruption of a playing tail remains possible after model completion', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let stopped = false; let signal: AbortSignal | undefined; let release!: () => void
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => { signal = init.signal as AbortSignal; return reply('answer already generated') })
  const chat = createConversation(() => ({ ...player(), finish: async () => new Promise<void>(resolve => { release = resolve }), stop() { stopped = true; release() } }))
  chat.accept(0, 'first'); t.mock.timers.tick(750); await tick()
  assert.equal(chat.state.turns[0]?.status, 'done'); assert.equal(chat.state.answering, true)
  chat.accept(1, '等一下', false)
  assert.equal(stopped, true); assert.equal(signal?.aborted, true)
  assert.equal(chat.state.turns[0]?.status, 'interrupted'); await tick(); chat.dispose()
})
test('recent audible echo is ignored, but a novel suffix interrupts and is preserved', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let stream!: ReadableStreamDefaultController<Uint8Array>; let signal: AbortSignal | undefined
  let stopped = false; const duck: boolean[] = []; let reference = ['第一句回答内容']
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    signal = init.signal as AbortSignal
    return new Response(new ReadableStream({ start(c) { stream = c } }), { headers: { 'content-type': 'text/event-stream' } })
  })
  const chat = createConversation(() => ({ ...player(), isPlaying: () => true, referenceText: () => reference,
    duck: value => { duck.push(value) }, stop() { stopped = true } }))
  chat.accept(0, 'first'); t.mock.timers.tick(750); await tick()
  stream.enqueue(new TextEncoder().encode('data: {"type":"text","delta":"第一句回答内容"}\n\n')); await tick()
  chat.speechActivity(true); assert.equal(duck.at(-1), true)
  chat.accept(1, '第一句', false)
  reference = [] // A delayed final can arrive after the playback echo window expires.
  chat.accept(1, '第一句回答内容。', true)
  reference = ['第一句回答内容']
  assert.equal(stopped, false); assert.equal(signal?.aborted, false)
  assert.equal(chat.state.pendingText, ''); assert.equal(duck.at(-1), false)
  chat.accept(2, '第一句回答内容，换个问题', false)
  assert.equal(stopped, true); assert.equal(chat.state.pendingText, '换个问题')
  chat.accept(2, '第一句回答内容，换个问题。', true)
  assert.equal(chat.state.pendingText, '换个问题。')
  reference = []; chat.dispose(); await tick()
})
test('local speech blocks submission, final result uses existing silence budget', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const texts: string[] = []
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => { texts.push(JSON.parse(init.body as string).messages.at(-1).content); return reply('answer') })
  const chat = createConversation(player)
  chat.speechActivity(true); chat.accept(0, '怎么打？', true)
  t.mock.timers.tick(5000); assert.equal(texts.length, 0)
  chat.speechActivity(false) // Already 240ms of silence; a question needs 450ms total.
  t.mock.timers.tick(209); assert.equal(texts.length, 0)
  t.mock.timers.tick(1); await tick(); assert.deepEqual(texts, ['怎么打？'])
  chat.speechActivity(true); chat.accept(1, '第一句。', true); chat.speechActivity(false)
  t.mock.timers.tick(200); chat.speechActivity(true) // Resume before commit.
  t.mock.timers.tick(2000); assert.equal(texts.length, 1)
  chat.accept(2, '还有第二句。', false); chat.speechActivity(false)
  t.mock.timers.tick(3000); assert.equal(texts.length, 1) // Never promote an interim result.
  chat.accept(2, '还有第二句。', true); t.mock.timers.tick(120); await tick()
  assert.equal(texts[1], '第一句。还有第二句。'); chat.dispose()
})
test('unfinished phrases get more time, duplicate final does not postpone deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => { calls++; return reply('answer') })
  const chat = createConversation(player)
  chat.accept(0, '我想问，'); t.mock.timers.tick(900)
  chat.accept(0, '我想问，'); t.mock.timers.tick(399); assert.equal(calls, 0)
  t.mock.timers.tick(1); await tick(); assert.equal(calls, 1)
  chat.accept(1, '你好？'); t.mock.timers.tick(449); assert.equal(calls, 1)
  t.mock.timers.tick(1); await tick(); assert.equal(calls, 2); chat.dispose()
})
test('finish flushes finalized speech and disposal cancels work and timers', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let signal: AbortSignal | undefined; let calls = 0
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    calls++; signal = init.signal as AbortSignal
    return new Response(new ReadableStream({ start() {} }), { headers: { 'content-type': 'text/event-stream' } })
  })
  const chat = createConversation(player)
  chat.speechActivity(true); chat.accept(0, '完整句子。'); chat.accept(1, '未完成', false)
  chat.finish(); await tick(); assert.equal(calls, 1)
  assert.equal(chat.state.turns[0]?.user, '完整句子。')
  chat.accept(2, '新的句子。'); chat.dispose(); t.mock.timers.tick(3000); await tick()
  assert.equal(signal?.aborted, true); assert.equal(calls, 1)
})
test('failed answer blocks following work until retry; interruption is not an error', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => ++calls === 1 ? Response.json({ error: 'failure' }, { status: 502 }) : reply('answer'))
  const chat = createConversation(player)
  chat.accept(0, 'first'); t.mock.timers.tick(750); await tick()
  assert.equal(chat.state.turns[0]?.status, 'error')
  chat.accept(1, 'second'); t.mock.timers.tick(750); await tick(); assert.equal(calls, 1)
  chat.retry(0); await tick(); assert.equal(calls, 3)
  assert.deepEqual(chat.state.turns.map(turn => turn.status), ['done', 'done']); chat.dispose()
})
test('truncated reply preserves partial text, retry replaces rather than appends it', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => ++calls === 1
    ? new Response('data: {"type":"text","delta":"partial"}\n\n', { headers: { 'content-type': 'text/event-stream' } }) : reply('complete'))
  const chat = createConversation(player)
  chat.accept(0, 'first'); t.mock.timers.tick(750); await tick()
  assert.equal(chat.state.turns[0]?.assistant, 'partial'); assert.equal(chat.state.turns[0]?.status, 'error')
  chat.retry(0); await tick(); assert.equal(chat.state.turns[0]?.assistant, 'complete'); chat.dispose()
})

test('energy activity without meaningful ASR restores volume and leaves the reply intact', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const ducks: boolean[] = []; let signal: AbortSignal | undefined
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    signal = init.signal as AbortSignal
    return new Response(new ReadableStream({ start() {} }), { headers: { 'content-type': 'text/event-stream' } })
  })
  const chat = createConversation(() => ({ ...player(), isPlaying: () => true, duck: v => { ducks.push(v) } }))
  chat.accept(0, 'first'); t.mock.timers.tick(750); await tick()
  chat.speechActivity(true); assert.equal(ducks.at(-1), true)
  t.mock.timers.tick(1499); assert.equal(ducks.at(-1), true)
  t.mock.timers.tick(1); assert.equal(ducks.at(-1), false)
  assert.equal(signal?.aborted, false); assert.equal(chat.state.turns[0]?.status, 'loading')
  chat.dispose(); await tick()
})

test('speech progress controls visible text, completion reveals tail and full text stays in context', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let progress!: (event: import('../src/audio/speechPlayer.ts').SpeechProgress) => void
  let release!: () => void
  const bodies: { messages: { content: string }[] }[] = []
  const events = [
    { type: 'speech', enabled: true }, { type: 'text', delta: '**你好。**\n你好。尾巴' },
    { type: 'audio', data: 'AAA=', sampleRate: 24000, channels: 1, format: 'pcm16', text: '你好。', sentenceId: 0, start: 0, end: 5 },
    { type: 'sentence_end', sentenceId: 0 },
  ]
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(init.body as string))
    if (bodies.length > 1) return reply('第二轮')
    return new Response(events.map(e => 'data: ' + JSON.stringify(e) + '\n\n').join('') + 'data: {"type":"done"}\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
  })
  const ended: number[] = []
  const chat = createConversation(callback => {
    progress = callback
    return { ...player(), endSentence: id => { ended.push(id) }, finish: () => new Promise<void>(resolve => { release = resolve }) }
  })
  chat.accept(0, '第一问'); chat.finish(); await tick()
  const turn = chat.state.turns[0]!
  assert.equal(turn.assistant, '**你好。**\n你好。尾巴'); assert.equal(turn.visibleAssistant, '')
  assert.deepEqual(ended, [0])
  progress({ sentenceId: 0, start: 0, end: 5, text: '你好。', progress: 0.6 })
  assert.equal(turn.visibleAssistant, '**你')
  progress({ sentenceId: 0, start: 0, end: 5, text: '你好。', progress: 1 })
  assert.equal(turn.visibleAssistant, '**你好。')
  release(); await tick(); assert.equal(turn.visibleAssistant, turn.assistant)
  chat.accept(1, '第二问'); chat.finish(); await tick()
  assert.equal(bodies[1]?.messages[1]?.content, '**你好。**\n你好。尾巴')
  release(); await tick(); chat.dispose()
})
test('interrupt freezes visible text and rejects late progress updates', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let progress!: (event: import('../src/audio/speechPlayer.ts').SpeechProgress) => void
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({ start(c) {
    c.enqueue(new TextEncoder().encode('data: {"type":"speech","enabled":true}\n\ndata: {"type":"text","delta":"你好世界。"}\n\n'))
  } }), { headers: { 'Content-Type': 'text/event-stream' } }))
  const chat = createConversation(callback => { progress = callback; return player() })
  chat.accept(0, '问题'); chat.finish(); await tick()
  progress({ sentenceId: 0, start: 0, end: 5, text: '你好世界。', progress: 0.4 })
  assert.equal(chat.state.turns[0]?.visibleAssistant, '你好')
  chat.interrupt()
  progress({ sentenceId: 0, start: 0, end: 5, text: '你好世界。', progress: 1 })
  assert.equal(chat.state.turns[0]?.visibleAssistant, '你好'); chat.dispose(); await tick()
})
test('disabled speech and speech errors reveal streaming text without waiting for audio', async t => {
  for (const failure of [false, true]) {
    let stream!: ReadableStreamDefaultController<Uint8Array>
    t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({ start(c) { stream = c } }), { headers: { 'Content-Type': 'text/event-stream' } }))
    const chat = createConversation(player)
    chat.accept(0, '问题'); chat.finish(); await tick()
    const send = (event: unknown) => stream.enqueue(new TextEncoder().encode('data: ' + JSON.stringify(event) + '\n\n'))
    send({ type: 'speech', enabled: failure }); send({ type: 'text', delta: '第一句。' }); await tick()
    assert.equal(chat.state.turns[0]?.visibleAssistant, failure ? '' : '第一句。')
    if (failure) send({ type: 'speech_error', error: '合成失败' })
    send({ type: 'text', delta: '第二句。' }); await tick()
    assert.equal(chat.state.turns[0]?.visibleAssistant, '第一句。第二句。')
    send({ type: 'done' }); stream.close(); await tick(); chat.dispose()
  }
})

test('backend audience decisions hold unknown speakers, ignore bystanders and isolate takeover text', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => { calls++; return reply('answer') })
  const chat = createConversation(player)
  chat.enableTurnDetection()
  const event = (index: number, owner: number | undefined, parts: { id: number; speakerId: number; text: string; action: 'accept' | 'ignore' | 'wait' | 'stop'; reason: string }[]) => chat.interaction({ type: 'interaction', index, owner, final: true, parts })
  event(0, undefined, [{ id: 1, speakerId: -1, text: '你好助手', action: 'wait', reason: 'speaker_unstable' }])
  t.mock.timers.tick(3000); assert.equal(calls, 0)
  event(1, 1, [{ id: 2, speakerId: 1, text: '帮我开一号台。', action: 'accept', reason: 'addressed' }])
  event(2, 1, [{ id: 3, speakerId: 2, text: '今晚吃什么', action: 'ignore', reason: 'bystander' }])
  assert.equal(chat.state.pendingText, '帮我开一号台。')
  event(3, 2, [{ id: 4, speakerId: 2, text: '帮我开二号台。', action: 'accept', reason: 'addressed' }])
  assert.equal(chat.state.pendingText, '帮我开二号台。')
  t.mock.timers.tick(550); await tick(); assert.equal(calls, 1)
  assert.equal(chat.state.turns[0]?.user, '帮我开二号台。')
  event(3, 1, [{ id: 5, speakerId: 1, text: '迟到的说话人修订', action: 'accept', reason: 'owner' }])
  t.mock.timers.tick(3000); assert.equal(calls, 1)
  chat.dispose()
})
test('only confirmed owner recognition is displayed, with partial updates before submission', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => { calls++; return reply('answer') })
  const chat = createConversation(player)
  const update = (text: string, action: 'wait' | 'ignore' | 'accept', speakerId = -1, final = false) => chat.interaction({
    type: 'interaction', index: 0, final, owner: 1,
    parts: [{ id: 1, speakerId, text, action, reason: action === 'wait' ? 'speaker_unstable' : action === 'ignore' ? 'bystander' : 'owner' }],
  })
  update('这个球', 'wait')
  assert.equal(chat.state.pendingText, '')
  update('这个球怎么打', 'wait')
  assert.equal(chat.state.pendingText, '')
  t.mock.timers.tick(3000)
  assert.equal(calls, 0)
  assert.equal(chat.state.pendingText, '')
  update('这个球怎么打', 'ignore', 2)
  assert.equal(chat.state.pendingText, '')
  update('母球怎么', 'accept', 1)
  assert.equal(chat.state.pendingText, '母球怎么')
  update('母球怎么走位', 'accept', 1)
  assert.equal(chat.state.pendingText, '母球怎么走位')
  t.mock.timers.tick(3000)
  assert.equal(calls, 0)
  update('母球怎么走位？', 'accept', 1, true)
  t.mock.timers.tick(450); await tick()
  assert.equal(calls, 1)
  assert.equal(chat.state.turns[0]?.user, '母球怎么走位？')
  assert.equal(chat.state.pendingText, '')
  chat.dispose()
})

test('unconfirmed speech and echoes do not interrupt the active reply', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let requestSignal: AbortSignal | undefined
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    requestSignal = init.signal as AbortSignal
    return new Promise<Response>(() => {})
  })
  const chat = createConversation(() => ({ ...player(), referenceText: () => ['先保持出杆平稳'] }))
  chat.accept(0, '怎么出杆？')
  t.mock.timers.tick(450); await tick()
  chat.interaction({ type: 'interaction', index: 1, final: false, owner: 1,
    parts: [{ id: 10, speakerId: -1, text: '另外一个问题', action: 'wait', reason: 'speaker_unstable' }] })
  assert.equal(chat.state.pendingText, '')
  assert.equal(chat.state.turns.length, 1)
  assert.equal(requestSignal?.aborted, false)
  chat.interaction({ type: 'interaction', index: 1, final: false, owner: 1,
    parts: [{ id: 10, speakerId: -1, text: '先保持出杆平稳', action: 'wait', reason: 'speaker_unstable' }] })
  assert.equal(chat.state.pendingText, '')
  assert.equal(requestSignal?.aborted, false)
  chat.dispose()
  assert.equal(chat.state.pendingText, '')
})

test('Smart Turn confidence shortens complete turns, bounds incomplete turns, ignores speaking-time results', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => { calls++; return reply('answer') })
  const chat = createConversation(player); chat.enableTurnDetection()
  chat.speechActivity(true); chat.accept(0, '这个球怎么打？')
  chat.endpoint(0.99); assert.equal(chat.state.endpointMode, undefined)
  chat.speechActivity(false, 320); t.mock.timers.tick(100); assert.equal(calls, 0)
  chat.endpoint(0.9); t.mock.timers.tick(119); assert.equal(calls, 0)
  t.mock.timers.tick(1); await tick(); assert.equal(calls, 1)
  chat.speechActivity(true); chat.accept(1, '我想问这个问题'); chat.speechActivity(false, 320); chat.endpoint(0.1)
  t.mock.timers.tick(2179); assert.equal(calls, 1)
  t.mock.timers.tick(1); await tick(); assert.equal(calls, 2)
  chat.dispose()
})

test('accepted owner speech restores endpoint blocking after a bystander was ignored', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => { calls++; return reply('answer') })
  const chat = createConversation(player)
  chat.speechActivity(true)
  chat.interaction({ type: 'interaction', index: 0, final: false, owner: 1, parts: [{ id: 1, speakerId: 2, text: '闲聊', action: 'ignore', reason: 'bystander' }] })
  assert.equal(chat.state.userSpeaking, false)
  chat.interaction({ type: 'interaction', index: 1, final: true, owner: 1, parts: [{ id: 2, speakerId: 1, text: '帮我开一号台。', action: 'accept', reason: 'owner' }] })
  assert.equal(chat.state.userSpeaking, true)
  t.mock.timers.tick(2000); assert.equal(calls, 0)
  chat.speechActivity(false, 320); t.mock.timers.tick(230); await tick(); assert.equal(calls, 1)
  chat.dispose()
})
test('duplicate stop decisions cannot cancel a subsequent new answer', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const signals: AbortSignal[] = []
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    signals.push(init.signal as AbortSignal)
    return new Response(new ReadableStream({ start() {} }), { headers: { 'content-type': 'text/event-stream' } })
  })
  const chat = createConversation(player)
  chat.accept(0, 'first'); t.mock.timers.tick(750); await tick()
  const stop = { type: 'interaction' as const, index: 10, final: true, owner: 1,
    parts: [{ id: 10, speakerId: 1, text: '停止', action: 'stop' as const, reason: 'user_wait' }] }
  chat.interaction(stop); assert.equal(signals[0]?.aborted, true)
  chat.accept(1, 'second'); t.mock.timers.tick(750); await tick()
  chat.interaction(stop); assert.equal(signals[1]?.aborted, false)
  chat.dispose(); await tick()
})
test('the thinking interjection plays without revealing the answer text', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let stream!: ReadableStreamDefaultController<Uint8Array>
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({ start(c) { stream = c } }), { headers: { 'Content-Type': 'text/event-stream' } }))
  const appended: { text?: string; sentence?: unknown }[] = []
  const chat = createConversation(() => ({ ...player(), append: async (_data, _rate, _signal, text, sentence) => { appended.push({ text, sentence }) } }))
  chat.accept(0, '问题'); chat.finish(); await tick()
  const send = (event: unknown) => stream.enqueue(new TextEncoder().encode('data: ' + JSON.stringify(event) + '\n\n'))
  send({ type: 'speech', enabled: true })
  send({ type: 'filler_audio', data: 'AAA=', sampleRate: 24000, channels: 1, format: 'pcm16', text: '嗯……' })
  await tick()
  assert.deepEqual(appended.map(item => item.text), ['嗯……'])
  assert.equal(appended[0]?.sentence, undefined)
  assert.equal(chat.state.turns[0]?.visibleAssistant, '')
  send({ type: 'text', delta: '第一句。' }); await tick()
  assert.equal(chat.state.turns[0]?.visibleAssistant, '')
  send({ type: 'done' }); stream.close(); await tick(); chat.dispose()
})

test('explicit final end waits for farewell playback, ignores late ASR and closes exactly once', async t => {
  let endCount = 0; let release!: () => void; let ttsCalls = 0
  const order: string[] = []
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    assert.equal(url, '/api/tts'); ttsCalls++; order.push('tts')
    return new Response('data: {"type":"audio","data":"AAA=","sampleRate":24000,"channels":1,"format":"pcm16"}\n\ndata: {"type":"done"}\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
  })
  const chat = createConversation(() => ({ ...player(), append: async () => { order.push('audio') }, finish: async () => { order.push('playing'); await new Promise<void>(resolve => { release = resolve }) } }), () => { order.push('closed'); endCount++ })
  const end = (final: boolean) => chat.interaction({ type: 'interaction', index: 1, final, owner: 1,
    parts: [{ id: 1, speakerId: 1, text: '退出', action: 'end_conversation', reason: 'user_end' }] })
  end(false); assert.equal(ttsCalls, 0)
  end(true); await tick()
  assert.equal(chat.state.closing, true); assert.equal(endCount, 0)
  chat.accept(2, 'late text'); chat.finish(); chat.speechActivity(true); end(true)
  assert.equal(chat.state.pendingText, ''); assert.equal(ttsCalls, 1)
  release(); await tick()
  assert.deepEqual(order, ['tts', 'audio', 'playing', 'closed']); assert.equal(endCount, 1)
  assert.equal(chat.state.notice, '对话已结束'); chat.dispose()
})
test('farewell failure still closes, while disposal prevents a stale close callback', async t => {
  let closed = 0
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('TTS unavailable') })
  const chat = createConversation(player, action => { assert.equal(action, 'disable_listening'); closed++ })
  await chat.control('disable_listening')
  assert.equal(closed, 1); assert.match(chat.state.turns[0]!.speechError!, /unavailable/); chat.dispose()
  let resolve!: (response: Response) => void
  t.mock.method(globalThis, 'fetch', async () => new Promise<Response>(r => { resolve = r }))
  const old = createConversation(player, () => { closed++ })
  const closing = old.control('end_conversation'); old.dispose(); resolve(reply('late'))
  await closing; assert.equal(closed, 1)
})
test('model control interrupts its request and plays a local farewell before shutdown', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const urls: string[] = []; let closed = false; let oldSignal: AbortSignal | undefined
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    urls.push(url)
    if (url === '/api/tts') return reply('')
    assert.equal(JSON.parse(init.body as string).sessionControl, true); oldSignal = init.signal as AbortSignal
    return new Response('data: {"type":"control","action":"end_conversation"}\n\ndata: {"type":"done"}\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
  })
  const chat = createConversation(player, () => { closed = true })
  chat.accept(0, '今天先这样吧'); t.mock.timers.tick(900); await tick()
  assert.deepEqual(urls, ['/api/chat/completions', '/api/tts']); assert.equal(oldSignal?.aborted, true)
  assert.equal(closed, true); assert.equal(chat.state.pendingText, ''); chat.dispose()
})
test('farewell timeout cancels synthesis and still completes shutdown', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let closed = 0; let signal: AbortSignal | undefined
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    signal = init.signal as AbortSignal
    return new Promise<Response>((_resolve, reject) => { signal!.addEventListener('abort', () => reject(new Error('timeout')), { once: true }) })
  })
  const chat = createConversation(player, () => { closed++ })
  const closing = chat.control('end_conversation')
  t.mock.timers.tick(14999); assert.equal(closed, 0)
  t.mock.timers.tick(1); await closing
  assert.equal(signal?.aborted, true); assert.equal(closed, 1); assert.equal(chat.state.answering, false); chat.dispose()
})

test('turn diagnostics link accepted ASR, endpoint, request and completion without text', async t => {
  const { configureSpeechDiagnostics, clearSpeechDiagnostics, speechDiagnosticReport } = await import('../src/audio/speechDiagnostics.ts')
  clearSpeechDiagnostics(); configureSpeechDiagnostics(true)
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    assert.equal(new Headers(init?.headers).get('X-Voice-Diagnostics'), '1')
    return new Response('data: {"type":"text","delta":"private-answer"}\n\ndata: {"type":"done"}\n\n',
      { headers: { 'Content-Type': 'text/event-stream', 'X-Voice-Trace': 'test-turn' } })
  })
  const chat = createConversation(() => ({ ...player(), diagnosticId: 'test-player' }))
  t.after(() => { chat.dispose(); configureSpeechDiagnostics(false); clearSpeechDiagnostics() })
  chat.speechActivity(true)
  chat.accept(1, 'private-question', false)
  chat.speechActivity(false, 0)
  chat.accept(1, 'private-question', true)
  chat.endpoint(0.9)
  chat.finish(); await tick()
  const report = speechDiagnosticReport()
  assert.equal(report.analysis.length, 1)
  assert.equal(report.analysis[0]!.requestId, 'test-turn')
  assert.equal(report.analysis[0]!.status, 'done')
  assert.notEqual(report.analysis[0]!.metrics.finalToCommitMs, null)
  assert.notEqual(report.analysis[0]!.metrics.turnWaitMs, null)
  assert.ok(report.events.some(e => e.event === 'endpoint.result'))
  assert.ok(!JSON.stringify(report).includes('private-question'))
  assert.ok(!JSON.stringify(report).includes('private-answer'))
})
