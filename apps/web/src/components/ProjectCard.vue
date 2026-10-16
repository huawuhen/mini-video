<script setup lang="ts">
import { computed } from 'vue';
import type { ProjectSummary } from '@/api';
import { daysLeft, formatDateTime } from '@/utils/time';
import MediaPlaceholder from './MediaPlaceholder.vue';
import StatusTag from './StatusTag.vue';

const props = defineProps<{ project: ProjectSummary; remindDays?: number }>();
const left = computed(() => (props.project.status === 'delivered' && props.project.expiresAt ? daysLeft(props.project.expiresAt) : null));
const expiring = computed(() => left.value !== null && left.value <= (props.remindDays ?? 7));
</script>

<template>
  <router-link :to="`/projects/${project.id}`" :class="['card', 'miv-card', { expired: project.status === 'expired' }]">
    <MediaPlaceholder :src="project.coverUrl" ratio="16:9" :text="project.status === 'expired' ? '视频已清理' : project.progress.message || '制作中'">
      <span v-if="expiring" class="expiry">{{ left }} 天后过期</span>
    </MediaPlaceholder>
    <div class="meta">
      <h3>{{ project.title || '未命名作品' }}</h3>
      <div class="row">
        <StatusTag :status="project.status" />
        <span class="miv-hint">{{ formatDateTime(project.updatedAt) }}</span>
      </div>
    </div>
  </router-link>
</template>

<style scoped>
.card { display: block; padding: var(--miv-space-3); color: inherit; }
.card.expired { opacity: 0.6; }
.meta { margin-top: var(--miv-space-3); }
h3 { font-size: 15px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.row { display: flex; align-items: center; justify-content: space-between; margin-top: var(--miv-space-2); }
.expiry { position: absolute; top: 8px; left: 8px; font-size: 12px; padding: 2px 8px; border-radius: 999px; background: var(--miv-warning); color: var(--miv-on-primary); }
</style>
