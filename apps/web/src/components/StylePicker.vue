<script setup lang="ts">
import type { Style } from '@/api';

defineProps<{ styles: Style[]; modelValue: string }>();
const emit = defineEmits<{ 'update:modelValue': [string] }>();
</script>

<template>
  <div class="styles" role="radiogroup" aria-label="画面风格">
    <button
      v-for="s in styles"
      :key="s.id"
      type="button"
      role="radio"
      :aria-checked="modelValue === s.id"
      :class="['style', { on: modelValue === s.id }]"
      @click="emit('update:modelValue', s.id)"
    >
      <img v-if="s.coverUrl" :src="s.coverUrl" alt="" loading="lazy" />
      <span v-else class="cover" />
      <span class="name">{{ s.name }}</span>
    </button>
  </div>
</template>

<style scoped>
.styles { display: flex; gap: var(--miv-space-2); overflow-x: auto; padding-bottom: var(--miv-space-1); scrollbar-width: none; }
.styles::-webkit-scrollbar { display: none; }
.style { flex: none; width: 84px; position: relative; border-radius: var(--miv-radius-md); overflow: hidden; border: 2px solid transparent; padding: 0; background: none; cursor: pointer; font: inherit; }
.style img, .cover { display: block; width: 100%; aspect-ratio: 3 / 4; object-fit: cover; background: var(--miv-primary-soft); }
.style.on { border-color: var(--miv-primary); }
.name { position: absolute; left: 4px; right: 4px; bottom: 4px; font-size: 12px; padding: 2px 4px; border-radius: 999px; background: var(--miv-chip-bg); color: var(--miv-text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.on .name { background: var(--miv-primary); color: var(--miv-on-primary); }
@media (min-width: 1024px) { .styles { flex-wrap: wrap; overflow: visible; } .style { width: 96px; } }
</style>
