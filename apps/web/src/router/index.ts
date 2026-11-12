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
        { path: 'wallet/recharge', component: () => import('@/pages/RechargePage.vue'), meta: { auth: true, title: '在线充值', hideTabbar: true } },
        { path: 'wallet/recharge/:orderId', component: () => import('@/pages/RechargeResultPage.vue'), meta: { auth: true, title: '支付结果', hideTabbar: true } },
        { path: 'me', component: () => import('@/pages/MePage.vue'), meta: { title: '我的' } },
      ],
    },
    { path: '/login', component: () => import('@/pages/LoginPage.vue'), meta: { title: '登录' } },
    // 协议正文（M3-LEGAL-01）：无需登录；正文构建时来自 docs/legal/*.md
    { path: '/legal/terms', component: () => import('@/pages/LegalPage.vue'), meta: { title: '用户协议', hideTabbar: true } },
    { path: '/legal/privacy', component: () => import('@/pages/LegalPage.vue'), meta: { title: '隐私政策', hideTabbar: true } },
    // 运营后台（M3-ADM-01）：独立于用户端布局与登录态（API.md §8）
    { path: '/admin/login', component: () => import('@/pages/admin/AdminLoginPage.vue'), meta: { title: '运营后台登录' } },
    { path: '/admin/users', component: () => import('@/pages/admin/AdminUsersPage.vue'), meta: { title: '用户与订单' } },
    { path: '/admin/orders', component: () => import('@/pages/admin/AdminOrdersPage.vue'), meta: { title: '充值订单' } },
    { path: '/admin/projects', component: () => import('@/pages/admin/AdminProjectsPage.vue'), meta: { title: '作品处理' } },
    { path: '/admin/channels', component: () => import('@/pages/admin/ChannelsPage.vue'), meta: { title: '渠道管理' } },
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
  document.title = `${to.meta.title ? `${to.meta.title} · ` : ''}剧优兔AI`;
});
