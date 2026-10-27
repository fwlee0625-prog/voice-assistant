<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import groundUrl from '@/assets/voice/ground-rings.svg'
import micUrl from '@/assets/voice/mic.svg'
import orbUrl from '@/assets/voice/orb.svg'
import orbitFrameUrl from '@/assets/voice/orbit-frame.svg'
import orbitSpinUrl from '@/assets/voice/orbit-spin.svg'
import { createVoiceStageScene, type StageMode, type VoiceStageScene } from '@/voice/stageScene'

const props = defineProps<{
  mode: StageMode
  analyser?: AnalyserNode | null
  disabled?: boolean
  label: string
  active?: boolean
}>()

const emit = defineEmits<{ activate: [] }>()

// 高度为球体直径的百分比；gain 控制跟随音量的伸缩幅度，dur/delay 让各条独立起伏
const waveBars = [
  { h: '3.2%', gain: 0.04, dur: '2100ms', delay: '0ms' },
  { h: '9%', gain: 0.09, dur: '1700ms', delay: '-700ms' },
  { h: '14.5%', gain: 0.15, dur: '2400ms', delay: '-1300ms' },
  { h: '19%', gain: 0.21, dur: '1900ms', delay: '-300ms' },
  { h: '22%', gain: 0.26, dur: '2600ms', delay: '-1900ms' },
  { h: '12%', gain: 0.12, dur: '1800ms', delay: '-1100ms' },
  { h: '17.5%', gain: 0.18, dur: '2300ms', delay: '-500ms' },
  { h: '7%', gain: 0.07, dur: '2000ms', delay: '-1600ms' },
  { h: '3.2%', gain: 0.04, dur: '2500ms', delay: '-900ms' },
]

const rootRef = ref<HTMLElement | null>(null)
const orbRef = ref<HTMLButtonElement | null>(null)
const groundRef = ref<HTMLImageElement | null>(null)
const backCanvasRef = ref<HTMLCanvasElement | null>(null)
const frontCanvasRef = ref<HTMLCanvasElement | null>(null)

let scene: VoiceStageScene | null = null
let resizeObserver: ResizeObserver | null = null

function updateLayout() {
  const root = rootRef.value
  const orb = orbRef.value
  const ground = groundRef.value
  if (!scene || !root || !orb || !ground) return
  const rootRect = root.getBoundingClientRect()
  if (!rootRect.width || !rootRect.height) return
  const orbRect = orb.getBoundingClientRect()
  const groundRect = ground.getBoundingClientRect()
  scene.resize({
    width: rootRect.width,
    height: rootRect.height,
    centerX: orbRect.left + orbRect.width / 2 - rootRect.left,
    centerY: orbRect.top + orbRect.height / 2 - rootRect.top,
    orbRadius: orbRect.width / 2,
    groundY: groundRect.top + groundRect.height * (135 / 260) - rootRect.top,
  })
}

onMounted(() => {
  const root = rootRef.value
  const back = backCanvasRef.value
  const front = frontCanvasRef.value
  if (!root || !back || !front) return
  scene = createVoiceStageScene(back, front, (level, orbScale) => {
    root.style.setProperty('--level', level.toFixed(3))
    root.style.setProperty('--orb-scale', orbScale.toFixed(4))
  })
  scene.setMode(props.mode)
  scene.setAnalyser(props.analyser ?? null)
  void nextTick(updateLayout)
  resizeObserver = new ResizeObserver(updateLayout)
  resizeObserver.observe(root)
  window.addEventListener('resize', updateLayout)
})

onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  resizeObserver = null
  window.removeEventListener('resize', updateLayout)
  scene?.destroy()
  scene = null
})

watch(
  () => props.mode,
  (mode) => scene?.setMode(mode),
)
watch(
  () => props.analyser,
  (analyser) => scene?.setAnalyser(analyser ?? null),
)

function activate() {
  scene?.pulse()
  emit('activate')
}
</script>

<template>
  <div ref="rootRef" class="voice-stage" :data-mode="mode" :data-conversation="active ? 'true' : 'false'">
    <canvas ref="backCanvasRef" class="stage-canvas canvas-back" aria-hidden="true" />
    <img ref="groundRef" class="ground" :src="groundUrl" alt="" aria-hidden="true" draggable="false" />
    <img class="orbit orbit-frame" :src="orbitFrameUrl" alt="" aria-hidden="true" draggable="false" />
    <img class="orbit orbit-spin" :src="orbitSpinUrl" alt="" aria-hidden="true" draggable="false" />
    <button
      ref="orbRef"
      type="button"
      class="orb-button"
      :aria-label="label"
      :aria-pressed="mode === 'listening' || mode === 'answering'"
      :disabled="disabled"
      @click="activate"
    >
      <span class="orb-aura" aria-hidden="true" />
      <span class="orb-breath" aria-hidden="true">
        <span class="orb-scale">
          <img class="orb-image" :src="orbUrl" alt="" draggable="false" />
          <img class="orb-mic" :src="micUrl" alt="" draggable="false" />
          <span class="orb-wave" aria-hidden="true">
            <span
              v-for="(bar, index) in waveBars"
              :key="index"
              class="wave-bar"
              :style="{ '--h': bar.h, '--gain': bar.gain, '--dur': bar.dur, '--delay': bar.delay }"
            >
              <span class="wave-bar-fill" />
            </span>
          </span>
        </span>
      </span>
    </button>
    <canvas ref="frontCanvasRef" class="stage-canvas canvas-front" aria-hidden="true" />
  </div>
</template>

<style scoped>
.voice-stage {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  pointer-events: none;
  user-select: none;
}

.stage-canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
}

.canvas-back {
  z-index: 0;
}

.canvas-front {
  z-index: 6;
}

.ground {
  position: absolute;
  left: 50%;
  top: calc(var(--orb-top) + var(--orb-size) * 0.91);
  z-index: 1;
  width: min(112%, calc(var(--orb-size) * 4.3));
  transform: translate(-50%, -51.9%);
  opacity: 1;
  filter: saturate(1.6) brightness(1.3);
  mix-blend-mode: screen;
  pointer-events: none;
}

.orbit {
  position: absolute;
  left: 50%;
  top: var(--orb-top);
  z-index: 2;
  display: block;
  translate: -50% -50%;
  pointer-events: none;
}

.orbit-frame {
  width: calc(var(--orb-size) * 1.96);
  opacity: 0.78;
  transition: opacity 600ms ease;
}

.orbit-spin {
  z-index: 3;
  width: calc(var(--orb-size) * 2.14);
  opacity: 0.65;
  animation: orbit-spin 90s linear infinite;
  transition: opacity 600ms ease;
}

.voice-stage[data-mode='listening'] .orbit-frame,
.voice-stage[data-mode='answering'] .orbit-frame {
  opacity: 0.95;
}

.voice-stage[data-mode='listening'] .orbit-spin,
.voice-stage[data-mode='answering'] .orbit-spin {
  opacity: 0.85;
}

.orb-button {
  position: absolute;
  left: 50%;
  top: var(--orb-top);
  z-index: 5;
  display: grid;
  place-items: center;
  width: var(--orb-size);
  height: var(--orb-size);
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: transparent;
  translate: -50% -50%;
  pointer-events: auto;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}

.orb-button:hover:not(:disabled) .orb-image {
  filter: drop-shadow(0 0 16px rgba(36, 201, 215, 0.2)) brightness(1.08);
}

.orb-button:disabled {
  cursor: default;
}

.orb-button:focus-visible {
  outline: 1px solid rgba(158, 250, 255, 0.8);
  outline-offset: 16px;
}

.orb-aura {
  position: absolute;
  inset: -30%;
  border-radius: 50%;
  background: radial-gradient(
    circle,
    rgba(21, 185, 196, 0.05) 0%,
    rgba(12, 156, 181, 0.04) 40%,
    rgba(20, 150, 176, 0.04) 64%,
    transparent 74%
  );
  filter: blur(8px);
  opacity: calc(0.42 + var(--level, 0) * 0.85);
  animation: aura-drift 6.4s ease-in-out infinite;
  pointer-events: none;
}

.orb-breath {
  display: grid;
  place-items: center;
  width: 100%;
  height: 100%;
  transform: scale(var(--orb-scale, 1));
  will-change: transform;
}

.orb-scale {
  position: relative;
  display: grid;
  place-items: center;
  width: 100%;
  height: 100%;
}

.orb-image {
  width: 100%;
  height: 100%;
  display: block;
  filter: drop-shadow(0 0 14px rgba(24, 184, 202, 0.14));
  transition: filter 500ms ease;
}

.voice-stage[data-mode='listening'] .orb-image,
.voice-stage[data-mode='answering'] .orb-image {
  filter: drop-shadow(0 0 18px rgba(32, 207, 208, 0.22))
    brightness(1.08) saturate(1.12);
}

.orb-mic {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 24%;
  transform: translate(-50%, -50%);
  filter: drop-shadow(0 2px 10px rgba(0, 30, 40, 0.45));
  pointer-events: none;
  transition: opacity 260ms ease;
}

.voice-stage[data-conversation='true'] .orb-mic {
  opacity: 0;
}

.orb-wave {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 1.25%;
  opacity: 0;
  pointer-events: none;
  transition: opacity 260ms ease;
}

.voice-stage[data-conversation='true'] .orb-wave {
  opacity: 1;
}

.wave-bar {
  flex: none;
  width: 2%;
  height: var(--h);
  transform: scaleY(calc(0.84 + var(--level, 0) * var(--gain, 0.2)));
  transform-origin: center;
}

.wave-bar-fill {
  display: block;
  width: 100%;
  height: 100%;
  border-radius: 999px;
  background: linear-gradient(180deg, #ffffff 0%, #f0ffff 58%, #c8fbf5 100%);
  box-shadow: 0 0 10px rgba(190, 255, 255, 0.28);
  transform: scaleY(0.92);
  animation: bar-sway var(--dur, 2000ms) ease-in-out var(--delay, 0ms) infinite;
  animation-play-state: paused;
  will-change: transform;
}

.voice-stage[data-conversation='true'] .wave-bar-fill {
  animation-play-state: running;
}

@keyframes bar-sway {
  0%,
  100% {
    transform: scaleY(0.92);
  }
  50% {
    transform: scaleY(1.08);
  }
}

@keyframes aura-drift {
  0%,
  100% {
    transform: scale(1);
    opacity: calc(0.4 + var(--level, 0) * 0.8);
  }
  50% {
    transform: scale(1.06);
    opacity: calc(0.52 + var(--level, 0) * 0.9);
  }
}

@keyframes orbit-spin {
  from {
    rotate: 0deg;
  }
  to {
    rotate: 360deg;
  }
}

@media (prefers-reduced-motion: reduce) {
  .orbit-spin,
  .orb-aura,
  .wave-bar-fill {
    animation: none;
  }
}
</style>
