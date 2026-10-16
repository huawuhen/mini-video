import { createRouter, createWebHistory } from 'vue-router';
import { stopAudio } from '@/composables/useAudio';
import AppLayout from '@/layouts/AppLayout.vue';
import { useAuthStore } from '@/stores/auth';

declare module 'vue-router' {
  interface RouteMeta { auth?: boolean; hideTabbar?: boolean; title?: string }
}

// 页面地图见 docs/UI.md §4
export const router = createRouter({
  history: createWebHistory(),
  scrollBehavior: () => ({ top: 0 }),
  routes: [
    {
      path: '/',
      component: AppLayout,
      children: [
        { path: '', component: () => import('@/pages/HomePage.vue'), meta: { title: '首页' } },
        { path: 'assets', component: () => import('@/pages/AssetsPage.vue'), meta: { auth: true, title: '我的数字资产库' } },
        { path: 'assets/new', component: () => import('@/pages/AssetNewPage.vue'), meta: { auth: true, title: '新建数字人', hideTabbar: true } },
        { path: 'assets/:id', component: () => import('@/pages/AssetDetailPage.vue'), meta: { auth: true, title: '数字人', hideTabbar: true } },
        { path: 'projects', component: () => import('@/pages/ProjectsPage.vue'), meta: { auth: true, title: '我的作品' } },
        { path: 'projects/:id', component: () => import('@/pages/ProjectDetailPage.vue'), meta: { auth: true, title: '作品详情', hideTabbar: true } },
        { path: 'wallet', component: () => import('@/pages/WalletPage.vue'), meta: { auth: true, title: '钱包' } },
        { path: 'me', component: () => import('@/pages/MePage.vue'), meta: { title: '我的' } },
      ],
    },
    { path: '/login', component: () => import('@/pages/LoginPage.vue'), meta: { title: '登录' } },
    { path: '/:pathMatch(.*)*', component: () => import('@/pages/NotFoundPage.vue'), meta: { title: '页面不存在' } },
  ],
});

// 登录拦截：跳登录页并带回跳地址；回跳后不自动触发任何收费或创建操作（docs/UI.md §8）。
router.beforeEach(async (to) => {
  const auth = useAuthStore();
  if (!auth.checked) await auth.check();
  if (to.meta.auth && !auth.loggedIn) return { path: '/login', query: { redirect: to.fullPath } };
  return true;
});
router.afterEach((to) => {
  stopAudio();
  document.title = `${to.meta.title ? `${to.meta.title} · ` : ''}Mini AI Video`;
});
