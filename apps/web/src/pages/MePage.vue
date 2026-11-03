<script setup lang="ts">
import { useRouter } from 'vue-router';
import { showConfirmDialog, showToast } from 'vant';
import { useAuthStore } from '@/stores/auth';

const router = useRouter();
const auth = useAuthStore();
async function logout() {
  try { await showConfirmDialog({ title: '退出登录？' }); } catch { return; }
  await auth.logout();
  router.replace('/');
}
/** 联系客服（M3-LEGAL-01）：点按复制邮箱（可粘贴到邮件 App），长按/桌面右键也可直接打开邮件客户端。 */
const SUPPORT_EMAIL = 'help@redith.cn';
async function contactSupport() {
  try {
    await navigator.clipboard.writeText(SUPPORT_EMAIL);
    showConfirmDialog({ title: '联系客服', message: `邮箱已复制：${SUPPORT_EMAIL}\n\n也可以现在打开邮件应用写给我们。`,
      confirmButtonText: '写邮件', cancelButtonText: '关闭' })
      .then(() => { window.location.href = `mailto:${SUPPORT_EMAIL}`; })
      .catch(() => undefined);
  } catch {
    showToast(`客服邮箱：${SUPPORT_EMAIL}`);
  }
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
      <van-cell title="用户协议" icon="description-o" is-link to="/legal/terms" />
      <van-cell title="隐私政策" icon="shield-o" is-link to="/legal/privacy" />
      <van-cell title="联系客服" icon="service-o" is-link label="help@redith.cn" @click="contactSupport" />
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
