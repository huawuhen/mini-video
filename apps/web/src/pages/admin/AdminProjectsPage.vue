<script setup lang="ts">
// 作品与失败/待核对处理页（M3-ADM-03，API.md §8.3）：列表（状态/用户/只看待核对）、
// 详情（片段/take、gen_task 状态、渠道、上游任务 ID、金额聚合、事件时间线）、
// 待核对判定（未扣费→退回 / 已扣费→结算，说明必填、二次确认、幂等键开窗生成）、
// 后台取消（与用户侧同逻辑：unknown 保持冻结；原因必填、二次确认）。写操作均记审计。
import { computed, onMounted, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { showConfirmDialog, showFailToast, showSuccessToast } from 'vant';
import { adminApi, useMock } from '@/api';
import { csrfOf } from '@/api/admin';
import type { AdminProject, AdminProjectDetail, AdminTakeInfo, ProjectStatus, ResolveOutcome } from '@/api/admin';
import { projectStatusMeta, genStatusLabel } from '@/utils/status';
import { newIdempotencyKey } from '@/utils/idempotency';
import AdminShell from './AdminShell.vue';

const route = useRoute();
const router = useRouter();

const projects = ref<AdminProject[]>([]);
const nextCursor = ref<string | null>(null);
const loading = ref(false);
const statusFilter = ref<ProjectStatus | ''>('');
const onlyUnknown = ref(false);
const userIdInput = ref('');

const yuan = (fen: number) => `¥${(fen / 100).toFixed(2)}`;
const fmtTime = (iso: string | null | undefined) => (iso ? iso.replace('T', ' ').slice(0, 16) : '—');
const dangerToken = () => getComputedStyle(document.documentElement).getPropertyValue('--miv-danger').trim() || undefined;
const statusLabel = (status: string) => projectStatusMeta[status as ProjectStatus]?.label ?? status;

const CANCELLABLE = ['understanding', 'story_review', 'casting', 'cast_review', 'rendering', 'composing', 'paused', 'failed'];

const STATUS_FILTERS: { value: ProjectStatus | ''; label: string }[] = [
  { value: '', label: '全部' },
  { value: 'failed', label: '失败' },
  { value: 'rendering', label: '制作中' },
  { value: 'story_review', label: '待确认故事' },
  { value: 'cast_review', label: '待确认角色' },
  { value: 'delivered', label: '已交付' },
  { value: 'canceled', label: '已取消' },
  { value: 'expired', label: '已过期' },
];

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
    const { items, nextCursor: cursor } = await adminApi.projects({
      status: statusFilter.value || undefined,
      userId: userIdInput.value.trim() || undefined,
      hasUnknown: onlyUnknown.value || undefined,
    });
    projects.value = items;
    nextCursor.value = cursor;
  });
}

async function loadMore() {
  await run(async () => {
    const { items, nextCursor: cursor } = await adminApi.projects({ cursor: nextCursor.value ?? undefined });
    projects.value.push(...items);
    nextCursor.value = cursor;
  });
}

// ── 详情 ──
const detail = ref<AdminProjectDetail | null>(null);
const detailOpen = ref(false);
async function openDetail(project: AdminProject) {
  await run(async () => {
    detail.value = await adminApi.project(project.id);
    detailOpen.value = true;
  });
}
async function refreshDetail() {
  if (!detail.value) return;
  detail.value = await adminApi.project(detail.value.id);
}

// ── 待核对判定 ──
const resolveForm = reactive({
  open: false, take: null as AdminTakeInfo | null, projectId: '',
  outcome: 'not_charged' as ResolveOutcome, note: '', idempotencyKey: '',
});
const resolveTarget = computed(() => {
  if (!detail.value || !resolveForm.take) return null;
  for (const seg of detail.value.segments) {
    const take = seg.takes.find((tk) => tk.id === resolveForm.take!.id);
    if (take) return { seg, take };
  }
  return null;
});
function openResolve(take: AdminTakeInfo) {
  // 幂等键打开弹窗时生成：失败重试沿用同一键，成功后清空（同调整余额/登记退款口径）
  Object.assign(resolveForm, { open: true, take, projectId: detail.value?.id ?? '',
    outcome: 'not_charged', note: '', idempotencyKey: newIdempotencyKey() });
}
async function submitResolve() {
  const target = resolveTarget.value;
  if (!target) return;
  const note = resolveForm.note.trim();
  if (!note) { showFailToast('请填写判定说明（如「渠道后台确认未扣费」），将记入审计'); return; }
  const outcomeText = resolveForm.outcome === 'not_charged'
    ? `未扣费：退还冻结 ${yuan(target.take.frozenFen)} 给用户，片段标失败（用户可重新生成）`
    : `已扣费：按原价结算冻结 ${yuan(target.take.frozenFen)}，片段标失败并在时间线注明`;
  try {
    await showConfirmDialog({
      title: '确认判定',
      message: `作品「${detail.value?.title}」片段 ${target.seg.index + 1}（上游任务 ${target.take.upstreamTaskId ?? '—'}）\n${outcomeText}\n\n判定依据：${note}\n同一片段只能判定一次，提交后不可更改。`,
      confirmButtonText: '确认判定', confirmButtonColor: dangerToken(),
    });
  } catch { return; }
  await run(async () => {
    const result = await adminApi.resolveTake(resolveForm.take!.id,
      { outcome: resolveForm.outcome, note, idempotencyKey: resolveForm.idempotencyKey });
    resolveForm.open = false;
    resolveForm.idempotencyKey = ''; // 成功才清空
    detail.value = result;
    showSuccessToast(resolveForm.outcome === 'not_charged' ? '已退回冻结费用' : '已按原价结算');
    await loadFirst();
  });
}

// ── 后台取消 ──
const cancelForm = reactive({ open: false, target: null as AdminProject | null, reason: '' });
function openCancel(project: AdminProject) {
  Object.assign(cancelForm, { open: true, target: project, reason: '' });
}
async function submitCancel() {
  const target = cancelForm.target;
  if (!target) return;
  const reason = cancelForm.reason.trim();
  if (!reason) { showFailToast('请填写取消原因（审计留档）'); return; }
  try {
    await showConfirmDialog({
      title: '确认取消作品',
      message: `「${target.title}」将取消：未消耗的冻结费用退还用户；「待核对」片段的费用保持冻结，仍需逐片段判定。`,
      confirmButtonText: '确认取消', confirmButtonColor: dangerToken(),
    });
  } catch { return; }
  await run(async () => {
    const result = await adminApi.cancelProject(target.id, reason);
    cancelForm.open = false;
    if (detail.value?.id === target.id) detail.value = result;
    showSuccessToast('已取消');
    await loadFirst();
  });
}

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
        <button v-for="f in STATUS_FILTERS" :key="f.value" type="button"
          :class="{ on: statusFilter === f.value }" @click="() => { statusFilter = f.value; loadFirst(); }">
          {{ f.label }}
        </button>
      </div>
      <form class="search" @submit.prevent="loadFirst">
        <label class="check"><input v-model="onlyUnknown" type="checkbox" @change="loadFirst" /> 只看待核对</label>
        <input v-model="userIdInput" placeholder="用户 ID（usr_…）" />
        <button type="submit" class="primary small" :disabled="loading">搜索</button>
      </form>
    </section>

    <section class="miv-card table-wrap">
      <table class="projects">
        <thead>
          <tr>
            <th>作品</th><th>用户</th><th>状态</th><th>进度</th><th>待核对</th>
            <th>创建时间</th><th>更新时间</th><th class="ops-col">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="project in projects" :key="project.id">
            <td>{{ project.title }}<div><code>{{ project.id }}</code></div></td>
            <td>{{ project.phoneMasked }}</td>
            <td><span class="tag" :class="project.status">{{ statusLabel(project.status) }}</span></td>
            <td>{{ project.progress?.percent ?? 0 }}%</td>
            <td class="num">
              <span v-if="project.unknownTakes" class="unknown-badge">{{ project.unknownTakes }} 段</span>
              <span v-else class="miv-hint">—</span>
            </td>
            <td>{{ fmtTime(project.createdAt) }}</td>
            <td>{{ fmtTime(project.updatedAt) }}</td>
            <td class="ops">
              <button type="button" @click="openDetail(project)">详情</button>
              <button v-if="CANCELLABLE.includes(project.status)" type="button" class="danger" @click="openCancel(project)">取消</button>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-if="!projects.length && !loading" class="miv-hint empty">没有匹配的作品。</p>
      <div v-if="nextCursor" class="more">
        <button type="button" class="ghost" :disabled="loading" @click="loadMore">{{ loading ? '加载中…' : '加载更多' }}</button>
      </div>
    </section>

    <!-- 详情 -->
    <Teleport to="body">
      <div v-if="detailOpen && detail" class="mask" @click.self="detailOpen = false">
        <div class="dialog miv-card detail">
          <div class="detail-head">
            <h2>{{ detail.title }}</h2>
            <span class="tag" :class="detail.status">{{ statusLabel(detail.status) }}</span>
            <button type="button" class="ghost" @click="detailOpen = false">关闭</button>
          </div>
          <p class="miv-hint">
            用户 {{ detail.phoneMasked }} <code>{{ detail.userId }}</code> · 更新 {{ fmtTime(detail.updatedAt) }}
            <template v-if="CANCELLABLE.includes(detail.status)">
              · <button type="button" class="danger inline" @click="openCancel(detail)">取消此作品</button>
            </template>
          </p>
          <div class="money">
            <div><b>{{ yuan(detail.money.reservedFen) }}</b><span>累计预占</span></div>
            <div><b>{{ yuan(detail.money.settledFen) }}</b><span>已结算</span></div>
            <div><b>{{ yuan(detail.money.refundedFen) }}</b><span>已退回</span></div>
            <div><b :class="{ warn: detail.money.frozenFen > 0 }">{{ yuan(detail.money.frozenFen) }}</b><span>冻结中</span></div>
          </div>
          <div class="miv-section-title">片段与生成任务</div>
          <div v-for="seg in detail.segments" :key="seg.id" class="segment">
            <div class="seg-head">
              <b>片段 {{ seg.index + 1 }} · {{ seg.durationSeconds }} 秒</b>
              <span class="miv-hint">{{ seg.plot }}</span>
            </div>
            <div v-for="take in seg.takes" :key="take.id" class="take" :class="{ unknown: take.status === 'unknown' && !take.resolvedOutcome }">
              <div class="take-line">
                <span class="tag" :class="take.status">{{ genStatusLabel[take.status] ?? take.status }}</span>
                <code>{{ take.id }}</code>
                <span v-if="take.resolvedOutcome" class="resolved">
                  {{ take.resolvedOutcome === 'charged' ? '已核对：上游已计费' : '已核对：上游未扣费，已退回' }}
                </span>
                <span v-else-if="take.status === 'unknown'" class="frozen">冻结 {{ yuan(take.frozenFen) }}</span>
              </div>
              <div class="take-meta">
                <span>gen_task：{{ genStatusLabel[take.genTaskStatus as never] ?? take.genTaskStatus ?? '—' }}</span>
                <span>渠道：{{ take.channel ?? '—' }}</span>
                <span>上游任务：<code>{{ take.upstreamTaskId ?? '—' }}</code></span>
                <span>{{ fmtTime(take.createdAt) }}</span>
              </div>
              <p v-if="take.resolvedOutcome" class="miv-hint">判定说明：{{ take.resolvedNote }}（{{ fmtTime(take.resolvedAt) }}）</p>
              <div v-if="take.status === 'unknown' && !take.resolvedOutcome" class="take-ops">
                <button type="button" class="primary small" @click="openResolve(take)">判定</button>
              </div>
            </div>
          </div>
          <div class="miv-section-title">事件时间线</div>
          <ol class="events">
            <li v-for="event in detail.events" :key="event.id">
              <span class="tag" :class="event.status">{{ statusLabel(event.status) }}</span>
              <span class="msg">{{ event.progress?.message }}</span>
              <span class="time">{{ fmtTime(event.createdAt) }}</span>
            </li>
          </ol>
        </div>
      </div>
    </Teleport>

    <!-- 判定 -->
    <Teleport to="body">
      <div v-if="resolveForm.open" class="mask" @click.self="resolveForm.open = false">
        <form class="dialog miv-card" @submit.prevent="submitResolve">
          <h2>待核对判定</h2>
          <p class="notice">请先在渠道后台 / 上游控制台核实该片段的实际计费与生成结果，再在此判定。</p>
          <p class="miv-hint">
            片段时长 {{ resolveTarget?.seg.durationSeconds }} 秒 · 冻结 {{ yuan(resolveForm.take?.frozenFen ?? 0) }}
            · 上游任务 <code>{{ resolveForm.take?.upstreamTaskId ?? '—' }}</code>。同一片段只能判定一次。
          </p>
          <div class="outcomes">
            <label :class="{ on: resolveForm.outcome === 'not_charged' }">
              <input v-model="resolveForm.outcome" type="radio" value="not_charged" />
              <span><b>上游未扣费 / 未生成</b>退还冻结 {{ yuan(resolveForm.take?.frozenFen ?? 0) }}，片段标失败，用户可重新生成</span>
            </label>
            <label :class="{ on: resolveForm.outcome === 'charged' }">
              <input v-model="resolveForm.outcome" type="radio" value="charged" />
              <span><b>上游已扣费</b>按原价结算冻结 {{ yuan(resolveForm.take?.frozenFen ?? 0) }}，片段标失败并在时间线注明</span>
            </label>
          </div>
          <label class="full">
            <span>判定说明（必填，记入审计）</span>
            <input v-model="resolveForm.note" maxlength="200" placeholder="如：渠道后台确认该任务未扣费" />
          </label>
          <div class="foot">
            <button type="button" class="ghost" @click="resolveForm.open = false">取消</button>
            <button type="submit" class="primary">下一步（二次确认）</button>
          </div>
        </form>
      </div>
    </Teleport>

    <!-- 取消 -->
    <Teleport to="body">
      <div v-if="cancelForm.open" class="mask" @click.self="cancelForm.open = false">
        <form class="dialog miv-card" @submit.prevent="submitCancel">
          <h2>取消作品</h2>
          <p class="miv-hint">「{{ cancelForm.target?.title }}」：未消耗的冻结费用退还用户；「待核对」片段的费用保持冻结，仍需逐片段判定。与用户侧取消同一套状态与退款逻辑。</p>
          <label class="full">
            <span>取消原因（必填，审计留档）</span>
            <input v-model="cancelForm.reason" maxlength="200" placeholder="如：渠道长期不可用，经核实取消" />
          </label>
          <div class="foot">
            <button type="button" class="ghost" @click="cancelForm.open = false">取消</button>
            <button type="submit" class="danger-solid">下一步（二次确认）</button>
          </div>
        </form>
      </div>
    </Teleport>
  </AdminShell>
</template>

<style scoped src="./admin-page.css"></style>
<style scoped>
td code { font-size: 11px; }
.unknown-badge { background: var(--miv-warning-soft); color: var(--miv-text); border-radius: 999px; padding: 2px 10px; font-size: 12px; }
.detail-head { display: flex; align-items: center; gap: var(--miv-space-3); }
.detail-head h2 { flex: 1; margin: 0; font-size: 16px; }
.detail .danger.inline { border: 0; background: transparent; color: var(--miv-danger); cursor: pointer; font: inherit; font-size: 13px; padding: 0; }
.money { display: grid; grid-template-columns: repeat(4, 1fr); gap: var(--miv-space-2); }
.money div { display: flex; flex-direction: column; gap: 2px; background: var(--miv-bg); border-radius: var(--miv-radius-md); padding: 8px 10px; }
.money b { font-size: 14px; font-variant-numeric: tabular-nums; }
.money b.warn { color: var(--miv-warning); }
.money span { font-size: 11px; color: var(--miv-text-2); }
.segment { display: flex; flex-direction: column; gap: var(--miv-space-2); border: 1px solid var(--miv-border); border-radius: var(--miv-radius-md); padding: var(--miv-space-2) var(--miv-space-3); }
.seg-head { display: flex; align-items: baseline; gap: var(--miv-space-3); }
.seg-head b { font-size: 13px; white-space: nowrap; }
.take { display: flex; flex-direction: column; gap: 4px; padding: var(--miv-space-2) 0; border-top: 1px dashed var(--miv-border); }
.take.unknown { background: var(--miv-warning-soft); border-radius: var(--miv-radius-sm); padding: var(--miv-space-2); }
.take-line { display: flex; align-items: center; gap: var(--miv-space-2); flex-wrap: wrap; }
.take-line .frozen { color: var(--miv-warning); font-size: 12px; font-weight: 600; }
.take-line .resolved { color: var(--miv-success-strong); font-size: 12px; }
.take-meta { display: flex; gap: var(--miv-space-3); flex-wrap: wrap; font-size: 12px; color: var(--miv-text-2); }
.take-ops { display: flex; justify-content: flex-end; }
.outcomes { display: flex; flex-direction: column; gap: var(--miv-space-2); }
.outcomes label { flex-direction: row; align-items: flex-start; gap: 8px; border: 1px solid var(--miv-border); border-radius: var(--miv-radius-md); padding: 10px 12px; cursor: pointer; font-size: 12px; color: var(--miv-text-2); }
.outcomes label.on { border-color: var(--miv-primary); background: var(--miv-primary-soft); }
.outcomes label span b { display: block; color: var(--miv-text); font-size: 13px; margin-bottom: 2px; }
.notice { margin: 0; padding: 10px 12px; border-radius: var(--miv-radius-sm); background: var(--miv-warning-soft); color: var(--miv-text); font-size: 13px; }
.events { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
.events li { display: flex; align-items: baseline; gap: var(--miv-space-2); padding: 6px 0; border-bottom: 1px dashed var(--miv-border); }
.events .msg { flex: 1; font-size: 13px; }
.events .time { color: var(--miv-text-3); font-size: 12px; white-space: nowrap; }
</style>
