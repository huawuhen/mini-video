<script setup lang="ts">
import { computed } from 'vue';
import type { Shot } from '@/api';
import { genStatusLabel } from '@/utils/status';
import MediaPlaceholder from './MediaPlaceholder.vue';

const props = defineProps<{ shot: Shot; ratio: string; mode: 'review' | 'generate' | 'view' }>();
const emit = defineEmits<{ edit: []; retake: []; select: [takeId: string] }>();
const selected = computed(() => props.shot.takes.find((t) => t.id === props.shot.selectedTakeId));
const media = computed(() => selected.value?.posterUrl || props.shot.firstFrameUrl);
const busy = computed(() => props.shot.takes.some((t) => t.status === 'running' || t.status === 'pending'));
</script>

<template>
  <div class="shot miv-card">
    <div class="media-wrap">
      <MediaPlaceholder :src="media" :ratio="ratio" :loading="mode !== 'review' && busy && !selected?.posterUrl" text="视频生成中…">
        <span class="badge">第 {{ shot.index }} 镜 · {{ shot.durationSeconds }} 秒</span>
        <van-icon v-if="selected?.status === 'succeeded'" name="play-circle-o" class="play" />
      </MediaPlaceholder>
    </div>
    <div class="body">
      <p class="desc">{{ shot.description }}</p>
      <p class="miv-hint voice">台词：{{ shot.voiceover || '（无）' }}</p>
      <div v-if="mode === 'generate' && shot.takes.length" class="takes">
        <van-tag
          v-for="(take, i) in shot.takes.slice().reverse()"
          :key="take.id"
          :type="take.id === shot.selectedTakeId ? 'primary' : 'default'"
          :plain="take.id !== shot.selectedTakeId"
          round
          @click="take.status === 'succeeded' && emit('select', take.id)"
        >
          第 {{ i + 1 }} 版 · {{ genStatusLabel[take.status] }}
        </van-tag>
      </div>
      <div class="actions">
        <van-button v-if="mode === 'review'" size="small" plain type="primary" icon="edit" @click="emit('edit')">修改</van-button>
        <van-button v-if="mode === 'generate'" size="small" plain type="primary" icon="replay" :loading="busy" @click="emit('retake')">重拍这一镜</van-button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.shot { padding: var(--miv-space-3); display: grid; gap: var(--miv-space-3); grid-template-columns: 1fr; }
.media-wrap { max-width: 100%; }
.badge { position: absolute; left: 8px; top: 8px; background: rgba(31, 41, 51, 0.6); color: #fff; font-size: 12px; padding: 2px 8px; border-radius: 999px; }
.play { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); font-size: 44px; color: rgba(255, 255, 255, 0.9); }
.desc { font-size: 14px; line-height: 1.6; }
.voice { margin-top: var(--miv-space-1); }
.takes { display: flex; flex-wrap: wrap; gap: var(--miv-space-2); margin-top: var(--miv-space-2); }
.actions { margin-top: var(--miv-space-2); display: flex; gap: var(--miv-space-2); }
@media (min-width: 768px) {
  .shot { grid-template-columns: minmax(160px, 240px) 1fr; align-items: start; }
}
</style>
