<script setup lang="ts">
import { computed } from 'vue';
import type { ProjectDetail } from '@/api';
import MediaPlaceholder from '@/components/MediaPlaceholder.vue';

// 制作中（PRD 5.4）：具体进度文案；已完成的片段先展示；后台保活提示。
const props = defineProps<{ project: ProjectDetail }>();
const segments = computed(() => props.project.segments.map((s) => ({ ...s, take: s.takes.find((t) => t.id === s.selectedTakeId) ?? s.takes[s.takes.length - 1] })));
</script>

<template>
  <section class="miv-card">
    <van-progress :percentage="project.progress.percent" :show-pivot="false" stroke-width="8" />
    <p class="message"><van-loading size="14" />{{ project.progress.message }}</p>
    <p class="miv-hint">您可以锁屏或稍后再来，完成后会自动保存在「我的作品」。</p>
  </section>
  <section class="segments">
    <div v-for="s in segments" :key="s.id" class="seg">
      <MediaPlaceholder :src="s.take?.status === 'succeeded' ? s.take.posterUrl : undefined" :ratio="project.ratio" :loading="s.take?.status === 'running'" :text="s.take?.status === 'succeeded' ? '' : s.take?.status === 'running' ? '生成中…' : '排队中'" />
      <span class="miv-hint">片段 {{ s.index + 1 }} · {{ s.durationSeconds }} 秒</span>
    </div>
  </section>
</template>

<style scoped>
.message { display: flex; align-items: center; gap: var(--miv-space-2); margin: var(--miv-space-3) 0 var(--miv-space-1); font-size: 15px; font-weight: 600; }
.segments { display: grid; grid-template-columns: repeat(auto-fill, minmax(110px, 1fr)); gap: var(--miv-space-3); }
.seg { display: flex; flex-direction: column; gap: var(--miv-space-1); }
</style>
