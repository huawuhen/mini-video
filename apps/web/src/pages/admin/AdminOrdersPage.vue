<script setup lang="ts">
// 充值订单页（M3-ADM-02，API.md §8.2）：状态/用户/订单号/时间范围过滤、详情（通知与入账），
// 手动对账（与定时对账同口径）、记录式人工退款——按钮旁写明「请先在微信商户平台完成退款，再在此登记」，
// 校验订单已支付、累计不超订单金额、用户余额足够；金额一律整数分，原因必填、二次确认、写审计。
import { onMounted, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { showConfirmDialog, showFailToast, showSuccessToast, showToast } from 'vant';
import { adminApi, useMock } from '@/api';
import { csrfOf } from '@/api/admin';
import type { AdminOrder, AdminOrderDetail, OrderStatus } from '@/api/admin';
import AdminShell from './AdminShell.vue';

const route = useRoute();
const router = useRouter();

const STATUS_LABEL: Record<OrderStatus, string> = { created: '待支付', paid: '已支付', expired: '已过期', failed: '失败' };
const SCENE_LABEL: Record<string, string> = { jsapi: '微信内', h5: '手机浏览器', native: 'PC 扫码' };

const orders = ref<AdminOrder[]>([]);
const nextCursor = ref<string | null>(null);
const loading = ref(false);
const filters = reactive({
  status: '' as OrderStatus | '', userId: '', outTradeNo: '', from: '', to: '',
});

const yuan = (fen: number) => `¥${(fen / 100).toFixed(2)}`;
const fmtTime = (iso: string | null) => (iso ? iso.replace('T', ' ').slice(0, 16) : '—');

async function run(action: () => Promise<void>) {
  loading.value = true;
  try { await action(); } catch (e) {
    if ((e as { status?: number }).status === 401 || (e as { code?: string }).code === 'ADMIN_AUTH_REQUIRED'
      || (e as { code?: string }).code === 'CSRF_INVALID') {
      router.replace({ path: '/admin/login', query: { redirect: route.fullPath } });
      return;
    }
    showFailToast((e as Error).message);
  } finally { loading.value = false; }
}

async function loadFirst() {
  await run(async () => {
    const { items, nextCursor: cursor } = await adminApi.orders({
      status: filters.status || undefined,
      userId: filters.userId.trim() || undefined,
      outTradeNo: filters.outTradeNo.trim() || undefined,
      from: filters.from ? new Date(`${filters.from}T00:00:00`).toISOString() : undefined,
      to: filters.to ? new Date(`${filters.to}T23:59:59`).toISOString() : undefined,
    });
    orders.value = items;
    nextCursor.value = cursor;
  });
}

async function loadMore() {
  await run(async () => {
    const { items, nextCursor: cursor } = await adminApi.orders({ cursor: nextCursor.value ?? undefined });
    orders.value.push(...items);
    nextCursor.value = cursor;
  });
}

// ── 详情 ──
const detail = ref<AdminOrderDetail | null>(null);
const detailOpen = ref(false);
async function openDetail(order: AdminOrder) {
  await run(async () => {
    detail.value = await adminApi.order(order.id);
    detailOpen.value = true;
  });
}

// ── 手动对账 ──
async function reconcile(order: AdminOrder) {
  try {
    await showConfirmDialog({
      title: '手动对账',
      message: `立刻向微信查单并按结果更新「${order.outTradeNo}」（与定时对账同一逻辑：已支付补入账、已关闭置过期）。`,
      confirmButtonText: '开始对账',
    });
  } catch { return; }
  await run(async () => {
    const updated = await adminApi.reconcileOrder(order.id);
    showSuccessToast(`对账完成：${STATUS_LABEL[updated.status]}`);
    await loadFirst();
  });
}

// ── 记录式人工退款 ──
const refundForm = reactive({ open: false, target: null as AdminOrder | null, amount: '', reason: '' });
function openRefund(order: AdminOrder) {
  Object.assign(refundForm, { open: true, target: order, amount: '', reason: '' });
}
function parseYuanToFen(input: string): number | null {
  const text = input.trim();
  if (!/^(0|[1-9]\d*)(\.\d{1,2})?$/.test(text) || Number(text) === 0) return null;
  return Math.round(Number(text) * 100);
}
async function submitRefund() {
  const target = refundForm.target;
  if (!target) return;
  const fen = parseYuanToFen(refundForm.amount);
  if (fen === null) { showFailToast('金额需大于 0，最多两位小数（元）'); return; }
  const reason = refundForm.reason.trim();
  if (!reason) { showFailToast('请填写退款原因（审计留档）'); return; }
  try {
    await showConfirmDialog({
      title: '确认登记退款',
      message: `订单 ${target.outTradeNo}（${yuan(target.amountFen)}，已退 ${yuan(target.refundedFen)}）\n登记退款 ${yuan(fen)}：从用户可用余额扣减并累计已退金额。\n\n请确认已在微信商户平台完成实际退款。`,
      confirmButtonText: '确认登记', confirmButtonColor: dangerToken(),
    });
  } catch { return; }
  await run(async () => {
    const result = await adminApi.refundOrder(target.id, { amountFen: fen, reason, idempotencyKey: crypto.randomUUID() });
    refundForm.open = false;
    showSuccessToast(`已登记，累计已退 ${yuan(result.order.refundedFen)}`);
    await loadFirst();
  });
}
const dangerToken = () => getComputedStyle(document.documentElement).getPropertyValue('--miv-danger').trim() || undefined;

onMounted(() => {
  if (!useMock && !csrfOf()) {
    router.replace({ path: '/admin/login', query: { redirect: route.fullPath } });
    return;
  }
  void loadFirst();
});
</script>

<template>
  <AdminShell>
    <section class="bar miv-card">
      <div class="tabs">
        <button v-for="s in (['', 'created', 'paid', 'expired', 'failed'] as const)" :key="s" type="button"
          :class="{ on: filters.status === s }" @click="() => { filters.status = s; loadFirst(); }">
          {{ s === '' ? '全部' : STATUS_LABEL[s] }}
        </button>
      </div>
      <form class="search" @submit.prevent="loadFirst">
        <input v-model="filters.outTradeNo" placeholder="订单号精确搜索" />
        <input v-model="filters.userId" placeholder="用户 ID（usr_…）" />
        <input v-model="filters.from" type="date" title="创建时间从" />
        <input v-model="filters.to" type="date" title="创建时间到" />
        <button type="submit" class="primary small" :disabled="loading">搜索</button>
      </form>
    </section>

    <section class="miv-card table-wrap">
      <table class="orders">
        <thead>
          <tr>
            <th>订单号</th><th>用户</th><th>金额</th><th>已退</th><th>方式</th><th>状态</th>
            <th>创建时间</th><th>支付时间</th><th class="ops-col">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="order in orders" :key="order.id">
            <td><code>{{ order.outTradeNo }}</code></td>
            <td>{{ order.phoneMasked }}</td>
            <td class="num">{{ yuan(order.amountFen) }}</td>
            <td class="num">{{ order.refundedFen ? yuan(order.refundedFen) : '—' }}</td>
            <td>{{ SCENE_LABEL[order.scene] }}</td>
            <td><span class="tag" :class="order.status">{{ STATUS_LABEL[order.status] }}</span></td>
            <td>{{ fmtTime(order.createdAt) }}</td>
            <td>{{ fmtTime(order.paidAt) }}</td>
            <td class="ops">
              <button type="button" @click="openDetail(order)">详情</button>
              <button v-if="order.status === 'created'" type="button" @click="reconcile(order)">手动对账</button>
              <button v-if="order.status === 'paid'" type="button" class="danger" @click="openRefund(order)">登记退款</button>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-if="!orders.length && !loading" class="miv-hint empty">没有匹配的订单。</p>
      <div v-if="nextCursor" class="more">
        <button type="button" class="ghost" :disabled="loading" @click="loadMore">{{ loading ? '加载中…' : '加载更多' }}</button>
      </div>
    </section>

    <!-- 详情 -->
    <Teleport to="body">
      <div v-if="detailOpen && detail" class="mask" @click.self="detailOpen = false">
        <div class="dialog miv-card">
          <div class="detail-head">
            <h2>订单 {{ detail.outTradeNo }}</h2>
            <span class="tag" :class="detail.status">{{ STATUS_LABEL[detail.status] }}</span>
            <button type="button" class="ghost" @click="detailOpen = false">关闭</button>
          </div>
          <code class="uid">{{ detail.id }}</code>
          <div class="kv">
            <span>用户</span><b>{{ detail.phoneMasked }} <code>{{ detail.userId }}</code></b>
            <span>金额</span><b>{{ yuan(detail.amountFen) }}</b>
            <span>已退</span><b>{{ detail.refundedFen ? yuan(detail.refundedFen) : '—' }}</b>
            <span>微信单号</span><b><code>{{ detail.transactionId ?? '—' }}</code></b>
            <span>支付方式</span><b>{{ SCENE_LABEL[detail.scene] }}</b>
            <span>创建时间</span><b>{{ fmtTime(detail.createdAt) }}</b>
            <span>支付时间</span><b>{{ fmtTime(detail.paidAt) }}</b>
            <span>回调通知</span><b>{{ detail.notifyCount }} 次<template v-if="detail.lastNotifyAt"> · 最近 {{ fmtTime(detail.lastNotifyAt) }}</template></b>
            <span>入账流水</span><b><code>{{ detail.ledgerId ?? '—' }}</code></b>
          </div>
          <p v-if="detail.status === 'paid'" class="miv-hint">退款请先在微信商户平台完成操作，再回到列表点「登记退款」记录我方账务。</p>
        </div>
      </div>
    </Teleport>

    <!-- 登记退款 -->
    <Teleport to="body">
      <div v-if="refundForm.open" class="mask" @click.self="refundForm.open = false">
        <form class="dialog miv-card" @submit.prevent="submitRefund">
          <h2>登记退款（记录式）</h2>
          <p class="notice">请先在微信商户平台完成退款，再在此登记。</p>
          <p class="miv-hint">订单 {{ refundForm.target?.outTradeNo }} · 金额 {{ yuan(refundForm.target?.amountFen ?? 0) }} · 已退 {{ yuan(refundForm.target?.refundedFen ?? 0) }}。登记后从用户可用余额扣减并写一条「充值退款」流水，不影响微信侧。</p>
          <div class="grid">
            <label>
              <span>退款金额（元）</span>
              <input v-model="refundForm.amount" inputmode="decimal" placeholder="如 30.00" />
            </label>
            <label>
              <span>可退上限（元）</span>
              <input :value="((refundForm.target?.amountFen ?? 0) - (refundForm.target?.refundedFen ?? 0)) / 100" disabled />
            </label>
          </div>
          <label class="full">
            <span>原因（必填，审计留档）</span>
            <input v-model="refundForm.reason" maxlength="200" placeholder="如：用户申请退款，商户平台已原路退回" />
          </label>
          <div class="foot">
            <button type="button" class="ghost" @click="refundForm.open = false">取消</button>
            <button type="submit" class="danger-solid">下一步（二次确认）</button>
          </div>
        </form>
      </div>
    </Teleport>
  </AdminShell>
</template>

<style scoped src="./admin-page.css"></style>
<style scoped>
.search input[type='date'] { width: 140px; }
.kv { display: grid; grid-template-columns: 96px 1fr; gap: 8px 12px; font-size: 13px; }
.kv span { color: var(--miv-text-2); }
.kv b { font-weight: 500; font-variant-numeric: tabular-nums; word-break: break-all; }
.notice { margin: 0; padding: 10px 12px; border-radius: var(--miv-radius-sm);
  background: var(--miv-warning-soft); color: var(--miv-text); font-size: 13px; }
input[disabled] { color: var(--miv-text-3); background: var(--miv-bg); }
@media (max-width: 767px) {
  .kv { grid-template-columns: 84px 1fr; }
}
</style>
