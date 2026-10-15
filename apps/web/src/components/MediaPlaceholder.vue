<script setup lang="ts">
import { computed } from 'vue';
const props = defineProps<{ src?: string; ratio?: string; loading?: boolean; text?: string }>();
const aspect = computed(() => (props.ratio || '1:1').replace(':', ' / '));
</script>

<template>
  <div class="media" :style="{ aspectRatio: aspect }">
    <img v-if="src && !loading" :src="src" alt="" loading="lazy" />
    <div v-else class="placeholder">
      <van-loading v-if="loading" size="22" vertical>{{ text || '生成中…' }}</van-loading>
      <span v-else class="miv-hint">{{ text || '暂无内容' }}</span>
    </div>
    <slot />
  </div>
</template>

<style scoped>
.media { position: relative; width: 100%; border-radius: var(--miv-radius-md); overflow: hidden; background: var(--miv-primary-soft); }
.media img { width: 100%; height: 100%; object-fit: cover; }
.placeholder { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; }
</style>
