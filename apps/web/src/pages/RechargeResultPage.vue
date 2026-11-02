<script setup lang="ts">
// 支付结果页（M3-PAY-03）：只轮询 GET /wallet/recharge/:orderId 判断是否成功
// （API §3.1：不以前端支付回调或跳转判断；服务端有节流主动查单 + 对账兜底）。
// native：渲染微信支付二维码（qrcode 本地生成，不依赖外网）；mock：提供「模拟支付成功」。
import { onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import QRCode from 'qrcode';
import { showFailToast } from 'vant';
import { api, type RechargeOrder } from '@/api';
import { formatFen } from '@/utils/money';
import { useWalletStore } from '@/stores/wallet';

const route = useRoute();
const router = useRouter();
const walletStore = useWalletStore();

const order = ref<RechargeOrder | null>(null);
const qrDataUrl = ref('');
const canMockPay = typeof api.mockPayOrder === 'function';
const mockPaying = ref(false);
let timer: ReturnType<typeof setTimeout> | undefined;

async function load() {
  const id = String(route.params.orderId ?? '');
  try {
    order.value = await api.getRechargeOrder(id);
  } catch (e) {
    showFailToast((e as Error).message);
    return;
  }
  if (order.value.status === 'paid') {
    if (order.value.wallet) walletStore.wallet = order.value.wallet;
    else void walletStore.refresh();
    return; // 终态：停止轮询
  }
  if (order.value.status !== 'created') return; // expired/failed：终态停止
  // created：native 二维码；继续轮询（支付结果只以服务端为准）
  if (order.value.pay?.type === 'native' && !qrDataUrl.value) {
    qrDataUrl.value = await QRCode.toDataURL(order.value.pay.codeUrl, { width: 220, margin: 1 });
  }
  timer = setTimeout(load, 2000);
}

async function mockPay() {
  if (!api.mockPayOrder || mockPaying.value) return;
  mockPaying.value = true;
  try {
    order.value = await api.mockPayOrder(String(route.params.orderId ?? ''));
    if (order.value.status === 'paid' && order.value.wallet) walletStore.wallet = order.value.wallet;
  } catch (e) {
    showFailToast((e as Error).message);
  } finally {
    mockPaying.value = false;
  }
}

watch(() => route.params.orderId, () => {
  clearTimeout(timer);
  qrDataUrl.value = '';
  void load();
}, { immediate: true });

onUnmounted(() => clearTimeout(timer));

const statusText = { created: '等待支付', paid: '支付成功', expired: '订单已过期', failed: '支付失败' } as const;
</script>

<template>
  <div class="miv-page result">
    <van-nav-bar title="支付结果" left-arrow @click-left="router.back()" />

    <section v-if="order" class="miv-card">
      <div class="state" :class="order.status">
        <span class="icon">{{ { created: '⏳', paid: '✅', expired: '⌛', failed: '⚠️' }[order.status] }}</span>
        <strong>{{ statusText[order.status] }}</strong>
        <span class="amount">¥{{ formatFen(order.amountFen) }}</span>
      </div>

      <template v-if="order.status === 'created'">
        <div v-if="qrDataUrl" class="qr">
          <img :src="qrDataUrl" alt="微信支付二维码" />
          <p class="miv-hint">打开微信「扫一扫」扫码支付</p>
        </div>
        <p v-else class="miv-hint center">支付完成后本页会自动刷新…</p>
        <p class="miv-hint center sub">
          订单 {{ new Date(order.expiresAt).toLocaleTimeString('zh-CN') }} 过期；
          <router-link class="link" to="/wallet/recharge">返回充值</router-link>
        </p>
        <van-button v-if="canMockPay" block plain type="primary" :loading="mockPaying" @click="mockPay">
          模拟支付成功（演示模式）
        </van-button>
      </template>

      <template v-else-if="order.status === 'paid'">
        <p class="miv-hint center">到账金额已加入余额，当前可用余额
          ¥{{ formatFen(walletStore.wallet?.availableFen ?? order.wallet?.availableFen ?? 0) }}</p>
        <van-button type="primary" class="miv-btn-accent" block to="/wallet">查看钱包</van-button>
        <van-button block plain type="primary" to="/">去创作</van-button>
      </template>

      <template v-else>
        <p class="miv-hint center">未完成支付的金额不会扣除；如有疑问请联系客服。</p>
        <van-button type="primary" block to="/wallet/recharge">重新充值</van-button>
      </template>
    </section>
    <van-skeleton v-else :row="3" title />
  </div>
</template>

<style scoped>
.state { display: flex; flex-direction: column; align-items: center; gap: var(--miv-space-2); padding: var(--miv-space-3) 0; }
.state .icon { font-size: 40px; }
.state strong { font-size: 18px; }
.state.paid strong { color: var(--miv-primary); }
.amount { font-size: 22px; font-weight: 700; }
.qr { display: flex; flex-direction: column; align-items: center; gap: var(--miv-space-2); padding: var(--miv-space-2) 0; }
.qr img { width: 220px; height: 220px; border: 1px solid var(--miv-border); border-radius: var(--miv-radius-md); background: #fff; padding: 8px; }
.center { text-align: center; }
.sub { margin-bottom: var(--miv-space-2); }
.link { color: var(--miv-primary); }
section { display: flex; flex-direction: column; gap: var(--miv-space-2); }
</style>
