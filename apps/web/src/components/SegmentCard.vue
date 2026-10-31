<script setup lang="ts">
import { computed } from 'vue';
import type { Ratio, Segment } from '@/api';
import { genStatusLabel } from '@/utils/status';
import MediaPlaceholder from './MediaPlaceholder.vue';

// 片段卡（PRD 3.2）：查看各版本、切换选中、改剧情、重新生成。
const props = defineProps<{ segment: Segment; ratio: Ratio; editable: boolean }>();
const emit = defineEmits<{ select: [takeId: string]; edit: []; regenerate: [] }>();
const selected = computed(() => props.segment.takes.find((t) => t.id === props.segment.selectedTakeId));
const running = computed(() => props.segment.takes.some((t) => t.status === 'running' || t.status === 'pending'));
// M2-OPS-03 复审必改 3：succeeded 无海报图（poster 抽帧失败/老数据）时显示「已完成」，
// 不得再落到「生成中…」误导用户。
const mediaText = computed(() => {
  if (selected.value?.status === 'succeeded') return '已完成';
  return running.value ? '生成中…' : '排队中';
});
</script>

<template>
  <div class="seg miv-card">
    <div class="media">
      <MediaPlaceholder :src="selected?.posterUrl" :ratio="ratio" :loading="!selected && running" :text="mediaText" />
    </div>
    <div class="body">
      <div class="head">
        <strong>片段 {{ segment.index + 1 }}</strong>
        <span class="miv-hint">{{ segment.durationSeconds }} 秒<template v-if="segment.transition === 'prev_tail'"> · 接上一段</template></span>
      </div>
      <p class="plot">{{ segment.plot }}</p>
      <div v-if="segment.takes.length > 1" class="takes">
        <button
          v-for="(t, i) in segment.takes"
          :key="t.id"
          type="button"
          :class="{ on: t.id === segment.selectedTakeId }"
          :disabled="!editable || t.status !== 'succeeded'"
          @click="emit('select', t.id)"
        >
          第 {{ i + 1 }} 版<template v-if="t.status !== 'succeeded'"> · {{ genStatusLabel[t.status] }}</template>
        </button>
      </div>
      <div v-if="editable" class="actions">
        <van-button size="small" plain :disabled="running" @click="emit('edit')">改剧情</van-button>
        <van-button size="small" plain type="primary" :loading="running" loading-text="生成中" @click="emit('regenerate')">重新生成</van-button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.seg { display: flex; gap: var(--miv-space-3); padding: var(--miv-space-3); }
.media { flex: none; width: 96px; }
.body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: var(--miv-space-2); }
.head { display: flex; align-items: baseline; gap: var(--miv-space-2); }
.plot { font-size: 13px; line-height: 1.6; color: var(--miv-text-2); display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.takes { display: flex; gap: var(--miv-space-1); flex-wrap: wrap; }
.takes button { border: 1px solid var(--miv-border); background: var(--miv-surface); border-radius: 999px; padding: 2px 10px; font: inherit; font-size: 12px; color: var(--miv-text-2); cursor: pointer; }
.takes button.on { border-color: var(--miv-primary); background: var(--miv-primary-soft); color: var(--miv-primary-strong); }
.takes button:disabled { cursor: default; }
.actions { display: flex; gap: var(--miv-space-2); }
</style>
