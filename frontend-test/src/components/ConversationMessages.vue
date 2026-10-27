<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from 'vue'
import type { Conversation } from '@/chat/conversation'
import userAvatar from '@/assets/voice/avatar-user.svg'
import assistantAvatar from '@/assets/voice/avatar-assistant.svg'
const props = defineProps<{ conversation: Conversation; interim?: string }>()
const emit = defineEmits<{ retry: [index: number] }>()
const container = ref<HTMLElement>()
onMounted(async () => {
  await nextTick()
  if (container.value) container.value.scrollTop = container.value.scrollHeight
})
watch(() => [props.conversation.turns.map(t => `${t.status}${t.visibleAssistant}`).join(''), props.interim], async () => {
  const el = container.value
  const nearBottom = !el || el.scrollHeight - el.scrollTop - el.clientHeight < 100
  await nextTick()
  if (nearBottom && container.value) container.value.scrollTop = container.value.scrollHeight
})
</script>
<template>
  <div ref="container" class="messages" aria-live="polite">
    <template v-for="turn in conversation.turns" :key="turn.index">
      <div v-if="turn.user" class="message user"><small><img class="avatar" :src="userAvatar" alt="" aria-hidden="true" />你</small><p>{{ turn.user }}</p></div>
      <div class="message assistant"><small>助手<img class="avatar" :src="assistantAvatar" alt="" aria-hidden="true" /></small>
        <p v-if="turn.visibleAssistant">{{ turn.visibleAssistant }}</p>
        <p v-if="turn.status === 'error'" class="failure">{{ turn.error }} <button @click="emit('retry', turn.index)">重试</button></p>
        <p v-else-if="turn.status === 'interrupted'">已被打断</p>
        <p v-else-if="!turn.visibleAssistant">{{ turn.assistant ? '正在准备语音…' : turn.status === 'loading' ? '正在思考…' : '等待前一条回答…' }}</p>
        <p v-if="turn.speechError" class="failure">语音：{{ turn.speechError }}</p>
      </div>
    </template>
    <div v-if="interim" class="message user interim"><small><img class="avatar" :src="userAvatar" alt="" aria-hidden="true" />你 · 识别中</small><p>{{ interim }}</p></div>
    <p v-if="!conversation.turns.length && !interim" class="placeholder">还没有提问，开口说话后显示在这里。</p>
  </div>
</template>
<style scoped>
.messages { flex:1; min-height:0; display:flex; flex-direction:column; gap:8px; overflow-y:auto; overscroll-behavior:contain; padding:0 2px; scrollbar-width:thin; scrollbar-color:rgba(90,200,220,.35) transparent; scroll-behavior:smooth; }
.message { display:flex; flex-direction:column; width:fit-content; max-width:85%; line-height:1.6; overflow-wrap:anywhere; }
.message small { display:flex; align-items:center; gap:5px; font-size:11px; color:rgba(223,248,252,.6); margin-bottom:4px; line-height:1.2; }
.avatar { width:16px; height:16px; flex:none; }
.message p { margin:0; white-space:pre-wrap; font-size:14px; }
.user { align-self:flex-start; color:#d8f5fa; }
.user small { align-self:flex-start; }
.assistant { align-self:flex-end; color:#eafeff; }
.assistant small { align-self:flex-end; }
.interim { opacity:.7; }
.failure { color:#ff9d8a; }
.failure button { text-decoration:underline; color:#7ff3ff; }
.placeholder { color:#6f9aa4; font-size:13px; line-height:1.8; }
</style>
