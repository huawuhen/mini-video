<script setup lang="ts">
import type { QualityTier } from '@/api';
import { formatFen } from '@/utils/money';

defineProps<{ tiers: QualityTier[]; modelValue: string }>();
const emit = defineEmits<{ 'update:modelValue': [string] }>();
</script>

<template>
  <div class="tiers" role="radiogroup" aria-label="画质">
    <button
      v-for="t in tiers"
      :key="t.id"
      type="button"
      role="radio"
      :aria-checked="modelValue === t.id"
      :class="['tier', { on: modelValue === t.id }]"
      @click="emit('update:modelValue', t.id)"
    >
      <strong>{{ t.name }}</strong>
      <span class="note">{{ t.note }}</span>
      <span class="price">约 ¥{{ formatFen(t.pricePer30sFen) }}/30 秒</span>
    </button>
  </div>
</template>

<style scoped>
.tiers { display: grid; grid-template-columns: repeat(auto-fit, minmax(0, 1fr)); gap: var(--miv-space-2); }
.tier { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; padding: var(--miv-space-3); border-radius: var(--miv-radius-md); border: 1px solid var(--miv-border); background: var(--miv-surface); cursor: pointer; font: inherit; color: var(--miv-text); text-align: left; }
.tier.on { border-color: var(--miv-primary); background: var(--miv-primary-soft); }
.note { font-size: 12px; color: var(--miv-text-2); }
.price { font-size: 12px; color: var(--miv-accent); font-weight: 600; }
</style>
