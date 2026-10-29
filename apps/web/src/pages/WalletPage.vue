<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { showToast } from 'vant';
import { api, type LedgerEntry } from '@/api';
import PriceTag from '@/components/PriceTag.vue';
import { useWalletStore } from '@/stores/wallet';
import { formatFen } from '@/utils/money';

const route = useRoute();
const walletStore = useWalletStore();
// 从收费弹窗「去充值」过来时，充值后可回到原页面（docs/UI.md §8）
const back = computed(() => (typeof route.query.back === 'string' && route.query.back.startsWith('/') ? route.query.back : ''));
const ledger = ref<LedgerEntry[]>([]);
const code = ref('');
const redeeming = ref(false);
const kindLabel: Record<LedgerEntry['kind'], string> = { recharge: '充值', redeem: '兑换', reserve: '预占', settle: '结算', refund: '退回', charge: '扣费', adjust: '调整' };
/** 结算行 amountFen=0、frozenFen=-实扣：显示为灰色「−¥X」并注明来源，避免读成「收入 0 元」（API.md §3） */
function amountOf(item: LedgerEntry) {
  // 负号统一用 −（U+2212）：结算「从冻结中扣除」与预占/扣费的负数字形一致（§6 复审遗留 d）
  if (item.amountFen === 0 && item.frozenFen < 0) return { text: `−${formatFen(-item.frozenFen)}`, cls: 'frozen-out' };
  if (item.amountFen < 0) return { text: `−${formatFen(-item.amountFen)}`, cls: 'minus' };
  return { text: `+${formatFen(item.amountFen)}`, cls: item.amountFen > 0 ? 'plus' : 'minus' };
}
function labelOf(item: LedgerEntry) {
  const extra = item.amountFen === 0 && item.frozenFen < 0 ? ' · 从冻结中扣除'
    : item.kind === 'reserve' ? ' · 冻结，完成后结算' : '';
  return `${kindLabel[item.kind]}${extra} · ${date(item.createdAt)}`;
}

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
      <van-button v-if="back" block plain type="primary" :to="back">充好了，返回继续</van-button>
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
      <van-cell v-for="item in ledger" :key="item.id" :title="item.title" :label="labelOf(item)">
        <template #value><span :class="amountOf(item).cls">{{ amountOf(item).text }}</span></template>
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
.frozen-out { color: var(--miv-text-3); }
.redeem .van-button { white-space: nowrap; min-width: 88px; flex-shrink: 0; } /* PC 宽下列宽过窄会把按钮文字竖排 */
</style>
