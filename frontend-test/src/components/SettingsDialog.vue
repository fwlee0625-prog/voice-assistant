<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, useSlots, watch } from 'vue'
import { clearSpeechDiagnostics, configureSpeechDiagnostics, diagnosticsState, downloadSpeechDiagnostics, speechTimingAnalysis, recordSpeechDiagnostic } from '@/audio/speechDiagnostics'
import AppSelect from '@/components/AppSelect.vue'
import closeIcon from '@/assets/voice/close.svg'
import { defaultWakeKeywords, type WakeKeyword } from '@/audio/kws'
const emit = defineEmits<{ close: [] }>()
const dialog = ref<HTMLDialogElement | null>(null)
function close() { dialog.value?.close(); emit('close') }
const slots = useSlots()
type TabKey = 'audio' | 'model' | 'voice' | 'wake' | 'diagnostics'
const tabs = computed(() => [
  ...(slots['audio-processing'] ? [{ key: 'audio' as const, label: '音频处理' }] : []),
  { key: 'model' as const, label: '大模型' },
  { key: 'voice' as const, label: '语音' },
  { key: 'wake' as const, label: '唤醒词' },
  { key: 'diagnostics' as const, label: '语音诊断' },
])
const activeTab = ref<TabKey>(slots['audio-processing'] ? 'audio' : 'model')
const contentRef = ref<HTMLElement | null>(null)
watch(activeTab, () => contentRef.value?.scrollTo({ top: 0 }))
const FILLER_MAX_COUNT = 20
const FILLER_MAX_LENGTH = 20
const voiceOptions = [
  { value: '冰糖', label: '冰糖' },
  { value: '茉莉', label: '茉莉' },
  { value: '苏打', label: '苏打' },
  { value: '白桦', label: '白桦' },
  { value: 'Mia', label: 'Mia' },
  { value: 'Chloe', label: 'Chloe' },
  { value: 'Milo', label: 'Milo' },
  { value: 'Dean', label: 'Dean' },
]
const form = reactive({ baseUrl: '', model: '', systemPrompt: '', apiKey: '', ttsApiKey: '', tts: { enabled: true, provider: 'xiaomi', voice: '冰糖', filler: true, fillers: [] as string[] } })
const newFiller = ref('')
const fillerError = ref('')
const configured = ref(false)
const ttsConfigured = ref(false)
const loading = ref(true)
const saving = ref(false)
const error = ref('')
const success = ref('')
const timingAnalysis = ref(speechTimingAnalysis())
const formatTiming = (value: number | null) => value === null ? '未采集' : `${Math.round(value)} ms`
const diagnostic = ref(diagnosticsState())
let diagnosticTimer: ReturnType<typeof setInterval> | undefined
function updateDiagnostics(event: Event, audio = false) {
  const checked = (event.target as HTMLInputElement).checked
  configureSpeechDiagnostics(audio ? diagnostic.value.enabled : checked, audio ? checked : diagnostic.value.captureAudio)
  diagnostic.value = diagnosticsState()
}
function clearDiagnostics() { clearSpeechDiagnostics(); diagnostic.value = diagnosticsState(); timingAnalysis.value = [] }
onUnmounted(() => clearInterval(diagnosticTimer))
const wakeKeywords = ref<WakeKeyword[]>(defaultWakeKeywords.map(item => ({ ...item })))
const wakeError = ref('')
const wakeRecognizing = ref(new Set<WakeKeyword>())
const wakeRequests = new Map<WakeKeyword, AbortController>()
onUnmounted(() => { for (const controller of wakeRequests.values()) controller.abort() })
function invalidateWakeKeyword(item: WakeKeyword) {
  wakeRequests.get(item)?.abort(); wakeRequests.delete(item); wakeRecognizing.value.delete(item)
  item.phonemes = ''; item.variants = []; wakeError.value = ''
}
async function recognizeWakeKeyword(item: WakeKeyword) {
  const text = item.text.trim()
  if (!/^[\u4e00-\u9fff]{1,20}$/.test(text)) { wakeError.value = '请先输入 1–20 个汉字'; return }
  wakeRequests.get(item)?.abort()
  const controller = new AbortController(); wakeRequests.set(item, controller)
  wakeRecognizing.value.add(item); wakeError.value = ''
  try {
    const response = await fetch('/api/wake/phonemes', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(65000)]),
    })
    const data = await response.json()
    if (!response.ok) throw new Error(data.error || '发音识别失败，请重试')
    if (controller.signal.aborted || item.text.trim() !== text || !wakeKeywords.value.includes(item)) return
    if (data.text !== text || typeof data.phonemes !== 'string' || !Array.isArray(data.variants)) throw new Error('发音识别结果无效，请重试')
    item.text = text; item.phonemes = data.phonemes; item.variants = data.variants
  } catch (e) {
    if (!controller.signal.aborted) wakeError.value = e instanceof Error ? e.message : '发音识别失败，请重试'
  } finally {
    if (wakeRequests.get(item) === controller) { wakeRequests.delete(item); wakeRecognizing.value.delete(item) }
  }
}
function addWakeKeyword() {
  if (wakeKeywords.value.length >= 10) { wakeError.value = '最多配置 10 个唤醒词'; return }
  wakeKeywords.value.push({ text: '', phonemes: '' }); wakeError.value = ''
}
function removeWakeKeyword(index: number) { const item = wakeKeywords.value[index]; if (item) invalidateWakeKeyword(item); wakeKeywords.value.splice(index, 1); wakeError.value = '' }
function saveWakeKeywords() {
  if (wakeRecognizing.value.size) { wakeError.value = '请等待发音识别完成后保存'; return false }
  const items = wakeKeywords.value.map(item => ({ text: item.text.trim(), phonemes: item.phonemes.trim().replace(/\s+/g, ' '), variants: item.variants || [] }))
  if (!items.length || items.some(item => !item.text || !item.phonemes)) { wakeError.value = '请为每个中文唤醒词点击“识别”后再保存'; return false }
  if (items.some(item => item.text.length > 20 || !/^[\u4e00-\u9fff]+$/.test(item.text))) { wakeError.value = '唤醒词请填写 1–20 个汉字'; return false }
  if (items.some(item => !/^[\p{L}\p{M}\s]+$/u.test(item.phonemes))) { wakeError.value = '拼音音素只可包含字母、声调符号和空格'; return false }
  if (new Set(items.map(item => item.text)).size !== items.length) { wakeError.value = '唤醒词不能重复'; return false }
  wakeKeywords.value = items
  localStorage.setItem('voice.wakeKeywords', JSON.stringify(items))
  wakeError.value = ''
  return true
}
async function load() {
  loading.value = true; error.value = ''
  try {
    try {
      const saved = JSON.parse(localStorage.getItem('voice.wakeKeywords') || 'null')
      if (Array.isArray(saved) && saved.length) wakeKeywords.value = saved
    } catch { /* use defaults if local settings are malformed */ }
    const response = await fetch('/api/settings')
    const data = await response.json()
    if (!response.ok) throw new Error(data.error || '配置加载失败')
    Object.assign(form, { baseUrl: data.baseUrl, model: data.model, systemPrompt: data.systemPrompt, tts: { ...(data.tts || { enabled: true, provider: 'xiaomi', voice: '冰糖' }), filler: data.tts?.filler !== false, fillers: Array.isArray(data.tts?.fillers) ? [...data.tts.fillers] : [] } })
    configured.value = data.apiKeyConfigured
    ttsConfigured.value = data.ttsApiKeyConfigured
  } catch (e) { error.value = e instanceof Error ? e.message : '无法连接配置服务' }
  finally { loading.value = false }
}
function addFiller() {
  const text = newFiller.value.trim()
  if (!text) { fillerError.value = '请先输入衔接词'; return }
  if (text.length > FILLER_MAX_LENGTH) { fillerError.value = `衔接词不超过 ${FILLER_MAX_LENGTH} 个字`; return }
  if (form.tts.fillers.includes(text)) { fillerError.value = '该衔接词已存在'; return }
  if (form.tts.fillers.length >= FILLER_MAX_COUNT) { fillerError.value = `最多添加 ${FILLER_MAX_COUNT} 条衔接词`; return }
  form.tts.fillers.push(text)
  newFiller.value = ''
  fillerError.value = ''
}
function removeFiller(index: number) {
  form.tts.fillers.splice(index, 1)
  fillerError.value = ''
}
async function save() {
  saving.value = true; error.value = ''; success.value = ''
  try {
    if (!saveWakeKeywords()) { saving.value = false; return }
    const response = await fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) })
    const data = await response.json()
    if (!response.ok) throw new Error(data.error || '保存失败')
    configured.value = data.apiKeyConfigured
    ttsConfigured.value = data.ttsApiKeyConfigured
    form.apiKey = ''; form.ttsApiKey = ''; success.value = '配置已保存，下一次模型请求立即生效。'
  } catch (e) { error.value = e instanceof Error ? e.message : '配置保存失败' }
  finally { saving.value = false }
}
onMounted(() => {
  dialog.value?.showModal(); void load()
  diagnosticTimer = setInterval(() => { diagnostic.value = diagnosticsState(); timingAnalysis.value = speechTimingAnalysis() }, 1000)
})
</script>
<template>
  <dialog ref="dialog" class="settings-dialog" aria-labelledby="settings-title" @close="emit('close')" @click.self="close">
  <main class="settings-page">
    <header><div><h1 id="settings-title">设置</h1><p>管理语音对话的音频处理和模型服务</p></div><button type="button" class="close-button" aria-label="关闭设置" @click="close"><img :src="closeIcon" alt="" /></button></header>
    <div class="settings-body">
      <nav class="settings-nav" aria-label="设置分类">
        <button v-for="tab in tabs" :key="tab.key" type="button" :class="{ active: activeTab === tab.key }" :aria-current="activeTab === tab.key ? 'page' : undefined" @click="activeTab = tab.key">{{ tab.label }}</button>
      </nav>
      <div ref="contentRef" class="settings-content">
        <section v-show="activeTab === 'audio'" class="settings-panel">
          <slot name="audio-processing" />
        </section>
        <section v-show="activeTab === 'diagnostics'" class="settings-panel diagnostic-panel">
          <h2>语音诊断</h2>
          <label class="tts-toggle"><input :checked="diagnostic.enabled" type="checkbox" @change="updateDiagnostics($event)" /> 记录语音诊断日志（立即生效）</label>
          <label class="tts-toggle"><input :checked="diagnostic.captureAudio" :disabled="!diagnostic.enabled" type="checkbox" @change="updateDiagnostics($event, true)" /> 保留最近一条回答的合成音频</label>
          <small>开启后重新对话，听到杂音时停止对话并导出。日志只记录时间、缓冲、音量和波形指标，不记录对话正文、密钥或麦克风音频。合成音频包含助手朗读内容，单独开启后才保留。</small>
          <p>已记录 {{ diagnostic.events }} 条；已覆盖 {{ diagnostic.dropped }} 条旧记录；音频 {{ (diagnostic.audioBytes / 1024).toFixed(1) }} KB{{ diagnostic.audioTruncated ? '（达到上限或格式变化，已截断）' : '' }}。</p>
          <p>开启后，每轮记录识别确认、话轮提交、模型首字、逐句合成及播放调度时间。下表显示最近 10 次回答，导出日志包含全部保留记录和分析。播放时间按浏览器音频时钟估算，不含设备输出延迟；最大阶段仅比较已采集的节点。</p>
          <div class="timing-table" v-if="timingAnalysis.length">
            <table>
              <thead><tr><th>回答 / 状态</th><th>话轮等待</th><th>模型首字</th><th>首句准备</th><th>TTS 首包</th><th>说完到播放</th><th>最大已测阶段</th></tr></thead>
              <tbody><tr v-for="row in timingAnalysis.slice(-10).reverse()" :key="String(row.player)">
                <td>{{ row.trace || row.player }} / {{ row.status }}{{ row.speechFailed ? '（语音失败）' : '' }}</td>
                <td>{{ formatTiming(row.metrics.turnWaitMs) }}</td><td>{{ formatTiming(row.metrics.modelFirstDeltaMs) }}</td>
                <td>{{ formatTiming(row.metrics.firstPhraseMs) }}</td><td>{{ formatTiming(row.metrics.ttsFirstAudioMs) }}</td>
                <td>{{ formatTiming(row.metrics.silenceToPlaybackMs) }}</td><td>{{ row.largestObservedStage?.label || '未采集' }}</td>
              </tr></tbody>
            </table>
          </div>
          <div class="diagnostic-actions">
            <button type="button" :disabled="!diagnostic.enabled" @click="recordSpeechDiagnostic('user.noise_marker')">标记刚才的杂音</button>
            <button type="button" :disabled="!diagnostic.events" @click="downloadSpeechDiagnostics('json')">导出诊断日志</button>
            <button type="button" :disabled="!diagnostic.audioBytes" @click="downloadSpeechDiagnostics('wav')">导出原始合成音频</button>
            <button type="button" @click="clearDiagnostics">清空记录</button>
          </div>
          <small>记录只保存在当前页面内存，刷新后清空并关闭诊断。最多保留 4000 条日志、8MB 合成音频。WAV 按接收顺序拼接，不包含播放停顿、降音量或设备输出效果；可用于和实时播报对比。</small>
        </section>
        <template v-if="activeTab !== 'audio' && activeTab !== 'diagnostics'">
          <p v-if="loading">正在读取配置…</p>
          <form v-else-if="form.baseUrl" @submit.prevent="save">
          <section v-show="activeTab === 'model'" class="settings-panel">
            <h2>大模型 · OpenAI 兼容</h2>
            <label>接口地址<input v-model="form.baseUrl" required type="url" placeholder="https://api.openai.com/v1" /><small>填写基础地址，系统自动追加 /chat/completions。</small></label>
            <label>模型名称<input v-model="form.model" required maxlength="200" placeholder="例如 gpt-4o-mini" /></label>
            <label>API Key <span>{{ configured ? '已配置' : '未配置' }}</span><input v-model="form.apiKey" type="password" autocomplete="new-password" :placeholder="configured ? '留空保留当前密钥' : '输入服务商提供的 API Key'" /><small>密钥只在服务端使用，保存后不会回显。</small></label>
            <label>系统提示词<textarea v-model="form.systemPrompt" rows="6" maxlength="16000" /></label>
          </section>
          <section v-show="activeTab === 'voice'" class="settings-panel voice-panel">
            <h2>助手语音 · 小米 MiMo</h2>
            <label class="tts-toggle"><input v-model="form.tts.enabled" type="checkbox" /> 自动朗读回答</label>
            <label class="tts-toggle"><input v-model="form.tts.filler" type="checkbox" /> 思考时先说衔接词</label>
            <div v-if="form.tts.filler" class="filler-editor">
              <p class="filler-title">衔接词（根据对话选择，也可能保持安静）</p>
              <ul class="filler-list">
                <li v-for="(item, index) in form.tts.fillers" :key="index"><span>{{ item }}</span><button type="button" class="filler-remove" :aria-label="`删除衔接词 ${item}`" @click="removeFiller(index)">删除</button></li>
                <li v-if="!form.tts.fillers.length" class="filler-empty">还没有衔接词，思考时不会开口。</li>
              </ul>
              <div class="filler-add">
                <input v-model="newFiller" maxlength="20" placeholder="例如：稍等一下……" @keyup.enter.prevent="addFiller" />
                <button type="button" @click="addFiller">添加</button>
              </div>
              <p v-if="fillerError" class="filler-error">{{ fillerError }}</p>
              <small>最多 {{ FILLER_MAX_COUNT }} 条，每条不超过 {{ FILLER_MAX_LENGTH }} 字；删光后不再播放衔接词。</small>
            </div>
            <div class="field"><label for="tts-voice">音色</label><AppSelect id="tts-voice" v-model="form.tts.voice" :options="voiceOptions" /></div>
            <label>小米 TTS API Key <span>{{ ttsConfigured ? '已配置' : '未配置' }}</span><input v-model="form.ttsApiKey" type="password" autocomplete="new-password" :placeholder="ttsConfigured ? '留空保留当前密钥' : '输入小米 MiMo 平台 API Key'" /><small>与 DeepSeek 密钥独立配置，使用 MiMo-V2.5-TTS 预置音色流式合成。</small></label>
          </section>
          <section v-show="activeTab === 'wake'" class="settings-panel wake-panel">
            <h2>语音唤醒词 · 浏览器本地识别</h2>
            <p>输入中文后点击“识别”，使用已保存的大模型配置生成发音，并补齐常见变调和声调容错，无需输入拼音。容错读音越多，也越容易误唤醒。</p>
            <div v-for="(item, index) in wakeKeywords" :key="index" class="wake-item">
              <label>中文唤醒词<input v-model="item.text" maxlength="20" placeholder="例如：你好小美" :disabled="saving" @input="invalidateWakeKeyword(item)" /></label>
              <button type="button" class="wake-add" :disabled="saving || wakeRecognizing.has(item) || !item.text.trim()" @click="recognizeWakeKeyword(item)">{{ wakeRecognizing.has(item) ? '识别中…' : item.phonemes ? '重新识别' : '识别' }}</button>
              <button type="button" class="filler-remove" @click="removeWakeKeyword(index)">删除</button>
              <div class="wake-result" aria-live="polite">
                <span>{{ wakeRecognizing.has(item) ? '正在生成发音…' : item.phonemes ? `已准备 ${1 + (item.variants?.length || 0)} 种读音` : '待识别' }}</span>
                <details v-if="item.phonemes"><summary>查看发音</summary><p v-for="value in [item.phonemes, ...(item.variants || [])]" :key="value">{{ value }}</p></details>
              </div>
            </div>
            <button type="button" class="wake-add" @click="addWakeKeyword">添加唤醒词</button>
            <p v-if="wakeError" role="alert" class="filler-error">{{ wakeError }}</p>
            <small>最多 10 项，保存后下次开启语音唤醒时生效；配置保存在当前浏览器。</small>
          </section>
          <footer><p>普通配置保存在本地 JSON；密钥保存在服务端 .env。</p><button :disabled="saving || wakeRecognizing.size > 0">{{ saving ? '保存中…' : '保存配置' }}</button></footer>
          </form>
        </template>
        <p v-if="error" role="alert" class="error">{{ error }} <button v-if="!form.baseUrl" @click="load">重新加载</button></p>
        <p v-if="success" role="status" class="success">{{ success }}</p>
      </div>
    </div>
  </main>
  </dialog>
</template>
<style scoped>
.settings-dialog { width:min(880px,calc(100% - 32px)); height:min(620px,calc(100dvh - 48px)); padding:0; border:1px solid rgba(100,230,250,.18); border-radius:20px; color:#dff8fc; background:linear-gradient(180deg, rgba(6,22,29,.98), rgba(3,12,17,.99)); box-shadow:0 30px 100px rgba(0,0,0,.7), 0 0 0 1px rgba(0,0,0,.4); overflow:hidden; }
.settings-dialog::backdrop { background:rgba(0,8,12,.75); backdrop-filter:blur(6px); }
.settings-page { display:flex; flex-direction:column; height:100%; min-height:0; overflow:hidden; }
.settings-body { flex:1 1 auto; display:flex; min-height:0; }
.settings-nav { flex:none; display:flex; flex-direction:column; gap:4px; width:172px; padding:0 14px 20px 22px; border-right:1px solid rgba(100,220,240,.12); overflow-y:auto; overscroll-behavior:contain; }
.settings-nav button { width:100%; padding:10px 12px; border:1px solid transparent; border-radius:10px; background:transparent; color:#7fa9b3; font:inherit; font-size:13.5px; font-weight:600; text-align:left; letter-spacing:.01em; transition:background-color .16s ease,color .16s ease,border-color .16s ease; }
.settings-nav button:hover { color:#dff8fc; background:rgba(10,32,40,.6); }
.settings-nav button.active { color:#e6fdff; border-color:rgba(110,240,255,.28); background:rgba(20,200,216,.12); box-shadow:inset 2px 0 0 #28dfee; }
.settings-content { flex:1 1 auto; min-width:0; min-height:0; padding:0 22px 0; overflow-y:auto; overscroll-behavior:contain; scrollbar-gutter:stable; scrollbar-width:thin; scrollbar-color:rgba(90,200,220,.35) transparent; }
.close-button { display:grid; place-items:center; width:32px; height:32px; padding:0; border:1px solid rgba(110,240,255,.18); border-radius:9px; background:rgba(8,30,38,.5); flex:none; }
.close-button img { width:12px; height:12px; opacity:.8; }
.close-button:hover { border-color:rgba(130,245,255,.5); }
button:focus-visible { outline:1px solid rgba(140,246,255,.8); outline-offset:3px; }
header { flex:none; display:flex; justify-content:space-between; align-items:center; padding:20px 22px 22px; gap:20px; }
h1 {font-size:21px; color:#e6fdff; font-weight:600; letter-spacing:.03em;} header p { color:#6f9aa4; margin-top:8px; font-size:12.5px; } a {color:#6deeff; text-decoration:none;}
form {display:flex; flex-direction:column; gap:20px;}
.settings-panel {display:grid; gap:20px; align-content:start; padding-bottom:22px;}
h2 {font-size:16px; color:#dff8fc; font-weight:600; letter-spacing:.02em;} label {display:grid; gap:8px; font-size:13.5px; font-weight:600; color:#cfeef3;} label span {font-size:11.5px; color:#6deeff;}
.field {display:grid; gap:8px; font-size:13.5px; font-weight:600; color:#cfeef3;} .field > label {display:block; font-size:inherit; font-weight:inherit; color:inherit;}
.tts-toggle {display:flex; align-items:center; gap:8px;} .tts-toggle input {width:auto; accent-color:#14c8d8;}
.diagnostic-panel p {font-size:13px; line-height:1.7; color:#7fa9b3;}
.diagnostic-actions {display:flex; flex-wrap:wrap; gap:8px;}
.diagnostic-actions button {padding:8px 12px; border:1px solid rgba(110,240,255,.3); border-radius:9px; background:rgba(8,30,38,.6); color:#dff8fc;}
.diagnostic-actions button:disabled {opacity:.4; cursor:default;}
.filler-editor {display:grid; gap:10px; padding:13px 15px; border:1px solid rgba(100,220,240,.12); border-radius:12px; background:rgba(6,22,29,.45);} .filler-title {margin:0; font-size:13px; font-weight:600; color:#cfeef3;}
.filler-list {list-style:none; margin:0; padding:0; display:grid; gap:6px;} .filler-list li {display:flex; align-items:center; justify-content:space-between; gap:12px; padding:7px 11px; border-radius:9px; background:rgba(8,26,34,.7); font-size:13px; font-weight:400; color:#dff8fc;} .filler-list .filler-empty {justify-content:flex-start; color:#5f8e99; font-size:12px;}
.filler-remove {flex:none; padding:3px 12px; border:1px solid rgba(255,157,138,.35); border-radius:999px; background:transparent; color:#ff9d8a; font:inherit; font-size:12px; white-space:nowrap;} .filler-remove:hover {border-color:rgba(255,157,138,.75);}
.filler-add {display:flex; gap:8px;} .filler-add input {flex:1 1 0%; min-width:0;} .filler-add button {flex:none; padding:0 16px; border:1px solid rgba(110,240,255,.3); border-radius:9px; background:rgba(8,30,38,.6); color:#dff8fc; font:inherit; font-size:13px; white-space:nowrap;} .filler-add button:hover {border-color:rgba(130,245,255,.6);}
.filler-error {margin:0; color:#ff9d8a; font-size:12px;}
.wake-panel > p { margin:0; color:#7fa9b3; font-size:12px; line-height:1.7; }
.wake-item { display:grid; grid-template-columns:1fr auto auto; align-items:end; gap:10px; padding:12px; border:1px solid rgba(100,220,240,.12); border-radius:12px; background:rgba(6,22,29,.45); }
.wake-result { grid-column:1 / -1; color:#7fa9b3; font-size:12px; }
.wake-result details { margin-top:6px; }
.wake-result summary { cursor:pointer; }
.wake-result p { overflow-wrap:anywhere; }
.wake-item .filler-remove { height:36px; }
.wake-add { justify-self:start; padding:8px 14px; border:1px solid rgba(110,240,255,.3); border-radius:9px; background:rgba(8,30,38,.6); color:#dff8fc; font:inherit; font-size:13px; }
input,textarea {font:inherit; font-weight:400; border:1px solid rgba(100,220,240,.16); border-radius:9px; padding:11px 12px; width:100%; color:#e2fbff; background:rgba(8,26,34,.7);} input::placeholder,textarea::placeholder {color:#4f7882;}
.voice-panel input:not([type='checkbox']), .voice-panel :deep(.ui-select-trigger) {padding:8px 12px;}
input:focus,textarea:focus {outline:1px solid rgba(140,246,255,.75); outline-offset:1px; border-color:rgba(110,240,255,.5);} small,footer p {color:#5f8e99; font-size:11.5px; font-weight:400; line-height:1.6;}
footer {position:sticky; bottom:0; z-index:1; display:flex; align-items:center; justify-content:space-between; gap:20px; margin:0 -22px; padding:16px 22px 22px; border-top:1px solid rgba(100,220,240,.12); background:linear-gradient(180deg, rgba(5,19,25,.92), rgba(4,15,20,.99) 45%); backdrop-filter:blur(6px);} footer button {background:linear-gradient(180deg,#28dfee,#0fa9bd); color:#00242b; font-weight:600; padding:11px 20px; border-radius:999px; white-space:nowrap; box-shadow:0 12px 30px -14px rgba(40,223,238,.75);} footer button:hover:not(:disabled) {filter:brightness(1.08);} footer button:disabled {opacity:.5; cursor:wait;}
.error,.success {margin-top:16px; line-height:1.7; font-size:13px;} .error {color:#ff9d8a;} .error button {color:#7ff3ff; text-decoration:underline;} .success {color:#7ff3cf;}
@media (max-width:540px) { header { padding:16px 14px 16px; } .settings-body { flex-direction:column; } .settings-nav { flex-direction:row; width:auto; padding:0 14px 12px; border-right:none; border-bottom:1px solid rgba(100,220,240,.12); overflow-x:auto; } .settings-nav button { width:auto; white-space:nowrap; } .settings-nav button.active { box-shadow:inset 0 -2px 0 #28dfee; } .settings-content { padding:14px 14px 0; min-height:0; } .wake-item { grid-template-columns:1fr; } footer { margin:0 -14px; padding:14px 14px 16px; } footer { align-items:flex-start; flex-direction:column; } footer button { align-self:flex-end; } }
</style>

<style scoped>
.timing-table { overflow-x:auto; font-size:12px; color:#b6d4dc; }
.timing-table table { border-collapse:collapse; min-width:780px; width:100%; }
.timing-table th,.timing-table td { padding:8px; border-bottom:1px solid #23434c; text-align:left; }
</style>
