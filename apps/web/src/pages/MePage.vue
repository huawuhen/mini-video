<script setup lang="ts">
import { useRouter } from 'vue-router';
import { showConfirmDialog } from 'vant';
import { useAuthStore } from '@/stores/auth';

const router = useRouter();
const auth = useAuthStore();
async function logout() {
  try { await showConfirmDialog({ title: '退出登录？' }); } catch { return; }
  await auth.logout();
  router.replace('/');
}
</script>

<template>
  <div class="miv-page me">
    <section class="profile miv-card">
      <van-image round width="56" height="56" :src="auth.user?.avatarUrl" class="avatar">
        <template #error><van-icon name="user-o" size="28" /></template>
      </van-image>
      <div v-if="auth.user">
        <strong>{{ auth.user.nickname }}</strong>
        <p class="miv-hint">{{ auth.user.phoneMasked }}</p>
      </div>
      <van-button v-else type="primary" size="small" round to="/login">登录 / 注册</van-button>
    </section>
    <van-cell-group inset class="group">
      <van-cell title="我的数字资产库" icon="friends-o" is-link to="/assets" />
      <van-cell title="我的作品" icon="video-o" is-link to="/projects" />
      <van-cell title="钱包" icon="balance-o" is-link to="/wallet" />
    </van-cell-group>
    <van-cell-group inset class="group">
      <van-cell title="重新查看新手引导" icon="guide-o" is-link :to="{ path: '/', query: { tour: '1' } }" />
    </van-cell-group>
    <van-cell-group inset class="group">
      <van-cell title="用户协议" icon="description-o" is-link />
      <van-cell title="隐私政策" icon="shield-o" is-link />
      <van-cell title="联系客服" icon="service-o" is-link />
    </van-cell-group>
    <van-button v-if="auth.user" block plain class="logout" @click="logout">退出登录</van-button>
  </div>
</template>

<style scoped>
.me { max-width: 760px; }
.profile { display: flex; align-items: center; gap: var(--miv-space-3); }
.avatar { background: var(--miv-primary-soft); display: flex; align-items: center; justify-content: center; color: var(--miv-primary); }
.group { margin: var(--miv-space-3) 0 0; }
.logout { margin-top: var(--miv-space-5); }
</style>
