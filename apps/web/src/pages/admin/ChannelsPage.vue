<script setup lang="ts">
// 渠道管理页（M3-ADM-01，API.md §8 / docs/UI.md PC 优先）：
// 列表（状态/健康/在途/掩码凭证/成本对比）、按驱动 configSchema 渲染的新增/编辑表单、
// 软删除、测试连接/试生成（二次确认，试生成有真实费用警示）、路由排序与一键主用、启停、
// 重新加载配置（重拉 drivers/channels/routes）、告警红点（驱动缺失 / 高失败率）。
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { showConfirmDialog, showFailToast, showSuccessToast, showToast } from 'vant';
import { adminApi, useMock } from '@/api';
import { csrfOf } from '@/api/admin';
import type { Channel, ChannelKind, ChannelStatus, DriverInfo, RouteRow } from '@/api/admin';

const route = useRoute();
const router = useRouter();

const channels = ref<Channel[]>([]);
const drivers = ref<DriverInfo[]>([]);
const routesByKind = reactive<Record<string, RouteRow[]>>({ video: [], image: [], llm: [] });
const loading = ref(false);
const kindFilter = ref<ChannelKind | ''>('');
const includeRetired = ref(false);

/** Vant 弹窗按钮色需要具体色值：从设计令牌取（不写死）。 */
const dangerToken = () => getComputedStyle(document.documentElement).getPropertyValue('--miv-danger').trim() || undefined;

const KIND_LABEL: Record<ChannelKind, string> = { video: '视频', image: '图片', llm: '文本' };
const STATUS_LABEL: Record<ChannelStatus, string> = { active: '启用', disabled: '停用', retired: '已删除' };

/** 近 1 小时失败率（total≥5 且失败率>20% 视为异常，告警黄/红点的口径）。 */
function healthOf(channel: Channel): { tone: 'ok' | 'warn' | 'bad' | 'none'; text: string } {
  if (channel.unavailable) return { tone: 'bad', text: '驱动缺失' };
  if (!channel.recent || channel.recent.total === 0) return { tone: 'none', text: '暂无数据' };
  const { total, failed, avgQueueSeconds } = channel.recent;
  const rate = failed / total;
  if (rate > 0.2) return { tone: 'bad', text: `失败 ${failed}/${total}（${Math.round(rate * 100)}%）` };
  if (failed > 0) return { tone: 'warn', text: `成功 ${total - failed}/${total} · 失败 ${failed}` };
  return { tone: 'ok', text: `成功 ${total}/${total}${avgQueueSeconds != null ? ` · 平均排队 ${Math.round(avgQueueSeconds / 60)} 分钟` : ''}` };
}

const alertCount = computed(() => channels.value.filter((c) => healthOf(c).tone === 'bad').length);

const shown = computed(() => channels.value.filter((c) => (!kindFilter.value || c.kind === kindFilter.value)
  && (includeRetired.value || c.status !== 'retired')));

async function reload(silent = false) {
  loading.value = true;
  try {
    const [d, c] = await Promise.all([adminApi.drivers(), adminApi.channels(undefined, true)]);
    drivers.value = d.items;
    channels.value = c.items;
    for (const kind of ['video', 'image', 'llm'] as ChannelKind[]) {
      routesByKind[kind] = (await adminApi.routes(kind)).items;
    }
    if (!silent) showToast('已重新加载');
  } catch (e) {
    // ① 按状态码/错误码判断（MivApiError.message 是中文文案，不含错误码）
    if ((e as { status?: number }).status === 401 || (e as { code?: string }).code === 'ADMIN_AUTH_REQUIRED') {
      router.replace({ path: '/admin/login', query: { redirect: route.fullPath } });
      return;
    }
    showFailToast((e as Error).message);
  } finally {
    loading.value = false;
  }
}
// ② CSRF 令牌只存内存：非 mock 且本会话未登录过（刷新后）直接回登录页，
// 否则列表能加载（Cookie 仍有效）但所有写操作都 403 CSRF_INVALID 且无解
onMounted(() => {
  if (!useMock && !csrfOf()) {
    router.replace({ path: '/admin/login', query: { redirect: route.fullPath } });
    return;
  }
  void reload(true);
});
async function logout() {
  await adminApi.logout().catch(() => undefined);
  router.replace('/admin/login');
}

// ── 路由排序与一键主用 ──
const routeKind = computed<ChannelKind>(() => (kindFilter.value || 'video') as ChannelKind);
// 暂存路由是独立可写的响应式状态（③ 复审：此前操作的是 computed 返回的临时数组，
// 加入/移出后 joinable 与保存内容都不对）。加载、保存、切换类型时从后端结果重建；
// 排序 / 设主用 / 移出 / 加入只改这份暂存，点保存统一 PUT。
const routeDraft = ref<RouteRow[]>([]);
const routeChannels = computed(() => routeDraft.value);
const routeDirty = ref(false);

/** 后端返回该 kind 全部 capability 的路由行，只取通用路由（capability='*'）——
 * 专用路由（如 video.720p）将来出现时同一渠道会重复，保存也会被「渠道列表有重复」拒绝。 */
function syncRouteDraft(kind: ChannelKind) {
  routeDraft.value = routesByKind[kind].filter((r) => r.capability === '*');
  routeDirty.value = false;
}

// 切换类型或后端路由数据刷新（reload/save 后重写 routesByKind）时，暂存从后端结果重建
// （未保存的暂存改动随之丢弃，路由区文案已说明只暂存）
watch([routeKind, () => routesByKind[routeKind.value]], ([kind]) => syncRouteDraft(kind), { immediate: true });

function moveRoute(index: number, delta: -1 | 1) {
  const list = routeDraft.value;
  const target = index + delta;
  if (target < 0 || target >= list.length) return;
  [list[index], list[target]] = [list[target], list[index]];
  routeDirty.value = true;
}
function makePrimary(index: number) {
  const list = routeDraft.value;
  const [row] = list.splice(index, 1);
  list.unshift(row);
  routeDirty.value = true;
}
function removeFromRoute(index: number) {
  routeDraft.value.splice(index, 1);
  routeDirty.value = true;
}
/** 同类型、启用中、暂存路由之外的渠道——「加入路由」候选（③：新建/启用渠道不会自动入路由）。 */
const joinable = computed(() => channels.value.filter((c) => c.kind === routeKind.value
  && c.status === 'active' && !routeDraft.value.some((r) => r.id === c.id)));
function joinRoute(id: string) {
  const channel = channels.value.find((c) => c.id === id);
  if (!channel) return;
  routeDraft.value.push({ capability: '*', rank: routeDraft.value.length,
    id: channel.id, name: channel.name, status: channel.status, driver: channel.driver });
  routeDirty.value = true;
}
async function saveRoutes() {
  try {
    const { items } = await adminApi.setRoutes(routeKind.value, routeDraft.value.map((r) => r.id));
    routesByKind[routeKind.value] = items;
    syncRouteDraft(routeKind.value); // 后端结果为准重建暂存（顺带清脏）
    showSuccessToast('路由已保存');
  } catch (e) { showFailToast((e as Error).message); }
}

// ── 操作 ──
async function toggleStatus(channel: Channel) {
  const next: 'active' | 'disabled' = channel.status === 'active' ? 'disabled' : 'active';
  try {
    await showConfirmDialog({ title: next === 'disabled' ? '停用渠道' : '启用渠道',
      message: `「${channel.name}」将${next === 'disabled' ? '停用（新生成请求不再选它，在途任务继续轮询）' : '重新启用'}。`,
      confirmButtonText: next === 'disabled' ? '停用' : '启用' });
  } catch { return; }
  try {
    await adminApi.setChannelStatus(channel.id, next);
    await reload(true);
  } catch (e) { showFailToast((e as Error).message); }
}

async function retire(channel: Channel) {
  try {
    await showConfirmDialog({ title: '删除渠道',
      message: `「${channel.name}」将删除：不再出现在用户侧路由里；在途任务继续轮询直到清空，随后自动清除已存凭证。删除后不能恢复，如需再用请重新新增。`,
      confirmButtonText: '删除', confirmButtonColor: dangerToken() });
  } catch { return; }
  try {
    await adminApi.retireChannel(channel.id);
    await reload(true);
    showSuccessToast('已删除');
  } catch (e) { showFailToast((e as Error).message); }
}

async function testChannel(channel: Channel) {
  try {
    await showConfirmDialog({ title: '测试连接',
      message: `对「${channel.name}」发起一次免费连通性测试（拉取模型目录，验证地址与密钥；不产生生成费用）。`,
      confirmButtonText: '开始测试' });
  } catch { return; }
  try {
    const result = await adminApi.testChannel(channel.id);
    const mismatchNote = result.mismatches.length
      ? `；${result.mismatches.length} 个映射模型在目录中不存在（${result.mismatches.map((m) => m.capability).join('、')}）`
      : '';
    showToast(`连接正常：${result.latencyMs}ms，目录 ${result.models.length} 个模型${mismatchNote}`);
  } catch (e) { showFailToast((e as Error).message); }
}

async function trialChannel(channel: Channel) {
  try {
    await showConfirmDialog({ title: '⚠️ 试生成（产生真实费用）',
      message: `将对「${channel.name}」（${KIND_LABEL[channel.kind]}）执行一次最小成本的真实生成以验证端到端可用。\n\n此操作按渠道成本真实计费（如图片约 ¥0.4~0.7、视频按秒计费），并写入管理审计。确定继续吗？`,
      confirmButtonText: '确认试生成', confirmButtonColor: dangerToken() });
  } catch { return; }
  try {
    const result = await adminApi.trialChannel(channel.id, channel.kind);
    if (result.ok) showSuccessToast(result.message); else showToast(result.message);
  } catch (e) { showFailToast((e as Error).message); }
}

// ── 新增 / 编辑表单 ──
const editing = ref(false);
const editingChannel = ref<Channel | null>(null); // null = 新增
const form = reactive({
  kind: 'video' as ChannelKind, driver: '', name: '', baseUrl: '', credential: '', model: '',
  params: {} as Record<string, string | number | boolean>,
  costFen: '', remark: '',
});
const formDriver = computed(() => drivers.value.find((d) => d.id === form.driver));
const driverOptions = computed(() => drivers.value.filter((d) => d.kinds.includes(form.kind)));

function paramType(hint?: string): 'int' | 'float' | 'bool' | 'text' {
  if (!hint) return 'text';
  if (/^int/.test(hint)) return 'int';
  if (/^float/.test(hint)) return 'float';
  if (/^bool/.test(hint)) return 'bool';
  return 'text';
}

function openCreate() {
  editingChannel.value = null;
  Object.assign(form, { kind: kindFilter.value || 'video', driver: '', name: '', baseUrl: '', credential: '',
    model: '', params: {}, costFen: '', remark: '' });
  const first = drivers.value.find((d) => d.kinds.includes(form.kind));
  if (first) selectDriver(first.id);
  editing.value = true;
}

/** 建议 b：bool 参数按说明里的缺省值初始化（如「缺省 true」→ 勾选），避免误读。 */
function defaultParams(schema?: Record<string, string>): Record<string, string | number | boolean> {
  const params: Record<string, string | number | boolean> = {};
  for (const [key, hint] of Object.entries(schema ?? {})) {
    if (/^bool/.test(hint) && /缺省\s*true/.test(hint)) params[key] = true;
  }
  return params;
}

function selectDriver(driverId: string) {
  form.driver = driverId;
  form.params = defaultParams(drivers.value.find((d) => d.id === driverId)?.configSchema.params);
}

function openEdit(channel: Channel) {
  editingChannel.value = channel;
  Object.assign(form, {
    kind: channel.kind,
    driver: channel.driver,
    name: channel.name,
    baseUrl: channel.baseUrl,
    credential: '', // 凭证只写不读：留空表示不修改
    model: channel.modelMap[channel.kind] ?? '',
    params: { ...(channel.params ?? {}) },
    costFen: channel.costFen && Object.keys(channel.costFen).length ? JSON.stringify(channel.costFen) : '',
    remark: channel.remark ?? '',
  });
  editing.value = true;
}

function buildBody() {
  const params: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(form.params)) {
    if (value === '' || value === null || value === undefined) continue;
    const type = paramType(formDriver.value?.configSchema.params?.[key]);
    params[key] = type === 'int' || type === 'float' ? Number(value)
      : type === 'bool' ? value === true || value === 'true'
      : value;
  }
  let costFen: Record<string, number> | undefined;
  if (form.costFen.trim()) {
    try {
      costFen = JSON.parse(form.costFen);
    } catch {
      throw new Error('成本（分）请填 JSON，如 {"video.720p": 151}');
    }
  }
  return {
    name: form.name.trim(), baseUrl: form.baseUrl.trim(),
    ...(form.credential.trim() ? { credential: form.credential.trim() } : {}),
    modelMap: form.model.trim() ? { [form.kind]: form.model.trim() } : {},
    params, ...(costFen ? { costFen } : {}), ...(form.remark.trim() ? { remark: form.remark.trim() } : {}),
  };
}

async function saveForm() {
  if (!form.name.trim() || !form.baseUrl.trim() || !form.driver) { showFailToast('请填写名称、地址并选择驱动'); return; }
  try {
    const body = buildBody();
    if (editingChannel.value) {
      await adminApi.updateChannel(editingChannel.value.id, body);
    } else {
      if (!form.credential.trim()) { showFailToast('新增渠道需要填写密钥'); return; }
      await adminApi.createChannel({ kind: form.kind, driver: form.driver, credential: form.credential.trim(), ...body });
    }
    editing.value = false;
    await reload(true);
    showSuccessToast(editingChannel.value ? '已保存' : '已创建');
  } catch (e) { showFailToast((e as Error).message); }
}
</script>

<template>
  <div class="admin-page">
    <header class="topbar">
      <div class="brand"><span class="logo">▶</span>Mini AI Video · 运营后台</div>
      <nav>
        <span class="nav current">渠道管理</span>
        <span v-if="alertCount" class="dot" :title="`${alertCount} 个渠道异常`">{{ alertCount }}</span>
      </nav>
      <div class="actions">
        <button type="button" class="ghost" :disabled="loading" @click="reload()">{{ loading ? '加载中…' : '重新加载配置' }}</button>
        <button type="button" class="ghost" @click="logout">退出</button>
      </div>
    </header>

    <main>
      <section class="bar miv-card">
        <div class="tabs">
          <button v-for="k in (['', 'video', 'image', 'llm'] as const)" :key="k" type="button"
            :class="{ on: kindFilter === k }" @click="kindFilter = k">
            {{ k === '' ? '全部' : KIND_LABEL[k] }}
          </button>
        </div>
        <label class="check"><input v-model="includeRetired" type="checkbox" /> 显示已删除</label>
        <button type="button" class="primary" @click="openCreate">＋ 新增渠道</button>
      </section>

      <section v-if="kindFilter" class="miv-card routes">
        <div class="section-head">
          <div class="miv-section-title">{{ KIND_LABEL[routeKind] }}路由顺序</div>
          <span class="miv-hint">生成请求按此顺序选择渠道；第一个可用的是主用。排序只在本页暂存，点保存后生效。</span>
          <button type="button" class="primary small" :disabled="!routeDirty" @click="saveRoutes">保存排序</button>
        </div>
        <ol v-if="routeChannels.length" class="route-list">
          <li v-for="(row, index) in routeChannels" :key="row.id"
            :class="{ primary: index === 0, disabled: row.status !== 'active' }">
            <span class="rank">{{ index === 0 ? '主用' : `#${index + 1}` }}</span>
            <span class="name">{{ row.name }}</span>
            <span class="driver miv-hint">{{ row.driver }}</span>
            <span v-if="row.status !== 'active'" class="miv-hint">（{{ STATUS_LABEL[row.status] }}）</span>
            <span class="ops">
              <button type="button" :disabled="index === 0" @click="moveRoute(index, -1)">↑</button>
              <button type="button" :disabled="index === routeChannels.length - 1" @click="moveRoute(index, 1)">↓</button>
              <button type="button" :disabled="index === 0" @click="makePrimary(index)">设为主用</button>
              <button type="button" class="danger" @click="removeFromRoute(index)">移出</button>
            </span>
          </li>
        </ol>
        <p v-else class="miv-hint">该类型暂无路由渠道——从下方候选加入，或保存后由渠道列表加入。</p>
        <div v-if="joinable.length" class="joinable">
          <span class="miv-hint">未加入路由（同类型 · 启用中）：</span>
          <span v-for="channel in joinable" :key="channel.id" class="join-item">
            {{ channel.name }} <code>{{ channel.driver }}</code>
            <button type="button" @click="joinRoute(channel.id)">加入路由</button>
          </span>
        </div>
      </section>

      <section class="miv-card table-wrap">
        <table class="channels">
          <thead>
            <tr>
              <th>名称</th><th>类型</th><th>驱动</th><th>地址</th><th>凭证</th><th>模型</th>
              <th>状态</th><th>健康（近 1 小时）</th><th>在途</th><th class="ops-col">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="channel in shown" :key="channel.id" :class="{ retired: channel.status === 'retired' }">
              <td>
                <span class="alert-dot" :class="healthOf(channel).tone" :title="healthOf(channel).text" />
                {{ channel.name }}
                <div v-if="channel.remark" class="miv-hint remark">{{ channel.remark }}</div>
              </td>
              <td>{{ KIND_LABEL[channel.kind] }}</td>
              <td><code>{{ channel.driver }}</code></td>
              <td class="url">{{ channel.baseUrl }}</td>
              <td><code>{{ channel.credentialMask }}</code></td>
              <td><code>{{ channel.modelMap[channel.kind] || '—' }}</code>
                <div v-if="channel.costVsPrice?.length" class="miv-hint">
                  成本 {{ channel.costVsPrice.map((c) => `${c.capability.split('.').pop()}:¥${(c.costFen ?? 0) / 100}`).join(' ') }}
                </div>
              </td>
              <td><span class="tag" :class="channel.status">{{ STATUS_LABEL[channel.status] }}</span></td>
              <td :class="`health-${healthOf(channel).tone}`">{{ healthOf(channel).text }}</td>
              <td>{{ channel.inFlight }}</td>
              <td class="ops">
                <template v-if="channel.status !== 'retired'">
                  <button type="button" @click="openEdit(channel)">编辑</button>
                  <button type="button" @click="testChannel(channel)">测试连接</button>
                  <button type="button" class="danger" @click="trialChannel(channel)">试生成</button>
                  <button type="button" @click="toggleStatus(channel)">{{ channel.status === 'active' ? '停用' : '启用' }}</button>
                  <button type="button" class="danger" @click="retire(channel)">删除</button>
                </template>
                <span v-else class="miv-hint">已删除（不能恢复）</span>
              </td>
            </tr>
          </tbody>
        </table>
        <p v-if="!shown.length" class="miv-hint empty">暂无渠道，点右上「新增渠道」创建第一个。</p>
      </section>
    </main>

    <Teleport to="body">
      <div v-if="editing" class="mask" @click.self="editing = false">
        <form class="dialog miv-card" @submit.prevent="saveForm">
          <h2>{{ editingChannel ? '编辑渠道' : '新增渠道' }}</h2>
          <p class="miv-hint">密钥只在保存时提交一次，之后界面永远只显示掩码。</p>
          <div class="grid">
            <label>
              <span>类型</span>
              <select v-model="form.kind" :disabled="!!editingChannel" @change="selectDriver('')">
                <option value="video">视频</option><option value="image">图片</option><option value="llm">文本</option>
              </select>
            </label>
            <label>
              <span>协议驱动</span>
              <select v-model="form.driver" :disabled="!!editingChannel">
                <option value="" disabled>选择驱动</option>
                <option v-for="d in driverOptions" :key="d.id" :value="d.id">{{ d.id }}</option>
              </select>
            </label>
            <label><span>名称</span><input v-model="form.name" placeholder="1~40 字符、不含空格，如 aiide" /></label>
            <label>
              <span>接口地址</span>
              <input v-model="form.baseUrl" :placeholder="formDriver?.configSchema.baseUrl?.replace(/^url（?/, '').replace(/）?$/, '') || 'https://…'" />
            </label>
            <label>
              <span>密钥（凭证）</span>
              <input v-model="form.credential" type="password" autocomplete="off"
                :placeholder="editingChannel ? '不修改请留空' : 'secret'" />
            </label>
            <label><span>{{ KIND_LABEL[form.kind] }}模型名</span><input v-model="form.model" placeholder="映射到渠道的模型" /></label>
          </div>
          <div v-if="formDriver?.configSchema.params && Object.keys(formDriver.configSchema.params).length" class="params">
            <div class="miv-section-title">驱动参数</div>
            <div class="grid">
              <label v-for="(hint, key) in formDriver.configSchema.params" :key="key">
                <span>{{ key }}</span>
                <input v-if="paramType(hint) === 'bool'" v-model="form.params[key] as boolean" type="checkbox" class="inline-check" />
                <input v-else v-model="form.params[key] as string | number"
                  :type="paramType(hint) === 'int' || paramType(hint) === 'float' ? 'number' : 'text'"
                  :step="paramType(hint) === 'float' ? '0.01' : undefined" :placeholder="hint" />
                <em class="miv-hint">{{ hint }}</em>
              </label>
            </div>
          </div>
          <label class="full">
            <span>成本（分，可选 JSON）</span>
            <input v-model="form.costFen" placeholder='{"video.720p": 151, "image.look": 36}' />
          </label>
          <label class="full"><span>备注</span><input v-model="form.remark" placeholder="用途、来源等" /></label>
          <div class="foot">
            <button type="button" class="ghost" @click="editing = false">取消</button>
            <button type="submit" class="primary">{{ editingChannel ? '保存' : '创建' }}</button>
          </div>
        </form>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.admin-page { min-height: 100vh; background: var(--miv-bg); }
.topbar { position: sticky; top: 0; z-index: 10; display: flex; align-items: center; gap: var(--miv-space-4);
  padding: 0 var(--miv-space-4); height: 56px; background: var(--miv-surface); border-bottom: 1px solid var(--miv-border); }
.brand { font-weight: 700; display: flex; align-items: center; gap: 8px; }
.logo { color: var(--miv-primary); }
nav { display: flex; align-items: center; gap: var(--miv-space-3); flex: 1; }
.nav { color: var(--miv-text-2); font-size: 14px; }
.nav.current { color: var(--miv-text); font-weight: 600; }
.dot { background: var(--miv-danger); color: var(--miv-on-primary); border-radius: 999px; min-width: 20px; height: 20px;
  display: inline-flex; align-items: center; justify-content: center; font-size: 12px; padding: 0 6px; }
.actions { display: flex; gap: var(--miv-space-2); }
main { max-width: 1200px; margin: 0 auto; padding: var(--miv-space-4); display: flex; flex-direction: column; gap: var(--miv-space-3); }
.bar { display: flex; align-items: center; gap: var(--miv-space-3); padding: var(--miv-space-3); }
.tabs { display: flex; gap: var(--miv-space-1); flex: 1; }
.tabs button { border: 1px solid var(--miv-border); background: var(--miv-surface); border-radius: 999px;
  padding: 6px 16px; font: inherit; font-size: 14px; cursor: pointer; color: var(--miv-text-2); }
.tabs button.on { border-color: var(--miv-primary); color: var(--miv-primary-strong); background: var(--miv-primary-soft); }
.check { display: inline-flex; flex-direction: row; align-items: center; gap: 6px; font-size: 13px;
  color: var(--miv-text-2); white-space: nowrap; }
.joinable { display: flex; flex-wrap: wrap; align-items: center; gap: var(--miv-space-2); margin-top: var(--miv-space-2);
  padding-top: var(--miv-space-2); border-top: 1px dashed var(--miv-border); }
.join-item { display: inline-flex; align-items: center; gap: 6px; font-size: 13px;
  padding: 4px 10px; border: 1px solid var(--miv-border); border-radius: 999px; }
.join-item button { border: 0; background: transparent; color: var(--miv-primary); font: inherit; font-size: 13px; cursor: pointer; }
button.primary { background: var(--miv-primary); color: var(--miv-on-primary); border: 0; border-radius: var(--miv-radius-sm);
  padding: 8px 16px; font: inherit; cursor: pointer; }
button.primary.small { padding: 5px 12px; font-size: 13px; }
button.primary:disabled { opacity: 0.5; cursor: default; }
button.ghost { background: var(--miv-bg); color: var(--miv-text-2); border: 1px solid var(--miv-border); border-radius: var(--miv-radius-sm); padding: 8px 16px; font: inherit; cursor: pointer; }
.section-head { display: flex; align-items: baseline; gap: var(--miv-space-3); }
.section-head .miv-hint { flex: 1; }
.route-list { list-style: none; margin: var(--miv-space-2) 0 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.route-list li { display: flex; align-items: center; gap: var(--miv-space-2); padding: 8px 12px;
  border: 1px solid var(--miv-border); border-radius: var(--miv-radius-md); }
.route-list li.primary { border-color: var(--miv-primary); background: var(--miv-primary-soft); }
.route-list li.disabled { opacity: 0.6; }
.rank { font-size: 12px; color: var(--miv-primary-strong); min-width: 34px; font-weight: 600; }
.route-list .name { font-weight: 600; }
.route-list .driver { font-size: 12px; }
.route-list .ops { margin-left: auto; display: flex; gap: 6px; }
.route-list .ops button { border: 1px solid var(--miv-border); background: var(--miv-surface); border-radius: 6px;
  padding: 2px 10px; font: inherit; font-size: 13px; cursor: pointer; }
.route-list .ops button:disabled { opacity: 0.35; cursor: default; }
.table-wrap { overflow-x: auto; padding: var(--miv-space-2) var(--miv-space-3) var(--miv-space-3); }
table.channels { width: 100%; border-collapse: collapse; font-size: 13px; }
th { text-align: left; font-weight: 600; color: var(--miv-text-2); padding: 10px 10px; border-bottom: 1px solid var(--miv-border); white-space: nowrap; }
td { padding: 10px; border-bottom: 1px solid var(--miv-border); vertical-align: top; }
tr.retired td { opacity: 0.55; }
.url { max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
code { font-family: ui-monospace, monospace; font-size: 12px; background: var(--miv-bg); padding: 1px 5px; border-radius: 4px; }
.remark { max-width: 180px; white-space: normal; }
.tag { display: inline-block; border-radius: 999px; padding: 2px 10px; font-size: 12px; }
.tag.active { background: var(--miv-success-soft); color: var(--miv-success-strong); }
.tag.disabled { background: var(--miv-bg); color: var(--miv-text-3); }
.tag.retired { background: var(--miv-bg); color: var(--miv-text-3); text-decoration: line-through; }
.health-ok { color: var(--miv-success); } .health-warn { color: var(--miv-warning); }
.health-bad { color: var(--miv-danger); font-weight: 600; } .health-none { color: var(--miv-text-3); }
.alert-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; }
.alert-dot.ok, .alert-dot.none { background: transparent; }
.alert-dot.warn { background: var(--miv-warning); }
.alert-dot.bad { background: var(--miv-danger); box-shadow: 0 0 0 3px var(--miv-danger-soft); }
td.ops { white-space: nowrap; }
td.ops button { border: 1px solid var(--miv-border); background: var(--miv-surface); border-radius: 6px;
  padding: 3px 10px; font: inherit; font-size: 12px; cursor: pointer; margin: 2px 2px; }
td.ops button:hover { border-color: var(--miv-primary); color: var(--miv-primary-strong); }
td.ops button.danger { color: var(--miv-danger); }
th:nth-child(7), td:nth-child(7) { white-space: nowrap; } /* 状态列 */
.empty { padding: var(--miv-space-4); text-align: center; }
.mask { position: fixed; inset: 0; background: var(--miv-overlay); display: flex; align-items: center; justify-content: center;
  z-index: 100; padding: var(--miv-space-4); overflow: auto; }
.dialog { width: min(640px, 100%); max-height: 90vh; overflow: auto; display: flex; flex-direction: column; gap: var(--miv-space-3); }
.dialog h2 { font-size: 16px; margin: 0; }
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: var(--miv-space-3); }
label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--miv-text-2); }
label.full { width: 100%; }
label input:not([type='checkbox']), label select { border: 1px solid var(--miv-border); border-radius: 6px;
  padding: 8px 10px; font: inherit; font-size: 14px; background: var(--miv-surface); color: var(--miv-text); }
label .inline-check { width: 18px; height: 18px; align-self: flex-start; }
label em { font-style: normal; font-size: 11px; }
.params .miv-section-title { margin-bottom: var(--miv-space-2); }
.foot { display: flex; justify-content: flex-end; gap: var(--miv-space-2); }
.foot button { border-radius: 6px; padding: 8px 20px; font: inherit; cursor: pointer; }
@media (max-width: 767px) {
  .grid { grid-template-columns: 1fr; }
  .topbar { padding: 0 var(--miv-space-3); }
  main { padding: var(--miv-space-3); }
}
</style>
