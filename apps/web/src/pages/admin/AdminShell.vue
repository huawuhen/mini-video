<script setup lang="ts">
// 运营后台共用外壳（M3-ADM-02 抽出）：顶栏品牌 + 页面导航 + 退出；
// 各页专有的动作按钮走 actions 具名插槽。PC 优先，移动端确认可打开、不横向溢出。
import { useRoute, useRouter } from 'vue-router';
import { adminApi } from '@/api';

const route = useRoute();
const router = useRouter();

const NAV = [
  { path: '/admin/users', label: '用户与订单' },
  { path: '/admin/channels', label: '渠道管理' },
];

const routeIs = (path: string) => route.path.startsWith(path);

async function logout() {
  await adminApi.logout().catch(() => undefined);
  router.replace('/admin/login');
}
</script>

<template>
  <div class="admin-page">
    <header class="topbar">
      <div class="brand"><span class="logo">▶</span>剧优兔AI · 运营后台</div>
      <nav>
        <RouterLink v-for="item in NAV" :key="item.path" :to="item.path"
          class="nav" :class="{ current: routeIs(item.path) }">{{ item.label }}</RouterLink>
        <slot name="nav-extra" />
      </nav>
      <div class="actions">
        <slot name="actions" />
        <button type="button" class="ghost" @click="logout">退出</button>
      </div>
    </header>
    <main><slot /></main>
  </div>
</template>

<style scoped>
.admin-page { min-height: 100vh; background: var(--miv-bg); }
.topbar { position: sticky; top: 0; z-index: 10; display: flex; align-items: center; gap: var(--miv-space-4);
  padding: 0 var(--miv-space-4); height: 56px; background: var(--miv-surface); border-bottom: 1px solid var(--miv-border); }
.brand { font-weight: 700; display: flex; align-items: center; gap: 8px; white-space: nowrap; }
.logo { color: var(--miv-primary); }
nav { display: flex; align-items: center; gap: var(--miv-space-3); flex: 1; min-width: 0; }
.nav { color: var(--miv-text-2); font-size: 14px; text-decoration: none; white-space: nowrap; }
.nav.current { color: var(--miv-text); font-weight: 600; }
.actions { display: flex; gap: var(--miv-space-2); }
button.ghost { background: var(--miv-bg); color: var(--miv-text-2); border: 1px solid var(--miv-border);
  border-radius: var(--miv-radius-sm); padding: 8px 16px; font: inherit; cursor: pointer; white-space: nowrap; }
main { max-width: 1200px; margin: 0 auto; padding: var(--miv-space-4); display: flex; flex-direction: column; gap: var(--miv-space-3); }
@media (max-width: 767px) {
  .topbar { padding: 0 var(--miv-space-3); }
  main { padding: var(--miv-space-3); }
}
</style>
