<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import { useBreakpoint } from '@/composables/useBreakpoint';
import { useAuthStore } from '@/stores/auth';

const route = useRoute();
const auth = useAuthStore();
const { isDesktop } = useBreakpoint();
// PC 侧栏 5 项；手机 Tabbar 4 项（docs/UI.md §3）
const nav = [
  { to: '/', label: '首页', short: '首页', icon: 'home-o', tab: true },
  { to: '/assets', label: '我的数字资产库', short: '资产库', icon: 'friends-o', tab: true },
  { to: '/projects', label: '我的作品', short: '作品', icon: 'video-o', tab: true },
  { to: '/wallet', label: '钱包', short: '钱包', icon: 'balance-o', tab: false },
  { to: '/me', label: '我的', short: '我的', icon: 'user-o', tab: true },
];
const tabs = nav.filter((n) => n.tab);
const active = computed(() => {
  const hit = [...nav].reverse().find((n) => (n.to === '/' ? route.path === '/' : route.path.startsWith(n.to)));
  return hit?.to || '/';
});
const hideTabbar = computed(() => route.meta.hideTabbar === true);
</script>

<template>
  <div :class="['layout', isDesktop ? 'desktop' : 'mobile', { 'no-tabbar': hideTabbar }]">
    <aside v-if="isDesktop" class="sidebar">
      <router-link to="/" class="brand"><span class="logo">▶</span>Mini AI Video</router-link>
      <router-link v-for="item in nav" :key="item.to" :to="item.to" :class="['nav-item', { on: active === item.to }]">
        <van-icon :name="item.icon" size="18" />{{ item.label }}
      </router-link>
      <div class="sidebar-foot miv-hint">{{ auth.user ? auth.user.nickname : '未登录' }}</div>
    </aside>
    <main class="content">
      <router-view />
    </main>
    <van-tabbar v-if="!isDesktop && !hideTabbar" :model-value="active" route safe-area-inset-bottom>
      <van-tabbar-item v-for="tab in tabs" :key="tab.to" :name="tab.to" :to="tab.to" :icon="tab.icon">{{ tab.short }}</van-tabbar-item>
    </van-tabbar>
  </div>
</template>

<style scoped>
.layout.mobile .content { padding-bottom: calc(var(--miv-tabbar-height) + env(safe-area-inset-bottom)); }
.layout.mobile.no-tabbar .content { padding-bottom: 0; }
.layout.desktop { display: flex; min-height: 100vh; }
.layout.desktop .content { flex: 1; min-width: 0; margin-left: var(--miv-sidebar-width); }
.sidebar { position: fixed; inset: 0 auto 0 0; width: var(--miv-sidebar-width); background: var(--miv-surface); border-right: 1px solid var(--miv-border); padding: var(--miv-space-5) var(--miv-space-3); display: flex; flex-direction: column; gap: var(--miv-space-1); }
.brand { display: flex; align-items: center; gap: var(--miv-space-2); font-weight: 700; font-size: 17px; color: var(--miv-text); padding: 0 var(--miv-space-3) var(--miv-space-5); }
.logo { width: 28px; height: 28px; border-radius: 8px; background: var(--miv-primary); color: var(--miv-on-primary); display: inline-flex; align-items: center; justify-content: center; font-size: 12px; }
.nav-item { display: flex; align-items: center; gap: var(--miv-space-3); padding: 10px var(--miv-space-3); border-radius: var(--miv-radius-md); color: var(--miv-text-2); font-size: 15px; }
.nav-item:hover { background: var(--miv-bg); }
.nav-item.on { background: var(--miv-primary-soft); color: var(--miv-primary-strong); font-weight: 600; }
.sidebar-foot { margin-top: auto; padding: var(--miv-space-3); }
</style>
