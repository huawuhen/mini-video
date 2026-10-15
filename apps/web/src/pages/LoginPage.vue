<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { showToast } from 'vant';
import { api, useMock } from '@/api';
import { useAuthStore } from '@/stores/auth';

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const phone = ref('');
const code = ref('');
const agreed = ref(false);
const cooldown = ref(0);
const loading = ref(false);
let timer: ReturnType<typeof setInterval> | undefined;
const phoneValid = computed(() => /^1\d{10}$/.test(phone.value));

async function sendCode() {
  if (!phoneValid.value || cooldown.value) return;
  try {
    const { cooldownSeconds } = await api.sendSms(phone.value);
    cooldown.value = cooldownSeconds;
    timer = setInterval(() => { if (--cooldown.value <= 0) clearInterval(timer); }, 1000);
    showToast(useMock ? '演示环境：输入任意 6 位数字' : '验证码已发送');
  } catch (e) { showToast((e as Error).message); }
}
async function login() {
  if (!agreed.value) { showToast('请先阅读并同意用户协议和隐私政策'); return; }
  loading.value = true;
  try {
    await auth.login(phone.value, code.value);
    const redirect = typeof route.query.redirect === 'string' && route.query.redirect.startsWith('/') ? route.query.redirect : '/';
    router.replace(redirect);
  } catch (e) { showToast((e as Error).message); } finally { loading.value = false; }
}
onBeforeUnmount(() => clearInterval(timer));
</script>

<template>
  <div class="login">
    <van-nav-bar left-arrow @click-left="router.back()" :border="false" class="nav" />
    <div class="panel miv-card">
      <div class="brand"><span class="logo">▶</span><h1>登录 Mini AI Video</h1></div>
      <p class="miv-muted">未注册的手机号验证后自动创建账号</p>
      <van-field v-model="phone" type="tel" maxlength="11" placeholder="手机号" class="field" />
      <van-field v-model="code" type="digit" maxlength="6" placeholder="验证码" class="field">
        <template #button>
          <van-button size="small" type="primary" plain :disabled="!phoneValid || cooldown > 0" @click="sendCode">
            {{ cooldown > 0 ? `${cooldown} 秒` : '获取验证码' }}
          </van-button>
        </template>
      </van-field>
      <van-checkbox v-model="agreed" icon-size="16" class="agree">
        <span class="miv-hint">我已阅读并同意《用户协议》和《隐私政策》</span>
      </van-checkbox>
      <van-button type="primary" block :loading="loading" :disabled="!phoneValid || code.length !== 6" @click="login">登录</van-button>
    </div>
  </div>
</template>

<style scoped>
.login { min-height: 100vh; background: linear-gradient(180deg, var(--miv-primary-soft), var(--miv-bg) 40%); }
.nav { background: transparent; }
.panel { max-width: 420px; margin: var(--miv-space-5) var(--miv-space-4); display: flex; flex-direction: column; gap: var(--miv-space-3); padding: var(--miv-space-5); }
.brand { display: flex; align-items: center; gap: var(--miv-space-2); }
.logo { width: 32px; height: 32px; border-radius: 9px; background: var(--miv-primary); color: #fff; display: inline-flex; align-items: center; justify-content: center; font-size: 13px; }
h1 { font-size: 20px; }
.field { background: var(--miv-bg); border-radius: var(--miv-radius-md); }
.agree { margin: var(--miv-space-1) 0; }
@media (min-width: 480px) { .panel { margin: 10vh auto 0; } }
</style>
