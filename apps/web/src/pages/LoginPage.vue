<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { showToast } from 'vant';
import { renderLegalMarkdown, privacyText, termsText } from '@/utils/legal';
import { api, useMock } from '@/api';
import { useAuthStore } from '@/stores/auth';

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const phone = ref('');
const code = ref('');
const agreed = ref(false);
// M3-LEGAL-01：协议在抽屉里打开（不离开登录页，已填手机号/验证码不丢失）
const doc = ref<'terms' | 'privacy' | null>(null);
const docTitle = computed(() => (doc.value === 'privacy' ? '隐私政策' : '用户协议'));
const docHtml = computed(() => renderLegalMarkdown(doc.value === 'privacy' ? privacyText : termsText));
const docVisible = computed({ get: () => doc.value !== null, set: (v) => { if (!v) doc.value = null; } });
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
      <div class="brand"><span class="logo">▶</span><h1>登录剧优兔AI</h1></div>
      <p class="slogan">剧优兔，一键出好剧，轻松赚收益</p>
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
        <span class="miv-hint">我已阅读并同意<a class="legal-link" role="button" @click.stop="doc = 'terms'">《用户协议》</a>和<a class="legal-link" role="button" @click.stop="doc = 'privacy'">《隐私政策》</a></span>
      </van-checkbox>
      <van-button type="primary" block :loading="loading" :disabled="!phoneValid || code.length !== 6" @click="login">登录</van-button>
    </div>
    <!-- M3-LEGAL-01 必改②：协议抽屉放根节点下（原先嵌在 van-field 的 #button 插槽里，
         继承输入区右对齐导致正文右对齐）；PC 下限宽 760 居中 -->
    <van-popup v-model:show="docVisible" position="bottom" round class="doc-sheet" :style="{ maxHeight: '85vh' }">
      <div class="doc-head">
        <strong>{{ docTitle }}</strong>
        <button type="button" class="doc-close" aria-label="关闭" @click="doc = null">×</button>
      </div>
      <div class="doc-scroll"><article class="doc" v-html="docHtml" /></div>
    </van-popup>
  </div>
</template>

<style scoped>
.login { min-height: 100vh; background: linear-gradient(180deg, var(--miv-primary-soft), var(--miv-bg) 40%); }
.nav { background: transparent; }
.panel { max-width: 420px; margin: var(--miv-space-5) var(--miv-space-4); display: flex; flex-direction: column; gap: var(--miv-space-3); padding: var(--miv-space-5); }
.brand { display: flex; align-items: center; gap: var(--miv-space-2); }
.logo { width: 32px; height: 32px; border-radius: 9px; background: var(--miv-primary); color: var(--miv-on-primary); display: inline-flex; align-items: center; justify-content: center; font-size: 13px; }
h1 { font-size: 20px; }
.field { background: var(--miv-bg); border-radius: var(--miv-radius-md); }
.agree { margin: var(--miv-space-1) 0; }
@media (min-width: 480px) { .panel { margin: 10vh auto 0; } }
.legal-link { color: var(--miv-primary); cursor: pointer; }
.doc-sheet { display: flex; flex-direction: column; background: var(--miv-surface); }
@media (min-width: 480px) { .doc-sheet { max-width: 760px; left: 50%; right: auto; transform: translateX(-50%); border-radius: var(--miv-radius-lg) var(--miv-radius-lg) 0 0; } }
.doc-head { display: flex; align-items: center; justify-content: space-between; padding: var(--miv-space-3) var(--miv-space-4) 0; }
.doc-head strong { font-size: 16px; }
.doc-close { border: 0; background: transparent; font-size: 22px; line-height: 1; color: var(--miv-text-3); cursor: pointer; padding: 4px 8px; }
.doc-scroll { overflow-y: auto; padding: var(--miv-space-3) var(--miv-space-4) calc(var(--miv-space-3) + env(safe-area-inset-bottom)); }
.doc { font-size: 14px; line-height: 1.7; color: var(--miv-text); }
.doc :deep(h2) { font-size: 16px; margin: 1.2em 0 0.5em; }
.doc :deep(h3), .doc :deep(h4), .doc :deep(h5) { font-size: 14.5px; margin: 1em 0 0.4em; }
.doc :deep(p) { margin: 0.5em 0; }
.doc :deep(blockquote) { margin: 0.6em 0; padding: 0.5em 0.8em; background: var(--miv-primary-soft); border-left: 3px solid var(--miv-primary); font-size: 12.5px; color: var(--miv-text-2); }
.doc :deep(ul), .doc :deep(ol) { margin: 0.5em 0; padding-left: 1.3em; }
.doc :deep(ol) { list-style: decimal; }  /* M3-LEGAL-01 必改⑤：保留条款序号 */
.doc :deep(li) { margin: 0.25em 0; }
.doc :deep(table) { display: block; max-width: 100%; overflow-x: auto; border-collapse: collapse; margin: 0.6em 0; font-size: 12.5px; white-space: nowrap; }
.doc :deep(th), .doc :deep(td) { border: 1px solid var(--miv-border); padding: 4px 8px; text-align: left; }
.doc :deep(th) { background: var(--miv-bg); }
.slogan { margin: var(--miv-space-1) 0 0; font-size: 13px; color: var(--miv-primary-strong); letter-spacing: 0.5px; }
</style>
