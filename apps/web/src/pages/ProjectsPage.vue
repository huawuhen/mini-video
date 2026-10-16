<script setup lang="ts">
// 我的作品（PRD 5.6）：分组 + 到期倒计时；到期前 N 天进入页面时提醒一次（引导进行中不弹）。
import { computed, onMounted, ref } from 'vue';
import { showDialog } from 'vant';
import { api, type ProjectGroup, type ProjectSummary } from '@/api';
import EmptyState from '@/components/EmptyState.vue';
import ProjectCard from '@/components/ProjectCard.vue';
import { useOnboarding } from '@/composables/useOnboarding';
import { useCatalogStore } from '@/stores/catalog';
import { projectGroups } from '@/utils/status';
import { daysLeft } from '@/utils/time';

const REMIND_KEY = 'miv-expiry-reminded';
const catalogStore = useCatalogStore();
const onboarding = useOnboarding();
const group = ref<ProjectGroup | 'all'>('all');
const items = ref<ProjectSummary[] | null>(null);
const remindDays = computed(() => catalogStore.catalog?.limits.expiryRemindDays ?? 7);
const list = computed(() => (items.value || []).filter((p) => group.value === 'all' || p.group === group.value));
const countOf = (g: ProjectGroup) => (items.value || []).filter((p) => p.group === g).length;

onMounted(async () => {
  await catalogStore.load();
  items.value = (await api.listProjects()).items;
  remindExpiring();
});

function remindExpiring() {
  const expiring = (items.value || []).filter((p) => p.status === 'delivered' && p.expiresAt && daysLeft(p.expiresAt) <= remindDays.value);
  if (!expiring.length || onboarding.tourActive()) return;
  const key = expiring.map((p) => p.id).sort().join();
  try { if (sessionStorage.getItem(REMIND_KEY) === key) return; sessionStorage.setItem(REMIND_KEY, key); } catch { /* 存储不可用时每次都提醒 */ }
  showDialog({
    title: '作品即将过期',
    message: `${expiring.map((p) => `《${p.title}》还有 ${daysLeft(p.expiresAt!)} 天`).join('\n')}\n\n过期后视频会被清理，请尽快保存到手机。`,
    confirmButtonText: '知道了',
    messageAlign: 'left',
  });
}
</script>

<template>
  <div class="miv-page">
    <h1 class="page-title">我的作品</h1>
    <van-tabs v-model:active="group" shrink background="transparent" class="tabs">
      <van-tab title="全部" name="all" />
      <van-tab v-for="g in projectGroups" :key="g.key" :name="g.key" :title="countOf(g.key) ? `${g.label} ${countOf(g.key)}` : g.label" />
    </van-tabs>
    <van-skeleton v-if="!items" :row="4" />
    <EmptyState v-else-if="!list.length" title="这里还没有作品" description="写一段故事，一键生成你的第一部短片">
      <van-button type="primary" round size="small" to="/">去创作</van-button>
    </EmptyState>
    <div v-else class="miv-grid"><ProjectCard v-for="p in list" :key="p.id" :project="p" :remind-days="remindDays" /></div>
  </div>
</template>

<style scoped>
.page-title { font-size: 20px; margin-bottom: var(--miv-space-2); }
.tabs { margin-bottom: var(--miv-space-3); }
</style>
