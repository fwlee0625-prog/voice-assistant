import type { InteractionEvent } from '../audio/realtimeAsr.ts'
import { reactive } from 'vue'
import { readReply, type ControlAction } from './stream.ts'
import { endpointDelay } from './endpoint.ts'
import { filterEcho } from './echoGuard.ts'
import { createSpeechPlayer, type SpeechPlayer, type SpeechProgress } from '../audio/speechPlayer.ts'
import { diagnosticId, diagnosticTime, diagnosticsEnabled, recordSpeechDiagnostic } from '../audio/speechDiagnostics.ts'
export interface Turn {
  index: number; user: string; assistant: string; visibleAssistant: string
  status: 'queued' | 'loading' | 'done' | 'error' | 'interrupted'
  error: string; speechError?: string; diagnosticId?: string
}
export interface Conversation { turns: Turn[]; pendingText: string; userSpeaking: boolean; notice: string; answering: boolean; owner?: number; closing?: boolean; endpointMode?: 'model' | 'rules' }
interface ActiveReply { turn: Turn; controller: AbortController; player: SpeechPlayer }

/** One live reply; local speech pauses endpointing, novel ASR text interrupts the reply. */
export function createConversation(playerFactory: (onProgress: (progress: SpeechProgress) => void) => SpeechPlayer = createSpeechPlayer, onEnd?: (action: 'end_conversation' | 'disable_listening') => void) {
  const state = reactive<Conversation>({ turns: [], pendingText: '', userSpeaking: false, notice: '', answering: false })
  let disposed = false
  let ended = false
  let active: ActiveReply | undefined
  let recentPlayers: SpeechPlayer[] = []
  const sessionId = diagnosticId('session')
  let silenceObserved: number | undefined
  let finalAt: number | undefined
  let endpointAt: number | undefined
  let silenceAt: number | undefined
  let microphoneSpeaking = false
  let turnDetection = false
  let endpointPending = false
  let endpointProbability: number | undefined
  const decisionGroups = new Map<number, Set<number>>()
  const candidateSpeakers = new Map<number, number>()
  const executedStops = new Set<number>()
  let pauseTimer: ReturnType<typeof setTimeout> | undefined
  let duckTimer: ReturnType<typeof setTimeout> | undefined
  let waitTimer: ReturnType<typeof setTimeout> | undefined
  let promptIndex = -1
  const waitPrompt = '我在，还需要什么帮助吗？'
  function clearWait() { clearTimeout(waitTimer); waitTimer = undefined }
  function scheduleWaitPrompt() {
    clearWait()
    waitTimer = setTimeout(() => {
      if (disposed || ended) return
      if (microphoneSpeaking || active) { scheduleWaitPrompt(); return }
      const turn: Turn = { index: promptIndex--, user: '', assistant: waitPrompt, visibleAssistant: waitPrompt, status: 'done', error: '' }
      state.turns.push(turn)
      const controller = new AbortController()
      const player = playerFactory(() => {})
      const reply = { turn, controller, player }
      active = reply; state.answering = true
      recentPlayers.push(player)
      void (async () => {
        try {
          const settings = await fetch('/api/settings', { signal: controller.signal })
          if (!settings.ok) throw new Error('无法读取语音设置')
          const config = await settings.json()
          if (config.tts?.enabled) {
            const response = await fetch('/api/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
              body: JSON.stringify({ text: waitPrompt, stream: true }) })
            await readReply(response, async event => {
              if (event.type === 'audio') await player.append(event.data, event.sampleRate, controller.signal, waitPrompt)
            }, controller.signal)
            await player.finish(controller.signal)
          }
        } catch (error) {
          if (!controller.signal.aborted) turn.speechError = error instanceof Error ? error.message : '语音播放失败'
        } finally {
          if (active === reply) { player.stop(); active = undefined; state.answering = false; drain() }
        }
      })()
    }, 2000)
  }
  const pending = new Map<number, { text: string; final: boolean }>()
  const submitted = new Set<number>()
  const echoReferences = new Map<number, string[]>()

  function updatePendingText() {
    state.pendingText = [...pending.entries()].sort(([a], [b]) => a - b)
      .map(([, segment]) => segment.text).join('')
  }
  function clearPause() { clearTimeout(pauseTimer); pauseTimer = undefined }
  function restoreVolume() {
    clearTimeout(duckTimer); duckTimer = undefined
    active?.player.duck?.(false)
  }
  function interrupt() {
    restoreVolume()
    const reply = active
    if (!reply) return
    state.answering = false
    active = undefined // Invalidate ownership before abort callbacks can run.
    reply.turn.status = 'interrupted'
    reply.player.stop()
    reply.controller.abort()
    state.notice = '已停止上一条回答，正在听你说…'
  }
  function scheduleCommit() {
    clearPause()
    if (disposed || ended || state.userSpeaking || !pending.size || [...pending.values()].some(s => !s.final)) return
    // Local silence may have begun before the cloud final arrives; don't wait twice.
    const elapsed = silenceAt === undefined ? 0 : Math.max(0, Date.now() - silenceAt)
    const rule = endpointDelay(state.pendingText)
    const budget = endpointPending ? Math.max(rule, 1000) : endpointProbability === undefined ? rule
      : endpointProbability >= 0.65 ? (rule === 1300 ? 1300 : 350)
      : endpointProbability <= 0.35 ? 2500 : rule
    pauseTimer = setTimeout(commitPending, Math.max(120, budget - elapsed))
  }
  function commitPending() {
    clearPause()
    if (disposed || ended || state.userSpeaking || !pending.size || [...pending.values()].some(s => !s.final)) return
    const entries = [...pending.entries()].sort(([a], [b]) => a - b)
    const index = entries[0]![0]
    const text = entries.map(([, segment]) => segment.text).join('')
    entries.forEach(([id]) => { submitted.add(id); candidateSpeakers.delete(id) })
    pending.clear(); silenceAt = undefined; updatePendingText()
    if (!text.trim()) return
    state.notice = ''
    const trace = diagnosticId('turn')
    recordSpeechDiagnostic('turn.commit', { trace, sessionId, turn: index, silenceAtMs: silenceObserved === undefined ? -1 : diagnosticTime(silenceObserved), finalAtMs: finalAt === undefined ? -1 : diagnosticTime(finalAt), endpointAtMs: endpointAt === undefined ? -1 : diagnosticTime(endpointAt) })
    silenceObserved = undefined; finalAt = undefined; endpointAt = undefined
    state.turns.push({ diagnosticId: trace, index, user: text, assistant: '', visibleAssistant: '', status: 'queued', error: '' })
    drain()
  }
  function drain() {
    if (active || disposed || ended) return
    for (const turn of state.turns) {
      if (turn.status === 'error') return
      if (turn.status !== 'queued') continue
      turn.assistant = ''; turn.visibleAssistant = ''; turn.speechError = ''; turn.status = 'loading'
      const controller = new AbortController()
      const reply: ActiveReply = { turn, controller, player: playerFactory(progress => {
        if (disposed || ended || active?.controller !== controller || controller.signal.aborted || turn.speechError) return
        const characters = Array.from(turn.assistant.slice(progress.start, progress.end))
        const count = progress.progress >= 1 ? characters.length : Math.floor(characters.length * progress.progress)
        const end = progress.start + characters.slice(0, count).join('').length
        if (count && end > turn.visibleAssistant.length) turn.visibleAssistant = turn.assistant.slice(0, end)
      }) }
      active = reply; state.answering = true
      recentPlayers.push(reply.player)
      void answer(reply)
      return
    }
  }
  async function answer(reply: ActiveReply) {
    const { turn, player, controller } = reply
    const current = () => !disposed && active === reply && !controller.signal.aborted
    let speechEnabled: boolean | undefined
    let receivedAudio = false
    try {
      const history = state.turns.slice(0, state.turns.indexOf(turn))
        .filter(t => t.status === 'done' || t.status === 'interrupted')
        .flatMap(t => [...(t.user ? [{ role: 'user', content: t.user }] : []), {
          role: 'assistant', content: t.status === 'interrupted' ? '（这条回答被用户打断，未完整播报。）' : t.assistant,
        }])
      recordSpeechDiagnostic('reply.request', { trace: turn.diagnosticId || '', player: player.diagnosticId || 'custom', turn: turn.index })
      const response = await fetch('/api/chat/completions', {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...(diagnosticsEnabled() ? { 'X-Voice-Diagnostics': '1' } : {}) }, signal: controller.signal,
        body: JSON.stringify({ stream: true, sessionControl: true, messages: [...history.slice(-98), { role: 'user', content: turn.user }] }),
      })
      recordSpeechDiagnostic('reply.response', { player: player.diagnosticId || 'custom', turn: turn.index,
        requestId: response.headers.get('X-Voice-Trace') || '', status: response.status })
      if (!current()) { await response.body?.cancel().catch(() => {}); return }
      await readReply(response, async event => {
        if (!current()) return
        if (event.type === 'control') { void control(event.action); return }
        if (event.type === 'speech') speechEnabled = event.enabled
        if (event.type === 'text') {
          turn.assistant += event.delta
          if (speechEnabled === false || turn.speechError) turn.visibleAssistant = turn.assistant
        }
        if (event.type === 'speech_error') {
          recordSpeechDiagnostic('reply.speech_error', { player: player.diagnosticId || 'custom' })
          turn.speechError = event.error
          player.stop(); turn.visibleAssistant = turn.assistant
        }
        if (event.type === 'sentence_end' && !turn.speechError) player.endSentence?.(event.sentenceId)
        if (event.type === 'filler_audio' && !turn.speechError) {
          // The interjection is spoken but is not part of the answer text.
          try { await player.append(event.data, event.sampleRate, controller.signal, event.text) }
          catch { /* An interjection failure must not break the answer. */ }
        }
        if (event.type === 'audio' && !turn.speechError) {
          try {
            if (event.format !== 'pcm16' || event.channels !== 1) throw new Error('语音格式无效')
            const sentence = event.sentenceId !== undefined && event.start !== undefined && event.end !== undefined && event.text
              ? { sentenceId: event.sentenceId, start: event.start, end: event.end, text: event.text } : undefined
            if (!sentence) turn.visibleAssistant = turn.assistant
            await player.append(event.data, event.sampleRate, controller.signal, event.text, sentence)
            receivedAudio = true
          } catch (error) {
            if (!current()) return
            recordSpeechDiagnostic('reply.playback_error', { player: player.diagnosticId || 'custom', errorType: error instanceof Error ? error.name : 'unknown' })
            player.stop()
            turn.speechError = error instanceof Error ? error.message : '语音播放失败'
            turn.visibleAssistant = turn.assistant
          }
        }
      }, controller.signal)
      if (!current()) return
      if (!turn.assistant.trim()) throw new Error('模型未返回文字')
      // Keep ownership until audible playback completes, so the tail is interruptible too.
      turn.status = 'done'
      if (!receivedAudio) turn.visibleAssistant = turn.assistant
      try { await player.finish(controller.signal) }
      catch (error) { if (current()) turn.speechError = error instanceof Error ? error.message : '语音播放失败' }
      if (current()) turn.visibleAssistant = turn.assistant
    } catch (error) {
      if (!current()) return
      player.stop(); turn.status = 'error'
      turn.visibleAssistant = turn.assistant
      turn.error = error instanceof Error ? error.message : '模型请求失败'
    } finally {
      recordSpeechDiagnostic('reply.end', { trace: turn.diagnosticId || '', player: player.diagnosticId || 'custom', status: turn.status, aborted: controller.signal.aborted })
      if (active === reply) {
        restoreVolume(); player.stop(); active = undefined; state.answering = false
        drain()
      }
    }
  }
  async function control(action: ControlAction, user = '') {
    if (disposed || ended) return
    clearWait(); clearPause(); pending.clear(); updatePendingText(); interrupt()
    for (const turn of state.turns) if (turn.status === 'queued') turn.status = 'interrupted'
    state.userSpeaking = false; microphoneSpeaking = false
    if (action === 'pause_reply') {
      state.notice = '好的，我等你。'; scheduleWaitPrompt(); return
    }
    // Seal input before speaking. ASR remains open until the farewell is audible.
    ended = true; state.closing = true
    const text = action === 'disable_listening' ? '好的，再见。我会关闭麦克风。' : '好的，这次对话就到这里，再见。'
    const turn: Turn = { index: promptIndex--, user, assistant: text, visibleAssistant: text, status: 'loading', error: '' }
    state.turns.push(turn)
    const controller = new AbortController()
    const player = playerFactory(() => {})
    const reply = { turn, controller, player }
    active = reply; state.answering = true; recentPlayers.push(player)
    const timeout = setTimeout(() => controller.abort(), 15000)
    try {
      const response = await fetch('/api/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
        body: JSON.stringify({ text, stream: true }) })
      await readReply(response, async event => {
        if (!disposed && !controller.signal.aborted && event.type === 'audio') await player.append(event.data, event.sampleRate, controller.signal, text)
      }, controller.signal)
      await player.finish(controller.signal)
      turn.status = 'done'
    } catch (error) {
      if (!disposed) { turn.status = 'done'; turn.speechError = error instanceof Error ? error.message : '结束语播放失败' }
    } finally {
      clearTimeout(timeout); player.stop(); controller.abort()
      if (active === reply) { active = undefined; state.answering = false }
      state.closing = false; state.notice = '对话已结束'
      if (!disposed) onEnd?.(action)
    }
  }
  const session = {
    control,
    state,
    accept(index: number, rawText: string, final = true) {
      if (disposed || ended || submitted.has(index)) return
      const previous = pending.get(index)
      if (previous?.final && !final) return
      // Expired/future scheduled audio cannot be used to suppress a user request.
      recentPlayers = recentPlayers.filter(player => player === active?.player || !!player.referenceText?.().length)
      const references = [...(echoReferences.get(index) || []), ...recentPlayers.flatMap(player => player.referenceText?.() || [])]
      const text = filterEcho(rawText, references)
      if (references.length && text !== rawText) {
        echoReferences.set(index, [...new Set(references)])
        if (echoReferences.size > 128) echoReferences.delete(echoReferences.keys().next().value!)
      }
      if (!text.trim() || (!final && references.length && text.replace(/[\p{P}\s]/gu, '').length < 2)) {
        restoreVolume()
        return
      }
      if (previous?.text === text && previous.final === final) return
      interrupt()
      clearPause()
      if (!final) silenceAt = undefined
      if (final) finalAt = performance.now()
      recordSpeechDiagnostic('asr.accept', { sessionId, index, final })
      pending.set(index, { text, final })
      updatePendingText()
      scheduleCommit()
    },
    speechActivity(speaking: boolean, silenceMs = 240) {
      if (disposed || ended || microphoneSpeaking === speaking) return
      recordSpeechDiagnostic('vad.activity', { sessionId, speaking, silenceMs })
      if (speaking) { silenceObserved = undefined; endpointAt = undefined }
      else silenceObserved = performance.now() - silenceMs
      microphoneSpeaking = speaking
      state.userSpeaking = speaking
      if (speaking) {
        endpointProbability = undefined; endpointPending = false
        silenceAt = undefined; clearPause()
        if (active?.player.isPlaying?.()) {
          active.player.duck?.(true)
          clearTimeout(duckTimer)
          // A noise burst with no useful ASR must not leave playback muted.
          duckTimer = setTimeout(restoreVolume, 1500)
        }
      } else {
        if (waitTimer !== undefined) scheduleWaitPrompt()
        // Include quiet frames already observed by the active VAD implementation.
        silenceAt = Date.now() - silenceMs
        endpointPending = turnDetection
        restoreVolume()
        scheduleCommit()
      }
    },
    enableTurnDetection() { turnDetection = true; state.notice = '请先说“你好助手”，再告诉我你的问题。' },
    endpoint(probability?: number) {
      if (disposed || ended || state.userSpeaking) return
      endpointAt = performance.now()
      recordSpeechDiagnostic('endpoint.result', { sessionId, probability: probability ?? -1 })
      endpointPending = false
      endpointProbability = typeof probability === 'number' && probability >= 0 && probability <= 1 ? probability : undefined
      state.endpointMode = endpointProbability === undefined ? 'rules' : 'model'
      scheduleCommit()
    },
    interaction(event: InteractionEvent) {
      if (disposed || ended) return
      const prior = decisionGroups.get(event.index)
      if (prior && [...prior].some(id => submitted.has(id))) return
      if (state.owner !== event.owner && event.owner !== undefined) {
        for (const [id, speaker] of candidateSpeakers) if (speaker !== event.owner) { pending.delete(id); candidateSpeakers.delete(id) }
      }
      state.owner = event.owner
      const ending = event.parts.find(part => part.action === 'end_conversation' || part.action === 'disable_listening')
      if (ending) {
        if (event.final) void control(ending.action as 'end_conversation' | 'disable_listening', ending.text)
        return
      }
      const accepted = event.parts.filter(part => part.action === 'accept')
      const previous = decisionGroups.get(event.index) || new Set<number>()
      const current = new Set(accepted.map(part => part.id))
      // Speaker revisions can withdraw an unsubmitted candidate from this ASR slice.
      for (const id of previous) if (!current.has(id) && !submitted.has(id)) pending.delete(id)
      decisionGroups.set(event.index, current)
      if (decisionGroups.size > 1000) decisionGroups.delete(decisionGroups.keys().next().value!)
      const stops = event.parts.filter(part => part.action === 'stop' && !executedStops.has(part.id))
      if (stops.length) {
        stops.forEach(part => executedStops.add(part.id))
        if (executedStops.size > 1000) executedStops.delete(executedStops.values().next().value!)
        pending.clear(); clearPause(); session.interrupt()
        state.notice = '好的，我等你。'; scheduleWaitPrompt()
      }
      if (accepted.length) { clearWait(); state.notice = ''; if (microphoneSpeaking) state.userSpeaking = true }
      for (const part of accepted) { candidateSpeakers.set(part.id, part.speakerId); session.accept(part.id, part.text, event.final) }
      updatePendingText()
      if (!accepted.length) {
        restoreVolume()
        if (event.parts.every(part => part.action === 'ignore')) {
          state.userSpeaking = false; scheduleCommit()
          if (state.owner !== undefined && state.notice === '正在识别…') state.notice = ''
        }
        if (event.parts.some(part => part.reason === 'call_assistant')) state.notice = '请先说“你好助手”，再告诉我你的问题。'
        else if (event.parts.some(part => part.reason === 'speaker_unstable')) state.notice = '正在识别…'
      }
      updatePendingText()
    },
    playbackContext() {
      return { active: state.answering,
        references: [...new Set(recentPlayers.flatMap(player => player.referenceText?.() || []))].slice(-12).map(text => text.slice(0, 160)),
        question: (state.turns.at(-1)?.visibleAssistant || '').slice(-500) }
    },
    interrupt,
    cancelWait: clearWait,
    finish() {
      if (disposed || ended) return
      clearWait()
      microphoneSpeaking = false; state.userSpeaking = false
      for (const [index, segment] of pending) if (!segment.final) pending.delete(index)
      updatePendingText(); commitPending()
    },
    retry(index: number) {
      if (disposed || ended) return
      const turn = state.turns.find(t => t.index === index)
      if (turn?.status !== 'error') return
      turn.status = 'queued'; turn.error = ''; state.notice = ''; drain()
    },
    dispose() {
      disposed = true; clearWait(); clearPause(); restoreVolume(); pending.clear()
      state.pendingText = ''; microphoneSpeaking = false; state.userSpeaking = false; state.answering = false
      echoReferences.clear(); candidateSpeakers.clear(); decisionGroups.clear(); executedStops.clear()
      if (active) {
        active.turn.status = 'interrupted'; active.player.stop(); active.controller.abort(); active = undefined
      }
      recentPlayers = []
    },
  }
  return session
}
export type ConversationSession = ReturnType<typeof createConversation>
