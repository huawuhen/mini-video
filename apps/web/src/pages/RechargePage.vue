<script setup lang="ts">
// 在线充值页（M3-PAY-03，API §3.1 / docs/UI.md）：只有档位——按环境自动选支付方式：
// 微信内 JSAPI（无 openid 先静默授权；wechatAuth=failed 回来时不再自动跳，显示提示与
// 「重新授权」按钮，防授权失败死循环）、手机浏览器 H5（未开通提示在微信中打开）、PC native 扫码。
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { showFailToast, showToast } from 'vant';
import { api, type RechargeOptions } from '@/api';
import { isWechatBrowser, pickScene } from '@/utils/payEnv';
import { formatFen } from '@/utils/money';

const route = useRoute();
const router = useRouter();

const options = ref<RechargeOptions | null>(null);
const selectedFen = ref<number | null>(null);
const submitting = ref(false);
/** OAuth 回调带 wechatAuth=failed 回来：不自动跳授权，展示提示 + 手动「重新授权」 */
const authFailed = computed(() => route.query.wechatAuth === 'failed');
const authJumped = ref(false); // 本次会话已自动跳过一次授权（防异常循环）

const choice = computed(() => pickScene(options.value?.scenes ?? []));
const amounts = computed(() => options.value?.amountsFen ?? []);

function startOauth() {
  // 后端 302 整页跳转（snsapi_base 静默授权），returnTo 限站内
  window.location.href = `/api/v1/wechat/oauth/start?returnTo=${encodeURIComponent('/wallet/recharge')}`;
}

async function load() {
  try {
    options.value = await api.rechargeOptions();
  } catch (e) {
    showFailToast((e as Error).message);
    return;
  }
  if (!amounts.value.length) return;
  selectedFen.value = amounts.value.includes(5000) ? 5000 : amounts.value[0];
  // 微信内无 openid：首次自动发起静默授权（授权失败回来后不再自动跳，改手动按钮）
  if (isWechatBrowser && choice.value.scene === 'jsapi' && !options.value.wechatOpenidReady
    && !authFailed.value && !authJumped.value) {
    authJumped.value = true;
    startOauth();
  }
}
onMounted(load);

function callJsapiPay(params: Record<string, string>, orderId: string) {
  const invoke = () => window.WeixinJSBridge?.invoke('getBrandWCPayRequest', params, (result) => {
    if (result.err_msg === 'get_brand_wcpay_request:ok') {
      void router.replace({ path: `/wallet/recharge/${orderId}` });
    } else {
      // 用户取消等：留在本页（订单仍在，可重新发起或去结果页查看）
      showToast('未完成支付，可重试或稍后在订单中继续');
    }
  });
  if (typeof window.WeixinJSBridge === 'undefined') {
    // 桥尚未注入：等一次 WeixinJSBridgeReady；非微信环境（mock/走查）等不到则进结果页等待
    document.addEventListener('WeixinJSBridgeReady', invoke, { once: true });
    setTimeout(() => {
      if (typeof window.WeixinJSBridge === 'undefined') void router.replace({ path: `/wallet/recharge/${orderId}` });
    }, 1500);
  } else {
    invoke();
  }
}

async function submit() {
  if (selectedFen.value == null || submitting.value) return;
  const scene = choice.value.scene;
  if (!scene) return;
  submitting.value = true;
  try {
    const order = await api.createRechargeOrder({ amountFen: selectedFen.value, scene, idempotencyKey: crypto.randomUUID() });
    if (scene === 'jsapi' && order.pay?.type === 'jsapi') {
      const { params } = order.pay;
      callJsapiPay({ appId: params.appId, timeStamp: params.timeStamp, nonceStr: params.nonceStr,
        package: params.package, signType: params.signType, paySign: params.paySign }, order.id);
    } else if (scene === 'h5' && order.pay?.type === 'h5') {
      window.location.href = order.pay.url; // 整页跳转微信收银台，支付后浏览器回退到本站
    } else {
      void router.push({ path: `/wallet/recharge/${order.id}` }); // native：结果页扫码
    }
  } catch (e) {
    showFailToast((e as Error).message);
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div class="miv-page recharge">
    <van-nav-bar title="在线充值" left-arrow @click-left="router.back()" />

    <van-notice-bar v-if="authFailed" left-icon="info-o" mode="closeable"
      text="微信授权未完成，暂时无法在微信内支付，可点击重新授权后再试" />
    <section v-if="authFailed && isWechatBrowser" class="miv-card retry-auth">
      <p class="miv-hint">本次充值需要先完成微信授权（用于确认付款人身份，不会添加好友或发送消息）。</p>
      <van-button type="primary" size="small" plain @click="startOauth">重新授权</van-button>
    </section>

    <section class="miv-card">
      <div class="miv-section-title">选择充值金额</div>
      <template v-if="options">
        <div v-if="!options.scenes.length" class="miv-hint empty">
          在线充值暂未开放，可先使用兑换码充值。
          <router-link class="link" to="/wallet">去兑换</router-link>
        </div>
        <template v-else-if="choice.hint === 'wechat-only'">
          <p class="miv-hint">当前浏览器暂不支持在线支付，请<span class="em">在微信中打开本页面</span>完成充值。</p>
          <p class="miv-hint sub">也可以先使用兑换码：<router-link class="link" to="/wallet">去兑换</router-link></p>
        </template>
        <template v-else>
          <div class="amounts">
            <button
              v-for="fen in amounts" :key="fen" type="button" class="amount"
              :class="{ on: selectedFen === fen }" @click="selectedFen = fen"
            >¥{{ formatFen(fen) }}</button>
          </div>
          <p class="miv-hint sub">支付方式：{{ { jsapi: '微信支付', h5: '微信支付（浏览器跳转）', native: '微信扫码支付' }[choice.scene!] }}</p>
          <van-button type="primary" class="miv-btn-accent" block :loading="submitting"
            :disabled="selectedFen == null" @click="submit">立即支付</van-button>
          <p v-if="isWechatBrowser && choice.scene === 'jsapi' && !options.wechatOpenidReady && !authFailed"
            class="miv-hint sub">如未自动弹出微信支付，请点「重新授权」后重试</p>
        </template>
      </template>
      <van-skeleton v-else :row="2" title />
    </section>

    <p class="miv-hint foot">充值后金额进入余额，用于支付视频生成费用；订单 30 分钟内有效。</p>
  </div>
</template>

<style scoped>
.retry-auth { display: flex; flex-direction: column; gap: var(--miv-space-2); align-items: flex-start; }
.amounts { display: grid; grid-template-columns: repeat(2, 1fr); gap: var(--miv-space-2); margin: var(--miv-space-2) 0; }
.amount { border: 1.5px solid var(--miv-border); background: var(--miv-surface); border-radius: var(--miv-radius-md);
  padding: var(--miv-space-3); font: inherit; font-size: 18px; font-weight: 600; color: var(--miv-text-1); cursor: pointer; white-space: nowrap; }
.amount.on { border-color: var(--miv-primary); background: var(--miv-primary-soft); color: var(--miv-primary-strong); }
.sub { margin-top: var(--miv-space-2); }
.em { color: var(--miv-primary-strong); font-weight: 600; }
.empty { padding: var(--miv-space-2) 0; }
.link { color: var(--miv-primary); }
.foot { text-align: center; padding: 0 var(--miv-space-3); }
</style>
