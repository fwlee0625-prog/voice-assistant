<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, shallowRef, watch } from 'vue'
import { WakeListener, type WakeInput } from '@/audio/wakeListener'
import { defaultWakeKeywords, type WakeKeyword } from '@/audio/kws'
import { createWakeAcknowledgement } from '@/audio/wakeAcknowledgement'
import SettingsDialog from '@/components/SettingsDialog.vue'
import VoiceStage from '@/components/VoiceStage.vue'
import { prepareSpeechPlayback } from '@/audio/speechPlayer'
import ConversationMessages from '@/components/ConversationMessages.vue'
import { createConversation, type ConversationSession } from '@/chat/conversation'
import { RealtimeAsr, type AsrState } from '@/audio/realtimeAsr'
import type { StageMode } from '@/voice/stageScene'
import closeIcon from '@/assets/voice/close.svg'
import collapseIcon from '@/assets/voice/collapse.svg'
import micIcon from '@/assets/voice/mic.svg'
import settingsIcon from '@/assets/voice/settings.svg'

// 麦克风处理项：key 与 MediaTrackConstraints 字段同名，可直接用于 getUserMedia / applyConstraints
const processingOptions = [
  { key: 'noiseSuppression', label: '降噪', hint: '抑制环境底噪' },
  { key: 'autoGainControl', label: '自动增益', hint: '稳定录音音量' },
  { key: 'echoCancellation', label: '回声消除', hint: '减少扬声器回流' },
] as const

type ProcessingKey = (typeof processingOptions)[number]['key']

// 三个开关的期望状态：开始对话时作为约束传入，录音中切换会实时下发给轨道
const processing = reactive<Record<ProcessingKey, boolean>>({
  noiseSuppression: true,
  autoGainControl: true,
  echoCancellation: true,
})

// ---------- 页面状态 ----------
const settingsOpen = ref(false)
const libraryCollapsed = ref(true) // 右侧对话记录是否收起
const isRecording = ref(false)
const asrState = ref<AsrState>({ status: 'idle', segments: {}, error: '' })
const asrSessions = new Set<RealtimeAsr>()
let currentAsr: RealtimeAsr | null = null
const currentConversation = shallowRef<ConversationSession | null>(null)
const conversationSessions = new Set<ConversationSession>()
const failedTurn = computed(() => currentConversation.value?.state.turns.find(turn => turn.status === 'error'))
const wakeEnabled = ref(false)
const wakeLoading = ref(false)
const wakeWaiting = ref(false)
const wakeArming = ref(false)
const wakeResponding = ref(false)
let wakeAcknowledgement: ReturnType<typeof createWakeAcknowledgement> | undefined
let wakeListener: WakeListener | undefined
let wakeInit: AbortController | undefined
let wakeIdleTimer: ReturnType<typeof setInterval> | undefined
let lastInteractionAt = Date.now()
const starting = ref(false) // 正在等待授权弹窗，用于防重复点击
const error = ref('') // 统一展示的错误文案

// 画布 DOM 引用
const analyserRef = shallowRef<AnalyserNode | null>(null)

// Draft recognition and submitted dialogue stay separate from processing status.
const statusText = computed(() => {
  if (asrState.value.error) return asrState.value.error
  if (failedTurn.value) return failedTurn.value.error
  if (wakeResponding.value) return '我在'
  if (!isRecording.value) return ''
  const conversation = currentConversation.value?.state
  const turn = conversation?.turns.at(-1)
  const live = conversation?.pendingText || ''
  return live.trim() ? live : turn?.visibleAssistant || turn?.user || ''
})

const dialogueStatus = computed(() => {
  if (!isRecording.value) return ''
  const conversation = currentConversation.value?.state
  if (conversation?.closing) return '正在结束对话'
  if (conversation?.pendingText) return conversation.userSpeaking ? '正在识别' : '判断中'
  if (conversation?.answering) return conversation.turns.at(-1)?.visibleAssistant ? '正在回答' : '思考中'
  const notice = conversation?.notice
  if (notice === '正在识别…') return '正在识别'
  if (notice === '好的，我等你。') return '等待继续'
  if (notice === '请先说“你好助手”，再告诉我你的问题。') return '等待唤醒'
  if (notice === '已停止上一条回答，正在听你说…') return '正在聆听'
  return conversation?.userSpeaking ? '正在聆听' : '等待说话'
})

// 舞台动画只区分四种模式，具体音量由分析器在 Canvas 内部读取
const stageMode = computed<StageMode>(() => {
  if (isRecording.value) {
    const conversation = currentConversation.value?.state
    if (conversation?.answering) return 'answering'
    if (conversation?.turns.at(-1)?.status === 'loading' && !conversation.userSpeaking) return 'busy'
    return 'listening'
  }
  if (starting.value || wakeLoading.value || wakeArming.value || wakeResponding.value) return 'busy'
  return 'idle'
})

const pillText = computed(() => {
  if (isRecording.value) {
    return dialogueStatus.value
  }
  if (wakeLoading.value || wakeArming.value) return '准备唤醒'
  if (wakeResponding.value) return '正在回应'
  if (starting.value) return '连接中'
  if (wakeWaiting.value) return '等待唤醒'
  return '待机'
})

// 媒体对象、定时器和分析器不放进响应式系统，避免被 Vue 代理后影响浏览器原生行为
let stream: MediaStream | null = null // 麦克风媒体流
let audioCtx: AudioContext | null = null // 仅用于舞台音量分析的音频上下文
let analyser: AnalyserNode | null = null
let sourceNode: MediaStreamAudioSourceNode | null = null
let disposed = false // 组件已卸载，异步回调据此放弃更新状态

// 把 getUserMedia 抛出的 DOMException 转成可读提示
function describeError(err: unknown) {
  if (err instanceof DOMException) {
    if (err.name === 'NotAllowedError') return '麦克风权限被拒绝，请在浏览器地址栏允许访问麦克风'
    if (err.name === 'NotFoundError') return '没有检测到可用的麦克风设备'
    if (err.name === 'NotReadableError') return '麦克风被其他程序占用，请关闭后重试'
  }
  return '无法开始对话，请检查麦克风设备和浏览器权限'
}

// 只把麦克风接到 analyser 用于取舞台音量，不连到 destination，避免声音被再次播放
function setupAnalyser(mediaStream: MediaStream) {
  const Ctx = window.AudioContext
  if (!Ctx) return
  audioCtx = new Ctx()
  analyser = audioCtx.createAnalyser()
  analyser.fftSize = 1024
  sourceNode = audioCtx.createMediaStreamSource(mediaStream)
  sourceNode.connect(analyser)
  analyserRef.value = analyser
}

// 断开音频节点并关闭上下文，释放音频资源
function teardownAnalyser() {
  sourceNode?.disconnect()
  analyser?.disconnect()
  sourceNode = null
  analyser = null
  analyserRef.value = null
  if (audioCtx) {
    void audioCtx.close().catch(() => {})
    audioCtx = null
  }
}

// 停止后必须关闭麦克风轨道，否则浏览器会一直显示“正在录音”
function cleanupStream(keepMicrophone = false) {
  if (!keepMicrophone) { stream?.getTracks().forEach((track) => track.stop()); stream = null }
  teardownAnalyser()
}

// 开始对话：先申请麦克风（带上三个处理开关），再建立实时识别连接
async function startRecording(wakeInput?: WakeInput) {
  if (isRecording.value || starting.value || wakeArming.value || wakeResponding.value) return
  error.value = ''
  if (!navigator.mediaDevices?.getUserMedia) {
    error.value = '当前浏览器不支持麦克风访问，请使用 Chrome / Edge 并通过 localhost 或 HTTPS 访问'
    return
  }

  const entry = wakeInput ? 'wake' : 'manual'
  wakeInput ??= wakeListener?.beginManual()
  wakeWaiting.value = false
  starting.value = true
  for (const session of conversationSessions) session.dispose()
  conversationSessions.clear()
  void prepareSpeechPlayback().catch(() => {})
  try {
    // 这些是理想约束：浏览器会尽量满足，但个别设备可能忽略
    stream = wakeInput?.stream || await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: processing.echoCancellation,
        noiseSuppression: processing.noiseSuppression,
        autoGainControl: processing.autoGainControl,
      },
    })
  } catch (err) {
    error.value = describeError(err)
    starting.value = false
    return
  }
  if (disposed) {
    starting.value = false
    stream.getTracks().forEach((track) => track.stop())
    stream = null
    return
  }

  // Each conversation owns its ASR state so late final results update the correct transcript.
  asrState.value = { status: 'idle', segments: {}, error: '' }
  for (const session of asrSessions) {
    if (session.getStatus() === 'done' || session.getStatus() === 'error') {
      session.dispose()
      asrSessions.delete(session)
    }
  }
  const conversation = createConversation(undefined, action => {
    if (disposed || currentConversation.value !== conversation) return
    if (action === 'disable_listening') disableWake()
    currentAsr?.dispose()
    asrState.value.status = 'done'
    stopRecording()
  })
  conversation.enableTurnDetection()
  currentConversation.value = conversation
  conversationSessions.add(conversation)
  currentAsr = new RealtimeAsr(asrState.value, undefined, conversation.finish, conversation.speechActivity, conversation.interaction, conversation.endpoint, conversation.playbackContext)
  asrSessions.add(currentAsr)
  await currentAsr.start(stream, wakeInput?.takePreroll, entry)
  starting.value = false
  if (disposed) {
    currentAsr?.dispose()
    cleanupStream()
    return
  }

  if (currentAsr.getStatus() !== 'listening') {
    conversation.dispose()
    conversationSessions.delete(conversation)
    if (currentConversation.value === conversation) currentConversation.value = null
    const microphone = stream
    error.value = asrState.value.error || (wakeInput ? '唤醒后连接识别服务失败，请重试。' : '连接识别服务失败，请重试。')
    if (wakeEnabled.value && wakeListener && microphone) void armWake(microphone)
    else cleanupStream()
    return
  }
  lastInteractionAt = Date.now()
  setupAnalyser(stream)
  isRecording.value = true
}

// 结束对话：停止识别并释放麦克风，已完成的问答继续留在侧栏
function stopRecording() {
  if (!isRecording.value) return
  if (currentConversation.value?.state.closing) currentConversation.value.dispose()
  isRecording.value = false
  currentConversation.value?.cancelWait()
  void currentAsr?.finish()
  const microphone = stream
  cleanupStream(wakeEnabled.value && !!wakeListener)
  if (!disposed && wakeEnabled.value && wakeListener && microphone) void armWake(microphone)
}

// 录音中切换开关：applyConstraints 实时生效，再回读实际值，避免 UI 与设备状态不一致
async function applyProcessing(key: ProcessingKey) {
  const track = stream?.getAudioTracks()[0]
  if (!track) return

  const desired = processing[key]
  try {
    await track.applyConstraints({ [key]: desired })
  } catch {
    processing[key] = !desired
    error.value = '当前麦克风不支持在录音中切换该设置'
    return
  }

  const actual = track.getSettings()[key]
  if (typeof actual === 'boolean' && actual !== desired) {
    processing[key] = actual
    error.value = '当前麦克风未采用该设置，已恢复实际状态'
  }
}

async function armWake(microphone: MediaStream) {
  const listener = wakeListener
  if (!listener || !wakeEnabled.value || disposed) return
  listener.setSuppressed(!!currentConversation.value?.state.answering || asrState.value.status === 'finishing')
  wakeArming.value = true
  await listener.listen(microphone)
  if (listener !== wakeListener || !wakeEnabled.value || disposed) return
  wakeArming.value = false
  wakeWaiting.value = true
}
async function respondToWake(input: WakeInput) {
  const listener = wakeListener
  const acknowledgement = wakeAcknowledgement
  if (disposed || !wakeEnabled.value || !listener || !acknowledgement || isRecording.value || starting.value || wakeResponding.value) return
  wakeResponding.value = true; wakeWaiting.value = false
  listener.setPromptPlaying(true)
  let failed = false
  try { await acknowledgement.play() }
  catch { failed = true; if (!disposed && wakeEnabled.value) error.value = '唤醒提示音播放失败，请重新开启语音唤醒。' }
  finally {
    listener.setPromptPlaying(false)
    if (wakeListener === listener) wakeResponding.value = false
  }
  if (disposed || !wakeEnabled.value || wakeListener !== listener) return
  if (failed) { await armWake(input.stream); return }
  await startRecording(input)
}
function disableWake() {
  wakeEnabled.value = false; wakeWaiting.value = false; wakeLoading.value = false; wakeArming.value = false
  wakeResponding.value = false
  wakeAcknowledgement?.dispose(); wakeAcknowledgement = undefined
  wakeInit?.abort(); wakeInit = undefined
  wakeListener?.dispose(); wakeListener = undefined
  clearInterval(wakeIdleTimer); wakeIdleTimer = undefined
  if (!isRecording.value && !starting.value) cleanupStream()
}
async function toggleWake() {
  if (wakeEnabled.value || wakeLoading.value) { disableWake(); return }
  error.value = ''
  if (!navigator.mediaDevices?.getUserMedia) { error.value = '本地唤醒需要支持麦克风访问的 Chrome 和 localhost/HTTPS。'; return }
  wakeEnabled.value = true; wakeLoading.value = true
  const controller = new AbortController(); wakeInit = controller
  void prepareSpeechPlayback().catch(() => {})
  try {
    const acknowledgement = createWakeAcknowledgement(); wakeAcknowledgement = acknowledgement
    await acknowledgement.prepare(controller.signal)
    if (controller.signal.aborted || disposed) return
    const microphone = stream || await navigator.mediaDevices.getUserMedia({ audio: {
      echoCancellation: processing.echoCancellation, noiseSuppression: processing.noiseSuppression, autoGainControl: processing.autoGainControl,
    } })
    if (controller.signal.aborted || disposed) { if (microphone !== stream) microphone.getTracks().forEach(track => track.stop()); return }
    stream = microphone
    let keywords = defaultWakeKeywords
    try {
      const saved = JSON.parse(localStorage.getItem('voice.wakeKeywords') || 'null')
      if (Array.isArray(saved) && saved.length) keywords = saved as WakeKeyword[]
    } catch { /* use built-in defaults */ }
    const listener = await WakeListener.create(input => { void respondToWake(input) }, message => {
      error.value = message; disableWake()
    }, controller.signal, keywords)
    if (controller.signal.aborted || disposed) { listener.dispose(); return }
    wakeListener = listener
    if (!isRecording.value && !starting.value) await armWake(microphone)
    wakeIdleTimer = setInterval(() => {
      const conversation = currentConversation.value?.state
      if (wakeEnabled.value && isRecording.value && !starting.value && !conversation?.answering && !conversation?.userSpeaking && !conversation?.pendingText && Date.now() - lastInteractionAt >= 5000) stopRecording()
    }, 100)
  } catch (err) {
    if (!controller.signal.aborted && !disposed) { error.value = describeError(err); disableWake() }
  } finally { if (wakeInit === controller) { wakeLoading.value = false; wakeInit = undefined } }
}
// Restart the five-second window after speech or playback ends, including speech without an ASR result.
watch(() => [currentConversation.value?.state.pendingText, currentConversation.value?.state.userSpeaking, currentConversation.value?.state.turns.length, currentConversation.value?.state.answering], () => { lastInteractionAt = Date.now() }, { flush: 'sync' })
watch(() => [currentConversation.value?.state.answering, asrState.value.status], () => {
  wakeListener?.setSuppressed(!!currentConversation.value?.state.answering || asrState.value.status === 'finishing')
})

function toggleRecording() {
  if (isRecording.value) stopRecording()
  else void startRecording()
}

function resetError() {
  error.value = ''
}

// ---------- 生命周期 ----------

// 离开页面：结束对话并释放麦克风
onBeforeUnmount(() => {
  disposed = true
  wakeInit?.abort(); wakeAcknowledgement?.dispose(); wakeListener?.dispose(); clearInterval(wakeIdleTimer)
  asrSessions.forEach((session) => session.dispose())
  asrSessions.clear()
  conversationSessions.forEach(session => session.dispose())
  conversationSessions.clear()
  cleanupStream()
})
</script>

<template>
  <div class="page">
    <SettingsDialog v-if="settingsOpen" @close="settingsOpen = false">
      <template #audio-processing>
        <section class="audio-settings" aria-labelledby="audio-settings-title">
          <h2 id="audio-settings-title">音频处理</h2>
          <p>切换后立即生效，也可在对话中调整。</p>
          <div class="controls-panel">
            <div class="controls-grid">
              <label v-for="option in processingOptions" :key="option.key" class="switch-item">
                <span class="switch-copy">
                  <span class="switch-label">{{ option.label }}</span>
                  <span class="switch-hint">{{ option.hint }}</span>
                </span>
                <span class="switch-control">
                  <input
                    v-model="processing[option.key]"
                    type="checkbox"
                    class="switch-input"
                    @change="applyProcessing(option.key)"
                  />
                  <span class="switch-track" aria-hidden="true"><span class="switch-thumb" /></span>
                </span>
              </label>
            </div>
          </div>
        </section>
      </template>
    </SettingsDialog>

    <header class="page-head">
      <div class="head-actions">
        <button type="button" class="ghost-button" :disabled="starting" @click="toggleWake">
          {{ wakeLoading ? '取消加载' : wakeEnabled ? '关闭唤醒' : '语音唤醒' }}
        </button>
        <button type="button" class="ghost-button" @click="settingsOpen = true">
          <img :src="settingsIcon" alt="" aria-hidden="true" />
          设置
        </button>
        <span class="status-pill" role="status" :class="{ live: isRecording || starting || wakeResponding, waiting: wakeWaiting }">
          <span class="status-dot" />
          {{ pillText }}
        </span>
      </div>
    </header>

    <main class="stage-main">
      <VoiceStage
        class="stage-visual"
        :mode="stageMode"
        :analyser="analyserRef"
        :disabled="starting || wakeLoading || wakeArming || wakeResponding"
        :label="isRecording ? '结束对话' : '开始对话'"
        :active="isRecording"
        @activate="toggleRecording"
      />

      <div class="stage-copy">
        <p v-if="!statusText" class="stage-prompt">{{ isRecording ? '我在听，请说…' : '准备好了，随时开口' }}</p>
        <p class="stage-hint" :title="statusText" aria-live="polite">{{ statusText }}</p>
        <small v-if="isRecording && asrState.vadStatus === 'fallback'" role="status">Silero 未能加载，当前使用基础声音检测。</small>
        <small v-if="isRecording && currentConversation?.state.turns.at(-1)?.speechError" role="status">{{ currentConversation.state.turns.at(-1)?.speechError }}</small>
        <button v-if="isRecording && failedTurn" type="button" class="retry-answer" @click="currentConversation?.retry(failedTurn.index)">重试</button>
      </div>

      <div v-if="error" class="error-banner" role="alert">
        <span>{{ error }}</span>
        <button type="button" class="error-close" aria-label="关闭提示" @click="resetError">
          <img :src="closeIcon" alt="" />
        </button>
      </div>
    </main>

    <aside id="library-panel" class="library-panel">
      <Transition name="panel-swap">
        <button
          v-if="libraryCollapsed"
          key="rail"
          type="button"
          class="rail-tab"
          aria-label="展开对话记录"
          aria-expanded="false"
          aria-controls="library-panel"
          @click="libraryCollapsed = false"
        >
          <img class="rail-collapse-icon" :src="collapseIcon" alt="" aria-hidden="true" />
        </button>

        <div v-else key="card" class="library-card">
          <header class="library-head">
            <div class="library-title">
              <h2>对话记录</h2>
            </div>
            <button type="button" class="rail-collapse" aria-label="收起对话记录" @click="libraryCollapsed = true">
              <img :src="collapseIcon" alt="" aria-hidden="true" />
            </button>
          </header>

          <ConversationMessages
            v-if="currentConversation"
            :conversation="currentConversation.state"
            :interim="currentConversation.state.pendingText"
            @retry="currentConversation?.retry($event)"
          />

          <div v-else class="empty">
            <img :src="micIcon" alt="" aria-hidden="true" />
            <p>还没有对话</p>
            <span>开始对话后，提问和回答会显示在这里</span>
          </div>

          <footer class="library-foot">对话文本保存在当前页面，刷新后会清空</footer>
        </div>
      </Transition>
    </aside>
  </div>
</template>

<style scoped>
.page {
  --orb-size: clamp(156px, min(32vmin, 34vh), 288px);
  --orb-top: 40%;
  position: relative;
  flex: 1;
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  color: #dff8fc;
  background:
    radial-gradient(220px 220px at 6% 72%, rgba(38, 220, 244, 0.13), transparent 70%),
    radial-gradient(150px 150px at 2% 90%, rgba(38, 220, 244, 0.1), transparent 70%),
    radial-gradient(260px 260px at 94% 78%, rgba(38, 220, 244, 0.11), transparent 70%),
    radial-gradient(130px 130px at 98% 93%, rgba(38, 220, 244, 0.08), transparent 70%),
    radial-gradient(1100px 640px at 50% 45%, rgba(10, 62, 76, 0.4), transparent 68%),
    radial-gradient(760px 420px at 50% 102%, rgba(8, 84, 102, 0.3), transparent 70%),
    linear-gradient(180deg, #040b10 0%, #02070b 55%, #010406 100%);
}

.page::before {
  content: '';
  position: absolute;
  inset: 0;
  pointer-events: none;
  background-image: radial-gradient(rgba(120, 240, 255, 0.06) 1px, transparent 1px);
  background-size: 36px 36px;
  mask-image: radial-gradient(circle at 50% 45%, #000 0%, transparent 72%);
  opacity: 0.5;
}

.page::after {
  content: '';
  position: absolute;
  inset: 0;
  pointer-events: none;
  box-shadow: inset 0 0 100px rgba(0, 0, 0, 0.42);
  z-index: 7;
}

.page-head {
  position: relative;
  z-index: 9;
  display: flex;
  align-items: flex-start;
  justify-content: flex-end;
  gap: 20px;
  flex: none;
  padding: 26px 34px 0;
}

.head-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.ghost-button {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 8px 14px;
  border: 1px solid rgba(110, 230, 250, 0.16);
  border-radius: 999px;
  background: rgba(8, 26, 34, 0.45);
  color: #a8d7df;
  font-size: 12.5px;
  letter-spacing: 0.03em;
  transition:
    color 160ms ease,
    border-color 160ms ease,
    background-color 160ms ease,
    box-shadow 160ms ease;
}

.ghost-button img {
  width: 14px;
  height: 14px;
  opacity: 0.85;
}

.ghost-button:hover:not(:disabled) {
  border-color: rgba(120, 240, 255, 0.45);
  background: rgba(14, 44, 54, 0.6);
  color: #e6feff;
  box-shadow: 0 0 20px rgba(52, 220, 240, 0.14);
}

.ghost-button:disabled {
  cursor: wait;
  opacity: 0.55;
}

.ghost-button:focus-visible,
.rail-tab:focus-visible,
.rail-collapse:focus-visible,
.error-close:focus-visible {
  outline: 1px solid rgba(140, 246, 255, 0.8);
  outline-offset: 3px;
}

.status-pill {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  border: 1px solid rgba(110, 230, 250, 0.18);
  border-radius: 999px;
  background: rgba(6, 22, 29, 0.5);
  color: #9fd3db;
  font-size: 12.5px;
  font-weight: 500;
  letter-spacing: 0.05em;
  white-space: nowrap;
}

.status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #47e9ff;
  box-shadow: 0 0 9px rgba(71, 233, 255, 0.9);
}

.status-pill.live {
  border-color: rgba(90, 230, 250, 0.5);
  background: rgba(8, 40, 50, 0.62);
  color: #d9feff;
}

.status-pill.live .status-dot {
  animation: blink 1.2s ease-in-out infinite;
}

.status-pill.waiting {
  color: #8db6bf;
}

.status-pill.waiting .status-dot {
  background: #6f9ea8;
  box-shadow: none;
}

.stage-main {
  position: relative;
  z-index: 1;
  flex: 1;
  min-height: 0;
}

.stage-visual {
  position: absolute;
  inset: 0;
}

.stage-copy {
  position: absolute;
  left: 50%;
  top: calc(var(--orb-top) + var(--orb-size) * 1.12 + 42px);
  z-index: 9;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 7px;
  width: min(640px, 84%);
  transform: translateX(-50%);
  text-align: center;
  pointer-events: none;
}

.stage-prompt {
  color: #91bec8;
  font-size: 12px;
  letter-spacing: 0.12em;
}

.stage-hint {
  display: -webkit-box;
  overflow: hidden;
  color: #8fc2cc;
  font-size: 13px;
  line-height: 1.7;
  letter-spacing: 0.02em;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
}

.stage-copy small {
  color: #6f9aa4;
  font-size: 11.5px;
  line-height: 1.6;
}

.retry-answer {
  pointer-events: auto;
  color: #7ff3ff;
  font-size: 12.5px;
  text-decoration: underline;
  text-underline-offset: 3px;
}







.error-banner {
  position: absolute;
  top: 8px;
  left: 50%;
  z-index: 20;
  display: flex;
  align-items: center;
  gap: 12px;
  width: max-content;
  max-width: min(640px, 90%);
  padding: 10px 12px 10px 16px;
  border: 1px solid rgba(255, 140, 120, 0.35);
  border-radius: 12px;
  background: rgba(48, 13, 11, 0.82);
  color: #ffb9ac;
  font-size: 12.5px;
  line-height: 1.6;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.45);
  backdrop-filter: blur(14px);
  transform: translateX(-50%);
}

.error-banner span {
  min-width: 0;
  overflow-wrap: anywhere;
}

.error-close {
  flex: none;
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  opacity: 0.7;
}

.error-close:hover {
  background: rgba(255, 150, 130, 0.14);
  opacity: 1;
}

.error-close img {
  width: 12px;
  height: 12px;
}

/* ---------- 对话记录侧栏 ---------- */

.library-panel {
  position: absolute;
  top: 96px;
  right: 0;
  bottom: 24px;
  z-index: 30;
  width: min(380px, calc(100vw - 32px));
  pointer-events: none;
}

.rail-tab {
  position: absolute;
  top: 0;
  right: 0;
  pointer-events: auto;
  display: grid;
  place-items: center;
  width: 44px;
  padding: 14px 0;
  border: 1px solid rgba(100, 225, 245, 0.18);
  border-right: 0;
  border-radius: 14px 0 0 14px;
  background: linear-gradient(180deg, rgba(8, 26, 34, 0.9), rgba(4, 15, 21, 0.94));
  color: #a6dde6;
  box-shadow:
    -12px 0 40px -24px rgba(64, 230, 250, 0.6),
    inset 0 1px 0 rgba(180, 255, 255, 0.08);
  backdrop-filter: blur(14px);
  transition:
    color 160ms ease,
    border-color 160ms ease;
}

.rail-tab:hover {
  color: #e9ffff;
  border-color: rgba(130, 245, 255, 0.5);
}

.rail-collapse-icon {
  width: 16px;
  height: 16px;
  opacity: 0.8;
}

.library-card {
  position: absolute;
  inset: 0 0 0 auto;
  width: 100%;
  pointer-events: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
  height: 100%;
  min-height: 0;
  padding: 18px 16px 14px;
  border: 1px solid rgba(98, 226, 246, 0.16);
  border-right: 0;
  border-radius: 20px 0 0 20px;
  background: linear-gradient(180deg, rgba(6, 24, 32, 0.93), rgba(3, 13, 19, 0.96));
  box-shadow:
    0 30px 90px rgba(0, 0, 0, 0.6),
    inset 0 1px 0 rgba(190, 255, 255, 0.06);
  backdrop-filter: blur(18px);
  overflow: hidden;
}

.panel-swap-enter-active,
.panel-swap-leave-active {
  transition:
    opacity 220ms ease,
    transform 260ms cubic-bezier(0.2, 0.8, 0.3, 1);
}

.panel-swap-leave-active {
  pointer-events: none;
  transition-duration: 160ms;
}

.library-card.panel-swap-enter-from,
.library-card.panel-swap-leave-to {
  opacity: 0;
  transform: translateX(72px);
}

.rail-tab.panel-swap-enter-from,
.rail-tab.panel-swap-leave-to {
  opacity: 0;
  transform: translateX(14px);
}

.library-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 0 4px;
}

.library-title {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.library-head h2 {
  color: #e5fcff;
  font-size: 15px;
  font-weight: 600;
  letter-spacing: 0.03em;
}

.rail-collapse {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border: 1px solid rgba(110, 240, 255, 0.2);
  border-radius: 9px;
  background: rgba(8, 30, 38, 0.5);
}

.rail-collapse:hover {
  border-color: rgba(130, 245, 255, 0.5);
  background: rgba(14, 46, 56, 0.7);
}

.rail-collapse img {
  width: 14px;
  height: 14px;
  transform: rotate(180deg);
  opacity: 0.8;
}

.empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  margin: 2px 4px;
  border: 1px dashed rgba(100, 220, 240, 0.18);
  border-radius: 16px;
  color: #5f8e99;
}

.empty img {
  width: 36px;
  height: 36px;
  opacity: 0.4;
}

.empty p {
  color: #b9dfe5;
  font-size: 13.5px;
  font-weight: 600;
}

.empty span {
  font-size: 11.5px;
}

.library-foot {
  flex: none;
  padding: 10px 4px 0;
  border-top: 1px solid rgba(100, 220, 240, 0.1);
  color: #4f7882;
  font-size: 10.5px;
  text-align: center;
}

.audio-settings {
  display: block;
}

.audio-settings h2 {
  color: #e6fdff;
  font-size: 16px;
}

.audio-settings p {
  margin-top: 8px;
  color: #6f9aa4;
  font-size: 12px;
  line-height: 1.6;
}

.controls-panel {
  display: flex;
  align-items: center;
  gap: 20px;
  margin-top: 14px;
  padding: 14px 16px;
  border: 1px solid rgba(90, 210, 230, 0.14);
  border-radius: 14px;
  background: rgba(10, 30, 38, 0.5);
}

.controls-grid {
  display: flex;
  flex: 1;
  flex-wrap: wrap;
  gap: 12px 26px;
}

.switch-item {
  display: flex;
  align-items: center;
  gap: 12px;
  cursor: pointer;
  user-select: none;
}

.switch-copy {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.switch-label {
  color: #cfeef3;
  font-size: 13px;
  font-weight: 600;
}

.switch-hint {
  color: #5f8e99;
  font-size: 11px;
}

.switch-control {
  position: relative;
  display: inline-flex;
  flex: none;
}

.switch-input {
  position: absolute;
  inset: 0;
  margin: 0;
  opacity: 0;
  cursor: pointer;
}

.switch-track {
  display: block;
  width: 38px;
  height: 22px;
  padding: 3px;
  border-radius: 999px;
  background: rgba(120, 200, 215, 0.22);
  transition: background-color 0.18s ease;
}

.switch-thumb {
  display: block;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #dffbff;
  box-shadow: 0 1px 3px rgba(0, 16, 24, 0.6);
  transition: transform 0.18s ease;
}

.switch-input:checked + .switch-track {
  background: #14c8d8;
}

.switch-input:checked + .switch-track .switch-thumb {
  transform: translateX(16px);
}

.switch-input:focus-visible + .switch-track {
  outline: 1px solid rgba(140, 246, 255, 0.8);
  outline-offset: 2px;
}

/* ---------- 动画 ---------- */

@keyframes blink {
  50% {
    opacity: 0.35;
  }
}

@media (max-width: 1024px) {
  .library-panel {
    top: 88px;
    right: 0;
    bottom: 16px;
  }
}

@media (max-width: 600px) {
  .page { --orb-size: clamp(150px, 44vw, 230px); --orb-top: 38%; }
  .page-head { flex-wrap: wrap; gap: 14px; }
  .head-actions { flex-wrap: wrap; }
  .status-pill { font-size: 11px; }
}

@media (max-width: 860px) {
  .page-head {
    padding: 16px 16px 0;
  }

  .head-actions {
    gap: 8px;
  }

  .ghost-button {
    padding: 7px 11px;
    font-size: 12px;
  }

  .status-pill {
    padding: 7px 11px;
  }

  .stage-copy {
    top: calc(var(--orb-top) + var(--orb-size) * 1.12 + 38px);
    width: 88%;
  }

  .stage-prompt {
  color: #91bec8;
  font-size: 12px;
  letter-spacing: 0.12em;
}

.stage-hint {
    font-size: 12px;
  }



  .library-panel {
    top: 72px;
    right: 0;
    bottom: 12px;
    left: 12px;
    width: auto;
  }
}

@media (max-height: 680px) {
  .page-head {
    padding-top: 14px;
  }

  .stage-copy {
    top: calc(var(--orb-top) + var(--orb-size) * 1.12 + 38px);
  }
}

@media (max-height: 500px) {
  .page { --orb-size: clamp(92px, 28vh, 136px); --orb-top: 36%; }
  .page-head { padding-top: 12px; }
  .stage-copy { top: calc(var(--orb-top) + var(--orb-size) * 1.12 + 20px); }

}

@media (prefers-reduced-motion: reduce) {
  .status-pill.live .status-dot {
    animation: none;
  }

}
</style>
