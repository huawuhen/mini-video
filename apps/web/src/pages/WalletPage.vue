<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { showToast } from 'vant';
import { api, type LedgerEntry } from '@/api';
import PriceTag from '@/components/PriceTag.vue';
import { useWalletStore } from '@/stores/wallet';
import { formatFen } from '@/utils/money';

const walletStore = useWalletStore();
const ledger = ref<LedgerEntry[]>([]);
const code = ref('');
const redeeming = ref(false);
const kindLabel: Record<LedgerEntry['kind'], string> = { recharge: '充值', redeem: '兑换', reserve: '预占', settle: '结算', refund: '退回', adjust: '调整' };

async function load() {
  await walletStore.refresh();
  ledger.value = (await api.ledger()).items;
}
onMounted(load);
async function redeem() {
  if (!code.value.trim()) return;
  redeeming.value = true;
  try {
    const result = await api.redeem(code.value.trim());
    showToast(`已到账 ¥${formatFen(result.amountFen)}`);
    code.value = '';
    await load();
  } catch (e) { showToast((e as Error).message); } finally { redeeming.value = false; }
}
const date = (iso: string) => new Date(iso).toLocaleString('zh-CN');
</script>

<template>
  <div class="miv-page wallet">
    <section class="balance miv-card">
      <span class="miv-hint">可用余额（元）</span>
      <PriceTag :fen="walletStore.wallet?.availableFen ?? 0" size="lg" />
      <span class="miv-hint">制作中冻结 ¥{{ formatFen(walletStore.wallet?.frozenFen ?? 0) }}，完成后按实际结算</span>
      <van-button type="primary" class="miv-btn-accent" block disabled>在线充值（即将上线）</van-button>
    </section>
    <section class="miv-card">
      <div class="miv-section-title">兑换码</div>
      <div class="redeem">
        <van-field v-model="code" placeholder="输入兑换码" :border="false" class="code" />
        <van-button type="primary" :loading="redeeming" @click="redeem">兑换</van-button>
      </div>
    </section>
    <section class="miv-card">
      <div class="miv-section-title">明细</div>
      <van-cell v-for="item in ledger" :key="item.id" :title="item.title" :label="`${kindLabel[item.kind]} · ${date(item.createdAt)}`">
        <template #value><span :class="item.amountFen >= 0 ? 'plus' : 'minus'">{{ item.amountFen >= 0 ? '+' : '' }}{{ formatFen(item.amountFen) }}</span></template>
      </van-cell>
      <van-empty v-if="!ledger.length" description="暂无记录" image-size="64" />
    </section>
  </div>
</template>

<style scoped>
.wallet { display: flex; flex-direction: column; gap: var(--miv-space-3); max-width: 760px; }
.balance { display: flex; flex-direction: column; gap: var(--miv-space-2); }
.redeem { display: flex; gap: var(--miv-space-2); }
.code { background: var(--miv-bg); border-radius: var(--miv-radius-md); }
.plus { color: var(--miv-success); }
.minus { color: var(--miv-text); }
</style>
