<script setup lang="ts">
import { computed } from 'vue';
import { STAGES, type StageKey } from '@/utils/status';

const props = defineProps<{ current: StageKey; viewing?: StageKey; vertical?: boolean }>();
const emit = defineEmits<{ select: [key: StageKey] }>();
const currentIndex = computed(() => STAGES.findIndex((s) => s.key === props.current));
</script>

<template>
  <nav :class="['stepper', vertical ? 'vertical' : 'horizontal']" aria-label="制作步骤">
    <button
      v-for="(stage, i) in STAGES"
      :key="stage.key"
      type="button"
      :class="['step', { done: i < currentIndex, active: i === currentIndex, viewing: stage.key === viewing }]"
      :disabled="i > currentIndex"
      @click="emit('select', stage.key)"
    >
      <span class="dot">{{ i < currentIndex ? '✓' : i + 1 }}</span>
      <span class="label">{{ stage.label }}</span>
    </button>
  </nav>
</template>

<style scoped>
.stepper { display: flex; gap: var(--miv-space-2); }
.horizontal { overflow-x: auto; padding: var(--miv-space-2) 0; scrollbar-width: none; }
.horizontal::-webkit-scrollbar { display: none; }
.vertical { flex-direction: column; }
.step { display: flex; align-items: center; gap: var(--miv-space-2); flex-shrink: 0; border: 0; background: transparent; padding: var(--miv-space-2) var(--miv-space-3); border-radius: 999px; color: var(--miv-text-3); font-size: 14px; cursor: pointer; }
.vertical .step { border-radius: var(--miv-radius-md); padding: var(--miv-space-3); }
.step:disabled { cursor: default; }
.dot { width: 22px; height: 22px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; font-size: 12px; background: var(--miv-border); color: var(--miv-text-2); }
.step.done { color: var(--miv-text-2); }
.step.done .dot { background: var(--miv-primary-soft); color: var(--miv-primary-strong); }
.step.active { color: var(--miv-primary-strong); font-weight: 600; }
.step.active .dot { background: var(--miv-primary); color: #fff; }
.step.viewing { background: var(--miv-primary-soft); }
</style>
