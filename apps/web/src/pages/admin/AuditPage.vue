<script setup lang="ts">
// 审计日志页（M3-ADM-04，API.md §8.5，只读）：全部管理端操作留痕（含 IP），
// 支持操作人/动作前缀/对象类型/对象 ID/日期范围过滤，游标分页。
import { onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { showFailToast } from 'vant';
import { adminApi } from '@/api';
import type { AdminAuditItem } from '@/api/admin';
import AdminShell from './AdminShell.vue';

const route = useRoute();
const router = useRouter();

const loading = ref(false);
const items = ref<AdminAuditItem[]>([]);
const nextCursor = ref<string | null>(null);
const filters = ref({ adminUsername: '', action: '', targetType: '', targetId: '', from: '', to: '' });

const fmtTime = (iso: string) => iso.replace('T', ' ').slice(0, 19);
/** detail 摘要：挑关键变更渲染，避免表格被大 JSON 撑爆。 */
function detailSummary(detail: Record<string, unknown>): string {
  const entries = Object.entries(detail ?? {}).filter(([, value]) => value !== undefined && value !== null);
  if (!entries.length) return '—';
  return entries.slice(0, 4).map(([key, value]) =>
    `${key}=${typeof value === 'object' ? JSON.stringify(value) : String(value)}`).join('，');
}

async function run(action: () => Promise<void>) {
  loading.value = true;
  try { await action(); } catch (e) {
    const status = (e as { status?: number }).status;
    const code = (e as { code?: string }).code;
    if (status === 401 || code === 'ADMIN_AUTH_REQUIRED' || code === 'CSRF_INVALID') {
      router.replace({ path: '/admin/login', query: { redirect: route.fullPath } });
      return;
    }
    showFailToast((e as Error).message);
  } finally { loading.value = false; }
}

function query(extra: Record<string, string | undefined> = {}) {
  return {
    adminId: filters.value.adminUsername.trim() || undefined,
    action: filters.value.action.trim() || undefined,
    targetType: filters.value.targetType.trim() || undefined,
    targetId: filters.value.targetId.trim() || undefined,
    from: filters.value.from || undefined,
    to: filters.value.to || undefined,
    ...extra,
  };
}

async function loadFirst() {
  await run(async () => {
    const page = await adminApi.audit(query());
    items.value = page.items;
    nextCursor.value = page.nextCursor;
  });
}

async function loadMore() {
  if (!nextCursor.value) return;
  await run(async () => {
    const page = await adminApi.audit(query({ cursor: nextCursor.value ?? undefined }));
    items.value.push(...page.items);
    nextCursor.value = page.nextCursor;
  });
}

function clearFilters() {
  filters.value = { adminUsername: '', action: '', targetType: '', targetId: '', from: '', to: '' };
  void loadFirst();
}

onMounted(loadFirst);
</script>

<template>
  <AdminShell>
    <section class="bar miv-card">
      <form class="filters" @submit.prevent="loadFirst">
        <input v-model="filters.adminUsername" placeholder="操作人用户名" />
        <input v-model="filters.action" placeholder="动作前缀（如 channel.）" />
        <input v-model="filters.targetType" placeholder="对象类型（如 sku）" />
        <input v-model="filters.targetId" placeholder="对象 ID" />
        <input v-model="filters.from" type="date" title="起始日期" />
        <input v-model="filters.to" type="date" title="结束日期（含当天）" />
        <button type="submit" class="primary small" :disabled="loading">查询</button>
        <button type="button" class="ghost" :disabled="loading" @click="clearFilters">清空</button>
      </form>
    </section>

    <section class="miv-card table-wrap">
      <table>
        <thead>
          <tr><th class="num">ID</th><th>时间</th><th>操作人</th><th>动作</th>
            <th>对象</th><th>详情</th><th>IP</th></tr>
        </thead>
        <tbody>
          <tr v-for="item in items" :key="item.id">
            <td class="num">{{ item.id }}</td>
            <td class="nowrap">{{ fmtTime(item.createdAt) }}</td>
            <td>{{ item.adminUsername }}</td>
            <td><code>{{ item.action }}</code></td>
            <td class="nowrap">{{ item.targetType }}<br /><code class="tid">{{ item.targetId }}</code></td>
            <td class="wrap">{{ detailSummary(item.detail) }}</td>
            <td class="nowrap">{{ item.ip ?? '—' }}</td>
          </tr>
        </tbody>
      </table>
      <p v-if="!items.length && !loading" class="miv-hint empty">没有匹配的审计记录。</p>
      <div v-if="nextCursor" class="more">
        <button type="button" class="ghost" :disabled="loading" @click="loadMore">{{ loading ? '加载中…' : '加载更多' }}</button>
      </div>
    </section>
  </AdminShell>
</template>

<style scoped>
.filters { display: flex; gap: var(--miv-space-2); flex-wrap: wrap; align-items: center; }
.filters input { border: 1px solid var(--miv-border); border-radius: var(--miv-radius-sm); padding: 7px 10px;
  font: inherit; font-size: 13px; background: var(--miv-surface); color: var(--miv-text); }
.filters input:not([type='date']) { width: 180px; }
table { font-size: 12.5px; }
td code { font-size: 11.5px; }
.tid { word-break: break-all; }
.nowrap { white-space: nowrap; }
.wrap { max-width: 320px; white-space: normal; word-break: break-all; }
button.ghost { background: var(--miv-bg); color: var(--miv-text-2); border: 1px solid var(--miv-border);
  border-radius: var(--miv-radius-sm); padding: 7px 14px; font: inherit; font-size: 13px; cursor: pointer; }
</style>

<!-- 表格 / 分页等共用样式（admin-page.css），与用户/订单页同口径 -->
<style scoped src="./admin-page.css"></style>
