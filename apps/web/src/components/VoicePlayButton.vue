<script setup lang="ts">
import { computed } from 'vue';
import { useAudio } from '@/composables/useAudio';

const props = defineProps<{ url?: string }>();
const { playing, toggle } = useAudio();
const on = computed(() => !!props.url && playing.value === props.url);
</script>

<template>
  <button type="button" class="play" :disabled="!url" :aria-label="on ? '停止试听' : '试听'" @click.stop="url && toggle(url)">
    <van-icon :name="on ? 'pause-circle' : 'play-circle-o'" size="22" />
    <span>{{ !url ? '暂无试听' : on ? '停止' : '试听' }}</span>
  </button>
</template>

<style scoped>
.play { display: inline-flex; align-items: center; gap: 2px; border: 0; background: none; color: var(--miv-primary-strong); font: inherit; font-size: 12px; cursor: pointer; padding: 2px; }
.play:disabled { color: var(--miv-text-3); cursor: default; }
</style>
