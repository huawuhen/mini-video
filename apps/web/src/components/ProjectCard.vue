<script setup lang="ts">
import type { ProjectSummary } from '@/api';
import MediaPlaceholder from './MediaPlaceholder.vue';
import StatusTag from './StatusTag.vue';

defineProps<{ project: ProjectSummary }>();
const date = (iso: string) => new Date(iso).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
</script>

<template>
  <router-link :to="`/projects/${project.id}`" class="card miv-card">
    <MediaPlaceholder :src="project.coverUrl" ratio="16:9" :text="project.status === 'delivered' ? '' : '制作中'" />
    <div class="meta">
      <h3>{{ project.title }}</h3>
      <div class="row">
        <StatusTag :status="project.status" />
        <span class="miv-hint">{{ date(project.updatedAt) }}</span>
      </div>
    </div>
  </router-link>
</template>

<style scoped>
.card { display: block; padding: var(--miv-space-3); color: inherit; }
.meta { margin-top: var(--miv-space-3); }
h3 { font-size: 15px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.row { display: flex; align-items: center; justify-content: space-between; margin-top: var(--miv-space-2); }
</style>
