<script setup lang="ts">
// 价格与配置页（M3-ADM-04，API.md §8.4）：SKU 调价（新增版本不覆盖历史，已确认作品按锁定价
// 不受影响）、档位与映射版本、风格/音色管理（下架不删除，封面/音频经管理端上传）、
// 运营参数白名单编辑（类型与上下限校验）。全部写操作二次确认 + 审计留痕。
// 注意：SKU 调价只影响新报价——作品确认时已锁定单价，渲染中/重试中不受调价影响。
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { showConfirmDialog, showFailToast, showSuccessToast, showToast } from 'vant';
import { adminApi, useMock } from '@/api';
import type { AdminSettingItem, AdminSku, AdminStyle, AdminTier, AdminVoice } from '@/api/admin';
import { newIdempotencyKey } from '@/utils/idempotency';
import AdminShell from './AdminShell.vue';

const route = useRoute();
const router = useRouter();

const CATEGORY_LABEL: Record<string, string> = {
  girl: '少女', boy: '少年', child_f: '儿童女', child_m: '儿童男', young_f: '青年女',
  young_m: '青年男', middle_f: '中年女', middle_m: '中年男', elder_f: '老人女', elder_m: '老人男',
};
const GENDER_LABEL: Record<string, string> = { female: '女', male: '男' };
const AGE_LABEL: Record<string, string> = { child: '儿童', teen: '少年', young: '青年', middle: '中年', elder: '老年' };
const KIND_LABEL: Record<string, string> = { video: '视频', image: '图片', llm: '文本' };
const UNIT_LABEL: Record<string, string> = { second: '每秒', image: '每张', ktoken: '每千 token' };

const loading = ref(false);
const skus = ref<AdminSku[]>([]);
const tiers = ref<AdminTier[]>([]);
const styles = ref<AdminStyle[]>([]);
const voices = ref<AdminVoice[]>([]);
const settings = ref<AdminSettingItem[]>([]);

const yuan = (fen: number) => `¥${(fen / 100).toFixed(2)}`;
const fenInput = (fen: number) => (fen / 100).toFixed(2);
const fmtTime = (iso: string | null) => (iso ? iso.replace('T', ' ').slice(0, 16) : '—');
const percent = (rate: number | null) => (rate === null ? '—' : `${Math.round(rate * 1000) / 10}%`);
const UNIT_SUFFIX: Record<string, string> = { second: '秒', image: '张', ktoken: '千 token' };
/** 元输入 → 整数分（最多两位小数）；非法返回 null。 */
function parseYuanToFen(input: string): number | null {
  const text = input.trim();
  if (!/^(0|[1-9]\d*)(\.\d{1,2})?$/.test(text)) return null;
  return Math.round(Number(text) * 100);
}

/** 执行写操作；返回是否成功——只有成功才允许关窗/提示成功（复审必改①，
 * 此前吞异常导致失败仍提示「已保存」）。失败时弹窗与已填内容原样保留，幂等键沿用可重试。 */
async function run(action: () => Promise<void>): Promise<boolean> {
  loading.value = true;
  try {
    await action();
    return true;
  } catch (e) {
    const status = (e as { status?: number }).status;
    const code = (e as { code?: string }).code;
    if (status === 401 || code === 'ADMIN_AUTH_REQUIRED' || code === 'CSRF_INVALID') {
      router.replace({ path: '/admin/login', query: { redirect: route.fullPath } });
      return false;
    }
    showFailToast((e as Error).message);
    return false;
  } finally { loading.value = false; }
}

async function loadAll() {
  await run(async () => {
    const [skuPage, tierPage, stylePage, voicePage, settingPage] = await Promise.all([
      adminApi.skus(), adminApi.tiers(), adminApi.styles(), adminApi.voices(), adminApi.settings(),
    ]);
    skus.value = skuPage.items;
    tiers.value = tierPage.items;
    styles.value = stylePage.items;
    voices.value = voicePage.items;
    settings.value = settingPage.items;
  });
}
onMounted(loadAll);

// ── SKU 调价 ──
const skuDialog = ref(false);
const skuTarget = ref<AdminSku | null>(null);
const skuForm = ref({ priceInput: '', costInput: '', effectiveAt: '' });
const skuIdem = ref('');

function openSkuDialog(sku: AdminSku) {
  skuTarget.value = sku;
  skuForm.value = { priceInput: fenInput(sku.priceFen), costInput: fenInput(sku.costFen), effectiveAt: '' };
  skuIdem.value = newIdempotencyKey(); // 打开表单时生成，失败重试沿用，成功后重建
  skuDialog.value = true;
}

async function submitSku() {
  const target = skuTarget.value;
  if (!target) return;
  const priceFen = parseYuanToFen(skuForm.value.priceInput);
  if (priceFen === null || priceFen < 0) { showFailToast('价格需为不小于 0 的金额（最多两位小数）'); return; }
  if (priceFen > 10_000) { showFailToast('价格不能超过 ¥100（与后端上限一致，防误输入）'); return; }
  const costFen = skuForm.value.costInput.trim() === '' ? undefined : parseYuanToFen(skuForm.value.costInput);
  if (costFen === null) { showFailToast('成本需为金额（最多两位小数），留空表示不变'); return; }
  const effectiveAt = skuForm.value.effectiveAt ? new Date(skuForm.value.effectiveAt).toISOString() : undefined;
  // 先二次确认，再写入（失败沿用同一幂等键，可重试）
  const ok = await showConfirmDialog({
    title: '确认调价',
    message: `${target.skuCode}：${yuan(target.priceFen)} → ${yuan(priceFen)}（每${UNIT_SUFFIX[target.unit]}）\n`
      + `${effectiveAt ? `将于 ${fmtTime(effectiveAt)} 起生效` : '立即生效'}；已确认的作品按锁定单价结算，不受影响。`,
  }).then(() => true).catch(() => false);
  if (!ok) return;
  const saved = await run(async () => {
    await adminApi.createSkuVersion(target.skuCode, {
      priceFen, ...(costFen !== undefined ? { costFen } : {}),
      ...(effectiveAt ? { effectiveAt } : {}), idempotencyKey: skuIdem.value,
    });
  });
  if (!saved) return; // 失败：弹窗与已填内容保留，幂等键沿用重试
  skuDialog.value = false;
  showSuccessToast('已保存新价格版本');
  await loadAll();
}

// ── 档位 ──
const tierDialog = ref(false);
const tierTarget = ref<AdminTier | null>(null);
const tierForm = ref({ name: '', note: '', sort: 0, status: 'active' as 'active' | 'inactive' });

function openTierDialog(tier: AdminTier) {
  tierTarget.value = tier;
  tierForm.value = { name: tier.name, note: tier.note, sort: tier.sort, status: tier.status };
  tierDialog.value = true;
}

async function submitTier() {
  const target = tierTarget.value;
  if (!target) return;
  if (!tierForm.value.name.trim()) { showFailToast('档位名称必填'); return; }
  const saved = await run(async () => {
    await adminApi.updateTier(target.id, {
      name: tierForm.value.name.trim(), note: tierForm.value.note.trim(),
      sort: tierForm.value.sort, status: tierForm.value.status,
    });
  });
  if (!saved) return;
  showSuccessToast('档位已更新');
  tierDialog.value = false;
  await loadAll();
}

const mappingDialog = ref(false);
const mappingTier = ref<AdminTier | null>(null);
const mappingSkuCode = ref('');

async function submitMapping() {
  const tier = mappingTier.value;
  if (!tier) return;
  if (!mappingSkuCode.value) { showFailToast('请选择要映射到的视频 SKU'); return; }
  const ok = await showConfirmDialog({
    title: '确认换映射',
    message: `${tier.name}：${mappingTier.value?.currentMapping?.videoSkuCode ?? '未配置'} → ${mappingSkuCode.value}\n新增一版映射，只影响之后新创建的作品。`,
  }).then(() => true).catch(() => false);
  if (!ok) return;
  const saved = await run(async () => {
    await adminApi.createTierMapping(tier.id, mappingSkuCode.value);
  });
  if (!saved) return;
  showSuccessToast('已新增映射版本');
  mappingDialog.value = false;
  await loadAll();
}

// ── 风格 ──
const styleDialog = ref(false);
const styleTarget = ref<AdminStyle | null>(null); // null = 新增
const styleForm = ref({ name: '', description: '', promptHint: '', sort: 0, coverUploadId: '' });
const styleUploading = ref(false);

function openStyleDialog(style: AdminStyle | null) {
  styleTarget.value = style;
  styleForm.value = style
    ? { name: style.name, description: style.description, promptHint: style.promptHint, sort: style.sort, coverUploadId: style.coverUploadId ?? '' }
    : { name: '', description: '', promptHint: '', sort: (styles.value.length + 1) * 10, coverUploadId: '' };
  styleDialog.value = true;
}

async function onCoverPick(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0];
  (event.target as HTMLInputElement).value = ''; // 允许重复选同一文件
  if (!file) return;
  await run(async () => {
    styleUploading.value = true;
    try {
      const { uploadId } = await adminApi.upload(file);
      styleForm.value.coverUploadId = uploadId;
    } finally { styleUploading.value = false; }
  });
}

async function submitStyle() {
  if (!styleForm.value.name.trim()) { showFailToast('风格名称必填'); return; }
  const saved = await run(async () => {
    const body = {
      name: styleForm.value.name.trim(), description: styleForm.value.description.trim(),
      promptHint: styleForm.value.promptHint.trim(), sort: styleForm.value.sort,
      ...(styleForm.value.coverUploadId ? { coverUploadId: styleForm.value.coverUploadId } : { coverUploadId: null }),
    };
    if (styleTarget.value) await adminApi.updateStyle(styleTarget.value.id, body);
    else await adminApi.createStyle(body);
  });
  if (!saved) return;
  showSuccessToast(styleTarget.value ? '风格已更新' : '风格已新增');
  styleDialog.value = false;
  await loadAll();
}

async function toggleStyle(style: AdminStyle) {
  const next = style.status === 'active' ? 'inactive' : 'active';
  const tip = next === 'inactive'
    ? `下架后新作品不能选「${style.name}」，已有作品不受影响。`
    : `重新上架「${style.name}」？`;
  const ok = await showConfirmDialog({ title: next === 'inactive' ? '下架风格' : '上架风格', message: tip }).then(() => true).catch(() => false);
  if (!ok) return;
  const saved = await run(async () => { await adminApi.updateStyle(style.id, { status: next }); });
  if (!saved) return;
  showSuccessToast(next === 'inactive' ? '已下架' : '已上架');
  await loadAll();
}

// ── 音色 ──
const voiceDialog = ref(false);
const voiceTarget = ref<AdminVoice | null>(null); // null = 新增
const voiceForm = ref({ name: '', category: 'young_f', gender: 'female', ageGroup: 'young',
  description: '', sort: 0, sampleUploadId: '', refAudioUploadId: '' });
const voiceUploading = ref(false);

function openVoiceDialog(voice: AdminVoice | null) {
  voiceTarget.value = voice;
  voiceForm.value = voice
    ? { name: voice.name, category: voice.category, gender: voice.gender, ageGroup: voice.ageGroup,
        description: voice.description, sort: voice.sort,
        sampleUploadId: voice.sampleUploadId ?? '', refAudioUploadId: voice.refAudioUploadId ?? '' }
    : { name: '', category: 'young_f', gender: 'female', ageGroup: 'young', description: '',
        sort: (voices.value.length + 1) * 10, sampleUploadId: '', refAudioUploadId: '' };
  voiceDialog.value = true;
}

async function onVoicePick(event: Event, field: 'sampleUploadId' | 'refAudioUploadId') {
  const file = (event.target as HTMLInputElement).files?.[0];
  (event.target as HTMLInputElement).value = '';
  if (!file) return;
  await run(async () => {
    voiceUploading.value = true;
    try {
      const { uploadId } = await adminApi.upload(file);
      voiceForm.value[field] = uploadId;
    } finally { voiceUploading.value = false; }
  });
}

async function submitVoice() {
  if (!voiceForm.value.name.trim()) { showFailToast('音色名称必填'); return; }
  const saved = await run(async () => {
    const body = {
      name: voiceForm.value.name.trim(), category: voiceForm.value.category, gender: voiceForm.value.gender,
      ageGroup: voiceForm.value.ageGroup, description: voiceForm.value.description.trim(), sort: voiceForm.value.sort,
      ...(voiceForm.value.sampleUploadId ? { sampleUploadId: voiceForm.value.sampleUploadId } : { sampleUploadId: null }),
      ...(voiceForm.value.refAudioUploadId ? { refAudioUploadId: voiceForm.value.refAudioUploadId } : { refAudioUploadId: null }),
    };
    if (voiceTarget.value) await adminApi.updateVoice(voiceTarget.value.id, body);
    else await adminApi.createVoice(body);
  });
  if (!saved) return;
  showSuccessToast(voiceTarget.value ? '音色已更新' : '音色已新增');
  voiceDialog.value = false;
  await loadAll();
}

async function toggleVoice(voice: AdminVoice) {
  const next = voice.status === 'active' ? 'inactive' : 'active';
  const ok = await showConfirmDialog({
    title: next === 'inactive' ? '下架音色' : '上架音色',
    message: next === 'inactive' ? `下架后新作品不能选「${voice.name}」，已有作品不受影响。` : `重新上架「${voice.name}」？`,
  }).then(() => true).catch(() => false);
  if (!ok) return;
  const saved = await run(async () => { await adminApi.updateVoice(voice.id, { status: next }); });
  if (!saved) return;
  showSuccessToast(next === 'inactive' ? '已下架' : '已上架');
  await loadAll();
}

// ── 运营参数 ──
const draftSettings = ref<Record<string, string>>({});
const settingDraft = computed(() => {
  const draft: Record<string, string> = {};
  for (const item of settings.value) draft[item.key] = String(item.value ?? '');
  return draft;
});

const settingChanges = computed(() => {
  const changes: Record<string, number> = {};
  for (const item of settings.value) {
    const raw = draftSettings.value[item.key];
    if (raw === undefined || raw === String(item.value ?? '')) continue;
    if (!/^-?\d+$/.test(raw.trim())) continue;
    const value = Number(raw.trim());
    if (value >= item.min && value <= item.max && value !== item.value) changes[item.key] = value;
  }
  return changes;
});

function markDraft() {
  // 首次编辑前以当前值为准（draftSettings 初始化成 settingDraft 快照）
  if (Object.keys(draftSettings.value).length === 0) draftSettings.value = { ...settingDraft.value };
}

async function submitSettings() {
  markDraft();
  const keys = Object.keys(settingChanges.value);
  if (!keys.length) { showToast?.('没有修改'); return; }
  const lines = keys.map((key) => {
    const item = settings.value.find((row) => row.key === key)!;
    return `${item.label}：${item.value} → ${settingChanges.value[key]}`;
  });
  const ok = await showConfirmDialog({ title: '保存运营参数', message: `${lines.join('\n')}` }).then(() => true).catch(() => false);
  if (!ok) return;
  const saved = await run(async () => {
    const { items } = await adminApi.updateSettings(settingChanges.value);
    settings.value = items;
    draftSettings.value = {};
  });
  if (!saved) return; // 失败：draftSettings 不清空，已填的修改保留可重试
  showSuccessToast('运营参数已保存');
}
</script>

<template>
  <AdminShell>
    <!-- SKU 价格 -->
    <section class="miv-card table-wrap">
      <h2 class="sec-title">SKU 价格 <span class="sec-hint">调价=新增版本（不覆盖历史）；已出报价在有效期内需重新取价，已确认作品按锁定单价结算</span></h2>
      <table>
        <thead>
          <tr><th>SKU</th><th>类型</th><th>计价</th><th class="num">用户价</th><th class="num">成本</th>
            <th class="num">毛利率</th><th>版本</th><th>生效时间</th><th class="ops-col">操作</th></tr>
        </thead>
        <tbody>
          <tr v-for="sku in skus" :key="sku.skuCode">
            <td><code>{{ sku.skuCode }}</code><span v-if="sku.version < sku.versions" class="tag retired">另有历史/未生效版本 {{ sku.versions - 1 }} 个</span></td>
            <td>{{ KIND_LABEL[sku.kind] }}</td>
            <td>{{ UNIT_LABEL[sku.unit] }}</td>
            <td class="num strong">{{ yuan(sku.priceFen) }}</td>
            <td class="num">{{ yuan(sku.costFen) }}</td>
            <td class="num">{{ percent(sku.marginRate) }}</td>
            <td>v{{ sku.version }}<span class="muted"> / 共 {{ sku.versions }} 版</span></td>
            <td>{{ fmtTime(sku.effectiveAt) }}</td>
            <td class="ops"><button type="button" @click="openSkuDialog(sku)">调价</button></td>
          </tr>
        </tbody>
      </table>
    </section>

    <!-- 档位与映射 -->
    <section class="miv-card table-wrap">
      <h2 class="sec-title">画质档位 <span class="sec-hint">下架后新作品不能再选该档位；映射只影响新作品，已创建作品仍用创建时锁定的映射</span></h2>
      <table>
        <thead>
          <tr><th>档位</th><th>备注</th><th class="num">排序</th><th>状态</th><th>当前映射</th><th class="num">单价</th><th class="ops-col">操作</th></tr>
        </thead>
        <tbody>
          <tr v-for="tier in tiers" :key="tier.id">
            <td>{{ tier.name }}</td>
            <td>{{ tier.note || '—' }}</td>
            <td class="num">{{ tier.sort }}</td>
            <td><span class="tag" :class="tier.status">{{ tier.status === 'active' ? '上架' : '已下架' }}</span></td>
            <td>
              <template v-if="tier.currentMapping"><code>{{ tier.currentMapping.videoSkuCode }}</code>（v{{ tier.currentMapping.version }}）</template>
              <span v-else class="muted">未配置</span>
            </td>
            <td class="num">{{ tier.currentMapping?.priceFen != null ? `${yuan(tier.currentMapping.priceFen)}/秒` : '—' }}</td>
            <td class="ops">
              <button type="button" @click="openTierDialog(tier)">编辑</button>
              <button type="button" @click="() => { mappingTier = tier; mappingSkuCode = tier.currentMapping?.videoSkuCode ?? ''; mappingDialog = true; }">换映射</button>
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <!-- 风格 -->
    <section class="miv-card table-wrap">
      <h2 class="sec-title">风格 <span class="sec-hint">下架不删除：新作品不能选，已有作品不受影响</span></h2>
      <table>
        <thead>
          <tr><th>名称</th><th>描述</th><th class="num">排序</th><th>状态</th><th>封面</th><th class="ops-col">操作</th></tr>
        </thead>
        <tbody>
          <tr v-for="style in styles" :key="style.id">
            <td>{{ style.name }}</td>
            <td class="wrap">{{ style.description || '—' }}</td>
            <td class="num">{{ style.sort }}</td>
            <td><span class="tag" :class="style.status">{{ style.status === 'active' ? '上架' : '已下架' }}</span></td>
            <td>{{ style.coverUploadId ? '已设置' : '—' }}</td>
            <td class="ops">
              <button type="button" @click="openStyleDialog(style)">编辑</button>
              <button type="button" :class="{ danger: style.status === 'active' }" @click="toggleStyle(style)">
                {{ style.status === 'active' ? '下架' : '上架' }}</button>
            </td>
          </tr>
        </tbody>
      </table>
      <div class="sec-actions"><button type="button" class="primary small" @click="openStyleDialog(null)">新增风格</button></div>
    </section>

    <!-- 音色 -->
    <section class="miv-card table-wrap">
      <h2 class="sec-title">音色 <span class="sec-hint">试听 / 参考音频经管理端上传（mp3/wav/m4a ≤5MB）；下架不删除</span></h2>
      <table>
        <thead>
          <tr><th>名称</th><th>分类</th><th>性别</th><th>年龄段</th><th>描述</th><th>试听</th><th>参考音频</th><th>状态</th><th class="ops-col">操作</th></tr>
        </thead>
        <tbody>
          <tr v-for="voice in voices" :key="voice.id">
            <td>{{ voice.name }}</td>
            <td>{{ CATEGORY_LABEL[voice.category] ?? voice.category }}</td>
            <td>{{ GENDER_LABEL[voice.gender] ?? voice.gender }}</td>
            <td>{{ AGE_LABEL[voice.ageGroup] ?? voice.ageGroup }}</td>
            <td class="wrap">{{ voice.description || '—' }}</td>
            <td>{{ voice.sampleUploadId ? '已上传' : '—' }}</td>
            <td>{{ voice.refAudioUploadId ? '已上传' : '—' }}</td>
            <td><span class="tag" :class="voice.status">{{ voice.status === 'active' ? '上架' : '已下架' }}</span></td>
            <td class="ops">
              <button type="button" @click="openVoiceDialog(voice)">编辑</button>
              <button type="button" :class="{ danger: voice.status === 'active' }" @click="toggleVoice(voice)">
                {{ voice.status === 'active' ? '下架' : '上架' }}</button>
            </td>
          </tr>
        </tbody>
      </table>
      <div class="sec-actions"><button type="button" class="primary small" @click="openVoiceDialog(null)">新增音色</button></div>
    </section>

    <!-- 运营参数 -->
    <section class="miv-card table-wrap">
      <h2 class="sec-title">运营参数 <span class="sec-hint">白名单项（整数，带上下限）；修改会记入审计日志</span></h2>
      <div class="settings-grid">
        <label v-for="item in settings" :key="item.key">
          {{ item.label }}
          <input type="number" :min="item.min" :max="item.max"
            :value="draftSettings[item.key] ?? settingDraft[item.key]" @input="markDraft(); draftSettings[item.key] = ($event.target as HTMLInputElement).value" />
          <span class="muted">范围 {{ item.min }}~{{ item.max }}</span>
        </label>
      </div>
      <div class="sec-actions">
        <button type="button" class="primary small" :disabled="loading || Object.keys(settingChanges).length === 0"
          @click="submitSettings">保存修改{{ Object.keys(settingChanges).length ? `（${Object.keys(settingChanges).length} 项）` : '' }}</button>
        <span v-if="useMock" class="muted">演示模式：数据存在浏览器里，刷新即重置</span>
      </div>
    </section>

    <!-- SKU 调价弹窗 -->
    <Teleport to="body">
      <div v-if="skuDialog && skuTarget" class="mask" @click.self="skuDialog = false">
        <div class="dialog miv-card">
          <h2>调价：{{ skuTarget.skuCode }}</h2>
          <p class="muted">当前 {{ yuan(skuTarget.priceFen) }}/{{ UNIT_LABEL[skuTarget.unit] === '每秒' ? '秒' : skuTarget.unit === 'image' ? '张' : '千 token' }}（v{{ skuTarget.version }}）。保存即新增版本，旧版本保留历史。</p>
          <div class="grid">
            <label>新用户价（元）
              <input v-model="skuForm.priceInput" inputmode="decimal" placeholder="如 1.20" />
            </label>
            <label>渠道成本（元，留空不变）
              <input v-model="skuForm.costInput" inputmode="decimal" placeholder="如 0.68" />
            </label>
            <label class="full">生效时间（留空=立即生效）
              <input v-model="skuForm.effectiveAt" type="datetime-local" />
            </label>
          </div>
          <p class="muted">已确认（制作中/已交付）的作品按确认时锁定的单价结算，调价不影响它们的金额。</p>
          <div class="foot">
            <button type="button" class="ghost" @click="skuDialog = false">取消</button>
            <button type="button" class="primary" :disabled="loading" @click="submitSku">保存并确认</button>
          </div>
        </div>
      </div>

      <!-- 档位编辑弹窗 -->
      <div v-if="tierDialog && tierTarget" class="mask" @click.self="tierDialog = false">
        <div class="dialog miv-card">
          <h2>编辑档位：{{ tierTarget.id }}</h2>
          <div class="grid">
            <label>名称<input v-model="tierForm.name" /></label>
            <label>排序<input v-model.number="tierForm.sort" type="number" min="0" /></label>
            <label class="full">备注<input v-model="tierForm.note" /></label>
            <label>状态
              <select v-model="tierForm.status">
                <option value="active">上架</option>
                <option value="inactive">下架（新作品不可选）</option>
              </select>
            </label>
          </div>
          <div class="foot">
            <button type="button" class="ghost" @click="tierDialog = false">取消</button>
            <button type="button" class="primary" :disabled="loading" @click="submitTier">保存</button>
          </div>
        </div>
      </div>

      <!-- 换映射弹窗 -->
      <div v-if="mappingDialog && mappingTier" class="mask" @click.self="mappingDialog = false">
        <div class="dialog miv-card">
          <h2>换映射：{{ mappingTier.name }}</h2>
          <p class="muted">当前映射 <code>{{ mappingTier.currentMapping?.videoSkuCode ?? '未配置' }}</code>。保存会新增一版映射（历史保留），只影响之后新创建的作品。</p>
          <div class="grid">
            <label class="full">视频 SKU
              <select v-model="mappingSkuCode">
                <option v-for="sku in skus.filter((s) => s.kind === 'video')" :key="sku.skuCode" :value="sku.skuCode">
                  {{ sku.skuCode }}（{{ yuan(sku.priceFen) }}/秒）
                </option>
              </select>
            </label>
          </div>
          <div class="foot">
            <button type="button" class="ghost" @click="mappingDialog = false">取消</button>
            <button type="button" class="primary" :disabled="loading" @click="submitMapping">保存并确认</button>
          </div>
        </div>
      </div>

      <!-- 风格弹窗 -->
      <div v-if="styleDialog" class="mask" @click.self="styleDialog = false">
        <div class="dialog miv-card">
          <h2>{{ styleTarget ? '编辑风格' : '新增风格' }}</h2>
          <div class="grid">
            <label>名称<input v-model="styleForm.name" /></label>
            <label>排序<input v-model.number="styleForm.sort" type="number" min="0" /></label>
            <label class="full">描述<input v-model="styleForm.description" /></label>
            <label class="full">封面（jpg/png/webp ≤5MB）
              <input type="file" accept="image/png,image/jpeg,image/webp" :disabled="styleUploading" @change="onCoverPick" />
              <span v-if="styleForm.coverUploadId" class="muted">已选 {{ styleForm.coverUploadId }}</span>
            </label>
            <label class="full">风格提示词（给引擎，不对用户展示）<input v-model="styleForm.promptHint" /></label>
          </div>
          <div class="foot">
            <button type="button" class="ghost" @click="styleDialog = false">取消</button>
            <button type="button" class="primary" :disabled="loading || styleUploading" @click="submitStyle">保存</button>
          </div>
        </div>
      </div>

      <!-- 音色弹窗 -->
      <div v-if="voiceDialog" class="mask" @click.self="voiceDialog = false">
        <div class="dialog miv-card">
          <h2>{{ voiceTarget ? '编辑音色' : '新增音色' }}</h2>
          <div class="grid">
            <label>名称<input v-model="voiceForm.name" /></label>
            <label>分类
              <select v-model="voiceForm.category">
                <option v-for="(label, key) in CATEGORY_LABEL" :key="key" :value="key">{{ label }}</option>
              </select>
            </label>
            <label>性别
              <select v-model="voiceForm.gender">
                <option value="female">女</option>
                <option value="male">男</option>
              </select>
            </label>
            <label>年龄段
              <select v-model="voiceForm.ageGroup">
                <option v-for="(label, key) in AGE_LABEL" :key="key" :value="key">{{ label }}</option>
              </select>
            </label>
            <label class="full">描述<input v-model="voiceForm.description" /></label>
            <label class="full">试听音频（mp3/wav/m4a ≤5MB）
              <input type="file" accept="audio/mpeg,audio/wav,audio/mp4,.mp3,.wav,.m4a" :disabled="voiceUploading" @change="(e) => onVoicePick(e, 'sampleUploadId')" />
              <span v-if="voiceForm.sampleUploadId" class="muted">已选 {{ voiceForm.sampleUploadId }}</span>
            </label>
            <label class="full">参考音频（供模型引用）
              <input type="file" accept="audio/mpeg,audio/wav,audio/mp4,.mp3,.wav,.m4a" :disabled="voiceUploading" @change="(e) => onVoicePick(e, 'refAudioUploadId')" />
              <span v-if="voiceForm.refAudioUploadId" class="muted">已选 {{ voiceForm.refAudioUploadId }}</span>
            </label>
          </div>
          <div class="foot">
            <button type="button" class="ghost" @click="voiceDialog = false">取消</button>
            <button type="button" class="primary" :disabled="loading || voiceUploading" @click="submitVoice">保存</button>
          </div>
        </div>
      </div>
    </Teleport>
  </AdminShell>
</template>

<style scoped>
.sec-title { margin: var(--miv-space-3) var(--miv-space-3) 0; font-size: 15px; display: flex; flex-direction: column; gap: 2px; }
.sec-hint { font-size: 12px; color: var(--miv-text-3); font-weight: 400; }
.sec-actions { display: flex; align-items: center; gap: var(--miv-space-3); padding: var(--miv-space-3); }
.strong { font-weight: 600; }
.muted { color: var(--miv-text-3); font-size: 12px; }
.wrap { max-width: 260px; white-space: normal; }
.tag.retired { margin-left: 8px; background: var(--miv-bg); color: var(--miv-text-3); }
td code { font-size: 12px; }
.settings-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: var(--miv-space-3);
  padding: var(--miv-space-3); }
.settings-grid label { display: flex; flex-direction: column; gap: 4px; font-size: 13px; color: var(--miv-text); }
.settings-grid input { border: 1px solid var(--miv-border); border-radius: 6px; padding: 8px 10px;
  font: inherit; font-size: 14px; background: var(--miv-surface); color: var(--miv-text); width: 100%; }
@media (max-width: 900px) { .settings-grid { grid-template-columns: repeat(2, 1fr); } }
</style>

<!-- 表格 / 弹窗 / 标签等共用样式（admin-page.css），与用户/订单页同口径 -->
<style scoped src="./admin-page.css"></style>
