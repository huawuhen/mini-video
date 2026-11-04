<script setup lang="ts">
// 用户与余额页（M3-ADM-02，API.md §8.1）：掩码列表、完整手机号精确搜索（搜索记审计）、
// 详情（统计/同意记录/微信绑定/流水）、余额调整（元↔分、原因必填、二次确认）、
// 停用/启用/注销（注销不可恢复，confirm=true 二次确认）。所有写操作走独立会话 + CSRF。
import { onMounted, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { showConfirmDialog, showFailToast, showSuccessToast, showToast } from 'vant';
import { adminApi, useMock } from '@/api';
import { csrfOf } from '@/api/admin';
import type { AdminLedgerItem, AdminUser, AdminUserDetail, UserStatus } from '@/api/admin';
import AdminShell from './AdminShell.vue';

const route = useRoute();
const router = useRouter();

const STATUS_LABEL: Record<UserStatus, string> = { active: '正常', disabled: '已停用', deactivated: '已注销' };
const KIND_LABEL: Record<AdminLedgerItem['kind'], string> = {
  recharge: '充值', redeem: '兑换码', reserve: '预占', settle: '结算', refund: '退回', charge: '扣费', adjust: '客服调整',
};

const users = ref<AdminUser[]>([]);
const nextCursor = ref<string | null>(null);
const loading = ref(false);
const statusFilter = ref<UserStatus | ''>('');
const phoneInput = ref('');
const userIdInput = ref('');

const yuan = (fen: number) => `¥${(fen / 100).toFixed(2)}`;
const fmtTime = (iso: string | null) => (iso ? iso.replace('T', ' ').slice(0, 16) : '—');
const dangerToken = () => getComputedStyle(document.documentElement).getPropertyValue('--miv-danger').trim() || undefined;

/** 元输入 → 整数分（最多两位小数，金额一律整数分）。 */
function parseYuanToFen(input: string): number | null {
  const text = input.trim();
  if (!/^(0|[1-9]\d*)(\.\d{1,2})?$/.test(text) || Number(text) === 0) return null;
  return Math.round(Number(text) * 100);
}

async function run(action: () => Promise<void>) {
  loading.value = true;
  try { await action(); } catch (e) {
    if ((e as { status?: number }).status === 401 || (e as { code?: string }).code === 'ADMIN_AUTH_REQUIRED') {
      router.replace({ path: '/admin/login', query: { redirect: route.fullPath } });
      return;
    }
    if ((e as { code?: string }).code === 'CSRF_INVALID') {
      router.replace({ path: '/admin/login', query: { redirect: route.fullPath } });
      return;
    }
    showFailToast((e as Error).message);
  } finally { loading.value = false; }
}

async function loadFirst() {
  await run(async () => {
    const query = {
      phone: phoneInput.value.trim() || undefined,
      userId: userIdInput.value.trim() || undefined,
      status: statusFilter.value || undefined,
    };
    const { items, nextCursor: cursor } = await adminApi.users(query);
    users.value = items;
    nextCursor.value = cursor;
  });
}

async function loadMore() {
  await run(async () => {
    const query = {
      status: statusFilter.value || undefined,
      cursor: nextCursor.value ?? undefined,
    };
    const { items, nextCursor: cursor } = await adminApi.users(query);
    users.value.push(...items);
    nextCursor.value = cursor;
  });
}

function clearSearch() {
  phoneInput.value = '';
  userIdInput.value = '';
  statusFilter.value = '';
  void loadFirst();
}

// ── 详情（含流水） ──
const detail = ref<AdminUserDetail | null>(null);
const ledger = ref<AdminLedgerItem[]>([]);
const ledgerCursor = ref<string | null>(null);
const detailOpen = ref(false);

async function openDetail(user: AdminUser) {
  await run(async () => {
    detail.value = await adminApi.user(user.id);
    const page = await adminApi.userLedger(user.id);
    ledger.value = page.items;
    ledgerCursor.value = page.nextCursor;
    detailOpen.value = true;
  });
}
async function loadMoreLedger() {
  if (!detail.value || !ledgerCursor.value) return;
  await run(async () => {
    const page = await adminApi.userLedger(detail.value!.id, ledgerCursor.value!);
    ledger.value.push(...page.items);
    ledgerCursor.value = page.nextCursor;
  });
}
const entryAmount = (entry: AdminLedgerItem) =>
  entry.kind === 'settle' ? entry.frozenDeltaFen : entry.amountFen;
const entryAmountText = (entry: AdminLedgerItem) => {
  const fen = entryAmount(entry);
  if (entry.kind === 'settle') return `冻结 ${yuan(fen)}`;
  return `${fen > 0 ? '+' : '−'}${yuan(Math.abs(fen))}`;
};

// ── 余额调整 ──
const adjustForm = reactive({ open: false, target: null as AdminUser | null, direction: 'add' as 'add' | 'sub', amount: '', reason: '' });
function openAdjust(user: AdminUser) {
  Object.assign(adjustForm, { open: true, target: user, direction: 'add', amount: '', reason: '' });
}
async function submitAdjust() {
  const target = adjustForm.target;
  if (!target) return;
  const fen = parseYuanToFen(adjustForm.amount);
  if (fen === null) { showFailToast('金额需大于 0，最多两位小数（元）'); return; }
  const reason = adjustForm.reason.trim();
  if (!reason) { showFailToast('请填写调整原因（用户不可见，仅后台与审计留档）'); return; }
  const amountFen = adjustForm.direction === 'add' ? fen : -fen;
  try {
    await showConfirmDialog({
      title: '确认调整余额',
      message: `用户 ${target.phoneMasked}（${target.nickname}）\n将${adjustForm.direction === 'add' ? '增加' : '扣减'} ${yuan(fen)}${adjustForm.direction === 'sub' && target.balanceFen < fen ? '\n\n⚠️ 扣减超过当前可用余额，会被拒绝' : ''}\n原因：${reason}`,
      confirmButtonText: '确认调整',
    });
  } catch { return; }
  await run(async () => {
    const result = await adminApi.adjustBalance(target.id, { amountFen, reason, idempotencyKey: crypto.randomUUID() });
    adjustForm.open = false;
    showSuccessToast(`已调整，当前余额 ${yuan(result.wallet.availableFen)}`);
    await loadFirst();
  });
}

// ── 停用 / 启用 ──
const statusForm = reactive({ open: false, target: null as AdminUser | null, action: 'disable' as 'disable' | 'enable', reason: '' });
function openStatus(user: AdminUser, action: 'disable' | 'enable') {
  Object.assign(statusForm, { open: true, target: user, action, reason: '' });
}
async function submitStatus() {
  const target = statusForm.target;
  if (!target) return;
  const reason = statusForm.reason.trim();
  if (!reason) { showFailToast('请填写原因'); return; }
  try {
    await showConfirmDialog({
      title: statusForm.action === 'disable' ? '确认停用' : '确认启用',
      message: statusForm.action === 'disable'
        ? `停用后 ${target.phoneMasked} 立即退出登录、不能登录；进行中的作品会继续跑完。`
        : `恢复 ${target.phoneMasked} 的登录与使用。`,
      confirmButtonText: statusForm.action === 'disable' ? '确认停用' : '确认启用',
      confirmButtonColor: statusForm.action === 'disable' ? dangerToken() : undefined,
    });
  } catch { return; }
  await run(async () => {
    await adminApi.setUserStatus(target.id, statusForm.action, reason);
    statusForm.open = false;
    showSuccessToast(statusForm.action === 'disable' ? '已停用' : '已启用');
    await loadFirst();
  });
}

// ── 注销（不可恢复） ──
const deactForm = reactive({ open: false, target: null as AdminUser | null, reason: '' });
function openDeactivate(user: AdminUser) {
  Object.assign(deactForm, { open: false, target: user, reason: '' });
  deactForm.open = true;
}
async function submitDeactivate() {
  const target = deactForm.target;
  if (!target) return;
  const reason = deactForm.reason.trim();
  if (!reason) { showFailToast('请填写注销原因（剩余余额将随之清零，请先与用户确认处理方式）'); return; }
  try {
    await showConfirmDialog({
      title: '⚠️ 确认注销（不可恢复）',
      message: `用户 ${target.phoneMasked} 将被永久注销：\n· 立即退出登录，手机号释放、可重新注册为新用户\n· 照片、角色卡、作品视频文件将被删除，记录匿名保留\n· 剩余可用余额 ${yuan(target.balanceFen)} 记一条清零流水\n\n注销前请确认该用户没有进行中的作品，并已按协议与用户确认余额处理。`,
      confirmButtonText: '确认注销', confirmButtonColor: dangerToken(),
    });
  } catch { return; }
  await run(async () => {
    await adminApi.setUserStatus(target.id, 'deactivate', reason);
    deactForm.open = false;
    showSuccessToast('已注销');
    await loadFirst();
  });
}

onMounted(() => {
  // CSRF 令牌只存内存：非 mock 且本会话未登录过（刷新后）直接回登录页（M3-ADM-01 口径）
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
        <button v-for="s in (['', 'active', 'disabled', 'deactivated'] as const)" :key="s" type="button"
          :class="{ on: statusFilter === s }" @click="() => { statusFilter = s; loadFirst(); }">
          {{ s === '' ? '全部' : STATUS_LABEL[s] }}
        </button>
      </div>
      <form class="search" @submit.prevent="loadFirst">
        <input v-model="phoneInput" inputmode="numeric" maxlength="11" placeholder="完整手机号精确搜索" />
        <button type="submit" class="primary small" :disabled="loading">搜索</button>
      </form>
    </section>

    <section class="miv-card table-wrap">
      <table class="users">
        <thead>
          <tr>
            <th>手机号</th><th>昵称</th><th>状态</th><th>可用余额</th><th>冻结</th>
            <th>注册时间</th><th>最近登录</th><th class="ops-col">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="user in users" :key="user.id">
            <td>{{ user.phoneMasked }}</td>
            <td>{{ user.nickname }}</td>
            <td><span class="tag" :class="user.status">{{ STATUS_LABEL[user.status] }}</span></td>
            <td class="num">{{ yuan(user.balanceFen) }}</td>
            <td class="num">{{ user.frozenFen ? yuan(user.frozenFen) : '—' }}</td>
            <td>{{ fmtTime(user.createdAt) }}</td>
            <td>{{ fmtTime(user.lastLoginAt) }}</td>
            <td class="ops">
              <button type="button" @click="openDetail(user)">详情</button>
              <button v-if="user.status === 'active'" type="button" @click="openAdjust(user)">调整余额</button>
              <button v-if="user.status === 'active'" type="button" @click="openStatus(user, 'disable')">停用</button>
              <button v-if="user.status === 'disabled'" type="button" @click="openStatus(user, 'enable')">启用</button>
              <button v-if="user.status !== 'deactivated'" type="button" class="danger" @click="openDeactivate(user)">注销</button>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-if="!users.length && !loading" class="miv-hint empty">没有匹配的用户——手机号只支持完整号码精确搜索。</p>
      <div v-if="nextCursor" class="more">
        <button type="button" class="ghost" :disabled="loading" @click="loadMore">{{ loading ? '加载中…' : '加载更多' }}</button>
      </div>
    </section>

    <!-- 详情抽屉（含流水） -->
    <Teleport to="body">
      <div v-if="detailOpen && detail" class="mask" @click.self="detailOpen = false">
        <div class="dialog miv-card detail">
          <div class="detail-head">
            <h2>{{ detail.phoneMasked }} · {{ detail.nickname }}</h2>
            <span class="tag" :class="detail.status">{{ STATUS_LABEL[detail.status] }}</span>
            <button type="button" class="ghost" @click="detailOpen = false">关闭</button>
          </div>
          <code class="uid">{{ detail.id }}</code>
          <div class="stats">
            <div><b>{{ detail.stats.projects }}</b><span>作品</span></div>
            <div><b>{{ detail.stats.delivered }}</b><span>已交付</span></div>
            <div><b>{{ detail.stats.characters }}</b><span>数字人</span></div>
            <div><b>{{ yuan(detail.stats.rechargedFen) }}</b><span>累计充值</span></div>
            <div><b>{{ yuan(detail.stats.spentFen) }}</b><span>累计消费</span></div>
            <div><b>{{ yuan(detail.balanceFen) }}</b><span>可用余额</span></div>
          </div>
          <p class="miv-hint">
            协议 {{ detail.consents.terms ?? '未同意' }} · 照片同意 {{ detail.consents.photo ?? '未同意' }}
            · 微信{{ detail.wechatBound ? '已绑定' : '未绑定' }}
          </p>
          <div class="miv-section-title">账务流水</div>
          <ol class="ledger">
            <li v-for="entry in ledger" :key="entry.id">
              <span class="kind" :class="entry.kind">{{ KIND_LABEL[entry.kind] }}</span>
              <span class="title">{{ entry.title
                }}<em v-if="entry.reason" class="miv-hint">（{{ entry.reason }}<template v-if="entry.adminUsername"> · {{ entry.adminUsername }}</template>）</em></span>
              <span class="amount" :class="{ plus: entryAmount(entry) > 0 && entry.kind !== 'settle' }">{{ entryAmountText(entry) }}</span>
              <span class="time">{{ fmtTime(entry.createdAt) }}</span>
            </li>
          </ol>
          <div v-if="ledgerCursor" class="more">
            <button type="button" class="ghost" :disabled="loading" @click="loadMoreLedger">加载更多流水</button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- 调整余额 -->
    <Teleport to="body">
      <div v-if="adjustForm.open" class="mask" @click.self="adjustForm.open = false">
        <form class="dialog miv-card" @submit.prevent="submitAdjust">
          <h2>调整余额</h2>
          <p class="miv-hint">用户 {{ adjustForm.target?.phoneMasked }} · 当前可用 {{ yuan(adjustForm.target?.balanceFen ?? 0) }}。调整走账本（adjust），按幂等键防重复。</p>
          <div class="grid">
            <label>
              <span>方向</span>
              <select v-model="adjustForm.direction">
                <option value="add">增加（补偿/活动奖励）</option>
                <option value="sub">扣减（纠错/退款登记外的冲正）</option>
              </select>
            </label>
            <label>
              <span>金额（元）</span>
              <input v-model="adjustForm.amount" inputmode="decimal" placeholder="如 12.34" />
            </label>
          </div>
          <label class="full">
            <span>原因（必填，仅后台可见）</span>
            <input v-model="adjustForm.reason" maxlength="200" placeholder="如：活动奖励补偿 / 多扣费冲正" />
          </label>
          <div class="foot">
            <button type="button" class="ghost" @click="adjustForm.open = false">取消</button>
            <button type="submit" class="primary">下一步（二次确认）</button>
          </div>
        </form>
      </div>
    </Teleport>

    <!-- 停用 / 启用 -->
    <Teleport to="body">
      <div v-if="statusForm.open" class="mask" @click.self="statusForm.open = false">
        <form class="dialog miv-card" @submit.prevent="submitStatus">
          <h2>{{ statusForm.action === 'disable' ? '停用用户' : '启用用户' }}</h2>
          <p class="miv-hint">{{ statusForm.target?.phoneMasked }}（{{ statusForm.target?.nickname }}）</p>
          <label class="full">
            <span>原因（必填，审计留档）</span>
            <input v-model="statusForm.reason" maxlength="200" :placeholder="statusForm.action === 'disable' ? '如：风控核查期间暂停' : '如：核查无误恢复'" />
          </label>
          <div class="foot">
            <button type="button" class="ghost" @click="statusForm.open = false">取消</button>
            <button type="submit" class="primary">{{ statusForm.action === 'disable' ? '下一步（二次确认）' : '确认启用' }}</button>
          </div>
        </form>
      </div>
    </Teleport>

    <!-- 注销 -->
    <Teleport to="body">
      <div v-if="deactForm.open" class="mask" @click.self="deactForm.open = false">
        <form class="dialog miv-card" @submit.prevent="submitDeactivate">
          <h2>注销用户（不可恢复）</h2>
          <p class="miv-hint">{{ deactForm.target?.phoneMasked }}（{{ deactForm.target?.nickname }}）。注销不可恢复：删除照片/角色卡/作品视频，记录匿名保留；剩余余额 {{ yuan(deactForm.target?.balanceFen ?? 0) }} 记一条清零流水。</p>
          <label class="full">
            <span>注销原因（必填，审计留档）</span>
            <input v-model="deactForm.reason" maxlength="200" placeholder="如：用户按隐私政策申请注销，余额已确认" />
          </label>
          <div class="foot">
            <button type="button" class="ghost" @click="deactForm.open = false">取消</button>
            <button type="submit" class="danger-solid">下一步（二次确认）</button>
          </div>
        </form>
      </div>
    </Teleport>
  </AdminShell>
</template>

<style scoped src="./admin-page.css"></style>
