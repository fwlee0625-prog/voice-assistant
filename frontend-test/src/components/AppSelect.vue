<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref } from 'vue'

export interface SelectOption {
  value: string
  label: string
}

const props = defineProps<{
  modelValue: string
  options: SelectOption[]
  placeholder?: string
  disabled?: boolean
  id?: string
}>()

const emit = defineEmits<{ 'update:modelValue': [value: string] }>()

const root = ref<HTMLElement | null>(null)
const trigger = ref<HTMLButtonElement | null>(null)
const list = ref<HTMLElement | null>(null)
const open = ref(false)
const activeIndex = ref(-1)
const listStyle = ref<Record<string, string>>({})
const listId = computed(() => `${props.id ?? 'app-select'}-list`)

const selectedLabel = computed(() => props.options.find((o) => o.value === props.modelValue)?.label ?? props.placeholder ?? '')

function positionList() {
  const triggerEl = trigger.value
  if (!triggerEl) return
  const rect = triggerEl.getBoundingClientRect()
  const container = triggerEl.closest('dialog')?.getBoundingClientRect()
  const bottomEdge = container ? container.bottom : window.innerHeight
  const topEdge = container ? container.top : 0
  const spaceBelow = bottomEdge - rect.bottom - 6
  const spaceAbove = rect.top - topEdge - 6
  const flip = spaceBelow < 120 && spaceAbove > spaceBelow
  const maxHeight = Math.max(80, Math.min(240, flip ? spaceAbove : spaceBelow))
  listStyle.value = {
    left: `${Math.round(rect.left)}px`,
    width: `${Math.round(rect.width)}px`,
    maxHeight: `${Math.round(maxHeight)}px`,
    ...(flip
      ? { bottom: `${Math.round(window.innerHeight - rect.top + 6)}px` }
      : { top: `${Math.round(rect.bottom + 6)}px` }),
  }
}

function openList() {
  if (props.disabled || open.value) return
  open.value = true
  activeIndex.value = Math.max(
    props.options.findIndex((o) => o.value === props.modelValue),
    0,
  )
  document.addEventListener('pointerdown', onOutsidePointer, true)
  document.addEventListener('keydown', onDocumentKey, true)
  window.addEventListener('resize', positionList)
  window.addEventListener('scroll', positionList, true)
  void nextTick(() => {
    positionList()
    scrollActiveIntoView()
  })
}

function closeList() {
  if (!open.value) return
  open.value = false
  activeIndex.value = -1
  document.removeEventListener('pointerdown', onOutsidePointer, true)
  document.removeEventListener('keydown', onDocumentKey, true)
  window.removeEventListener('resize', positionList)
  window.removeEventListener('scroll', positionList, true)
  trigger.value?.focus()
}

function onOutsidePointer(event: PointerEvent) {
  if (root.value && !root.value.contains(event.target as Node)) closeList()
}

function onDocumentKey(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault()
    closeList()
  }
}

function select(index: number) {
  const option = props.options[index]
  if (!option) return
  emit('update:modelValue', option.value)
  closeList()
}

function moveActive(step: number) {
  if (!props.options.length) return
  const next = (activeIndex.value + step + props.options.length) % props.options.length
  activeIndex.value = next
  void nextTick(() => scrollActiveIntoView())
}

function scrollActiveIntoView() {
  const container = list.value
  const item = container?.children[activeIndex.value] as HTMLElement | undefined
  item?.scrollIntoView({ block: 'nearest' })
}

function onTriggerKeydown(event: KeyboardEvent) {
  if (props.disabled) return
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    if (!open.value) openList()
    else moveActive(event.key === 'ArrowDown' ? 1 : -1)
    return
  }
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    if (open.value) select(activeIndex.value)
    else openList()
    return
  }
  if (event.key === 'Tab') closeList()
}

function onListKeydown(event: KeyboardEvent) {
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    moveActive(1)
  } else if (event.key === 'ArrowUp') {
    event.preventDefault()
    moveActive(-1)
  } else if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    select(activeIndex.value)
  } else if (event.key === 'Home') {
    event.preventDefault()
    activeIndex.value = 0
    void nextTick(() => scrollActiveIntoView())
  } else if (event.key === 'End') {
    event.preventDefault()
    activeIndex.value = props.options.length - 1
    void nextTick(() => scrollActiveIntoView())
  }
}

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onOutsidePointer, true)
  document.removeEventListener('keydown', onDocumentKey, true)
  window.removeEventListener('resize', positionList)
  window.removeEventListener('scroll', positionList, true)
})
</script>

<template>
  <div ref="root" class="ui-select" :class="{ 'is-open': open }">
    <button
      ref="trigger"
      type="button"
      class="ui-select-trigger"
      :id="id"
      :disabled="disabled"
      role="combobox"
      aria-haspopup="listbox"
      :aria-expanded="open"
      :aria-controls="listId"
      :aria-activedescendant="open ? `${listId}-${activeIndex}` : undefined"
      @click.stop="open ? closeList() : openList()"
      @keydown="onTriggerKeydown"
    >
      <span class="ui-select-value" :class="{ 'is-placeholder': !selectedLabel }">{{ selectedLabel }}</span>
      <svg class="ui-select-arrow" viewBox="0 0 10 6" aria-hidden="true">
        <path d="M1.5 1.5 5 4.5 8.5 1.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </button>

    <div
      v-if="open"
      :id="listId"
      ref="list"
      class="ui-select-list"
      role="listbox"
      :style="listStyle"
      @keydown="onListKeydown"
    >
      <div
        v-for="(option, index) in options"
        :key="option.value"
        :id="`${listId}-${index}`"
        class="ui-select-option"
        :class="{ 'is-active': index === activeIndex, 'is-selected': option.value === modelValue }"
        role="option"
        :aria-selected="option.value === modelValue"
        @click.stop="select(index)"
        @mousemove="activeIndex = index"
      >
        {{ option.label }}
      </div>
    </div>
  </div>
</template>
