<script setup lang="ts">
// 管理后台登录页（API.md §8：独立管理员账号，用户名 + 强密码，admin:create 脚本创建）。
import { ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { showFailToast } from 'vant';
import { adminApi } from '@/api';

const route = useRoute();
const router = useRouter();
const username = ref('');
const password = ref('');
const submitting = ref(false);

async function submit() {
  if (!username.value.trim() || !password.value || submitting.value) return;
  submitting.value = true;
  try {
    await adminApi.login(username.value.trim(), password.value);
    router.replace(typeof route.query.redirect === 'string' && route.query.redirect.startsWith('/')
      ? route.query.redirect : '/admin/channels');
  } catch (e) {
    showFailToast((e as Error).message.replace(/^ADMIN_AUTH_REQUIRED: /, ''));
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div class="admin-login">
    <form class="card miv-card" @submit.prevent="submit">
      <h1>Mini AI Video · 运营后台</h1>
      <p class="miv-hint">管理员账号由部署脚本创建（npm run admin:create），与用户账号相互独立</p>
      <label>
        <span>用户名</span>
        <input v-model="username" autocomplete="username" placeholder="admin" />
      </label>
      <label>
        <span>密码</span>
        <input v-model="password" type="password" autocomplete="current-password" placeholder="••••••••" />
      </label>
      <button type="submit" :disabled="submitting || !username || !password">{{ submitting ? '登录中…' : '登录' }}</button>
    </form>
  </div>
</template>

<style scoped>
.admin-login { min-height: 100vh; display: flex; align-items: center; justify-content: center;
  background: var(--miv-bg); padding: var(--miv-space-4); }
.card { width: min(380px, 100%); display: flex; flex-direction: column; gap: var(--miv-space-3); }
h1 { font-size: 18px; margin: 0; }
label { display: flex; flex-direction: column; gap: 6px; font-size: 13px; color: var(--miv-text-2); }
input { border: 1px solid var(--miv-border); border-radius: var(--miv-radius-sm); padding: 10px 12px;
  font: inherit; background: var(--miv-surface); }
input:focus-visible { outline: 2px solid var(--miv-primary-strong); outline-offset: 1px; }
button { border: 0; border-radius: var(--miv-radius-sm); padding: 10px; font: inherit;
  background: var(--miv-primary); color: var(--miv-on-primary); cursor: pointer; }
button:disabled { opacity: 0.6; cursor: default; }
</style>
