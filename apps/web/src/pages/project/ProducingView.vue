<script setup lang="ts">
import { computed } from 'vue';
import type { ProjectDetail } from '@/api';
import MediaPlaceholder from '@/components/MediaPlaceholder.vue';

// 制作中（PRD 5.4）：具体进度文案 + 排队预期；已完成的片段先展示；后台保活提示。
// 真实渠道生成需要排队（M0 实测 4 秒小样曾排队约 44 分钟），文案按「分钟级常见、高峰小时级」设计，
// 不承诺具体时间，避免用户以为卡住。
const props = defineProps<{ project: ProjectDetail }>();
const composing = computed(() => props.project.status === 'composing');
const segments = computed(() => props.project.segments.map((s) => ({ ...s, take: s.takes.find((t) => t.id === s.selectedTakeId) ?? s.takes[s.takes.length - 1] })));
const doneCount = computed(() => segments.value.filter((s) => s.take?.status === 'succeeded').length);
</script>

<template>
  <section class="miv-card">
    <van-progress :percentage="project.progress.percent" :show-pivot="false" stroke-width="8" />
    <p class="message"><van-loading size="14" />{{ project.progress.message }}</p>
    <template v-if="!composing">
      <p class="miv-hint">视频正在云端的制作队列里排队生成，通常几分钟完成，高峰期可能要等一阵子。</p>
      <p v-if="doneCount" class="miv-hint">已完成 {{ doneCount }} 段，可以先在下方预览，不用干等。</p>
    </template>
    <p v-else class="miv-hint">所有片段已生成，正在拼接成片并合成声音，很快就好。</p>
    <p class="miv-hint keep">您可以锁屏或关掉页面，做好了会自动存进「我的作品」，不会打断您。</p>
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
.keep { margin-top: var(--miv-space-2); }
.segments { display: grid; grid-template-columns: repeat(auto-fill, minmax(110px, 1fr)); gap: var(--miv-space-3); }
.seg { display: flex; flex-direction: column; gap: var(--miv-space-1); }
</style>
