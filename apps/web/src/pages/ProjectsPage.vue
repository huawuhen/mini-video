<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api, type ProjectSummary } from '@/api';
import EmptyState from '@/components/EmptyState.vue';
import ProjectCard from '@/components/ProjectCard.vue';

const items = ref<ProjectSummary[]>([]);
const loading = ref(true);
async function load() {
  loading.value = true;
  try { items.value = (await api.listProjects()).items; } finally { loading.value = false; }
}
onMounted(load);
</script>

<template>
  <div class="miv-page">
    <div class="miv-section-title head">
      <h2>我的作品</h2>
      <van-button size="small" type="primary" icon="plus" to="/create">新建</van-button>
    </div>
    <van-pull-refresh :model-value="false" @refresh="load">
      <van-skeleton v-if="loading && !items.length" :row="4" />
      <EmptyState v-else-if="!items.length" title="还没有作品" description="写一个小故事，几分钟后就能看到成片">
        <van-button type="primary" round to="/create">去创作</van-button>
      </EmptyState>
      <div v-else class="miv-grid"><ProjectCard v-for="p in items" :key="p.id" :project="p" /></div>
    </van-pull-refresh>
  </div>
</template>

<style scoped>
.head h2 { font-size: 20px; }
</style>
