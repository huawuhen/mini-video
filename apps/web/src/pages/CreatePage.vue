<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { showToast } from 'vant';
import { api, type Catalog, type ProjectMode, type SourceType } from '@/api';
import StickyActionBar from '@/components/StickyActionBar.vue';
import { useCharge } from '@/composables/useCharge';

const route = useRoute();
const router = useRouter();
const { confirmCharge } = useCharge();
const catalog = ref<Catalog | null>(null);
const submitting = ref(false);
const form = reactive({
  sourceType: 'text' as SourceType,
  title: '',
  sourceText: typeof route.query.idea === 'string' ? route.query.idea : '',
  ratio: '9:16',
  durationSeconds: 40,
  styleId: 'realistic',
  qualityId: 'standard',
  mode: 'auto' as ProjectMode,
});
const length = computed(() => form.sourceText.trim().length);
const limits = computed(() => catalog.value?.limits || { minScriptChars: 50, maxScriptChars: 2000 });
const minChars = computed(() => (form.sourceType === 'idea' ? 5 : limits.value.minScriptChars));
const canSubmit = computed(() => length.value >= minChars.value && length.value <= limits.value.maxScriptChars && !submitting.value);

onMounted(async () => {
  catalog.value = await api.catalog();
  if (form.sourceText && form.sourceText.length < limits.value.minScriptChars) form.sourceType = 'idea';
});

async function onFile(item: { file?: File } | { file?: File }[]) {
  const file = Array.isArray(item) ? item[0]?.file : item.file;
  if (!file) return;
  try {
    const result = await api.uploadScript(file);
    form.sourceText = result.text;
    form.title ||= result.title;
    form.sourceType = 'file';
    showToast('剧本已读取，可继续修改');
  } catch (e) { showToast((e as Error).message); }
}

async function submit() {
  if (!canSubmit.value) return;
  const options = { ratio: form.ratio, durationSeconds: form.durationSeconds, styleId: form.styleId, qualityId: form.qualityId };
  submitting.value = true;
  try {
    const quote = await confirmCharge({ kind: 'project', sourceText: form.sourceText, options }, '确认制作费用');
    if (!quote) return;
    const project = await api.createProject({
      title: form.title || undefined, sourceType: form.sourceType, sourceText: form.sourceText.trim(),
      options, mode: form.mode, quoteId: quote.quoteId, idempotencyKey: crypto.randomUUID(),
    });
    await router.replace(`/projects/${project.id}`);
  } catch (e) {
    showToast((e as Error).message);
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <van-nav-bar title="新建短片" left-arrow @click-left="router.back()" class="nav" />
  <div class="miv-page create">
    <section class="miv-card block">
      <div class="miv-section-title">1. 你的故事</div>
      <van-tabs v-model:active="form.sourceType" type="card" shrink>
        <van-tab title="粘贴剧本" name="text" />
        <van-tab title="上传文件" name="file" />
        <van-tab title="一句话想法" name="idea" />
      </van-tabs>
      <van-uploader v-if="form.sourceType === 'file'" accept=".txt,.docx" :max-count="1" :after-read="onFile" class="uploader">
        <van-button icon="description-o" plain type="primary" size="small">选择 txt / docx 文件</van-button>
      </van-uploader>
      <van-field v-model="form.title" placeholder="作品标题（选填）" :border="false" class="title-field" />
      <van-field
        v-model="form.sourceText"
        type="textarea"
        :rows="form.sourceType === 'idea' ? 3 : 8"
        autosize
        :maxlength="limits.maxScriptChars"
        show-word-limit
        :placeholder="form.sourceType === 'idea' ? '例如：一个外卖小哥在雨夜送餐时捡到一只会说话的猫' : `粘贴剧本或故事，至少 ${limits.minScriptChars} 字`"
        :border="false"
        class="text-field"
      />
      <p v-if="length > 0 && length < minChars" class="miv-hint warn">还差 {{ minChars - length }} 字</p>
    </section>

    <section v-if="catalog" class="miv-card block">
      <div class="miv-section-title">2. 成片设置</div>
      <div class="option">
        <span class="label">画面比例</span>
        <van-radio-group v-model="form.ratio" direction="horizontal">
          <van-radio v-for="r in catalog.ratios" :key="r" :name="r">{{ r === '9:16' ? '竖屏 9:16' : r === '16:9' ? '横屏 16:9' : '方形 1:1' }}</van-radio>
        </van-radio-group>
      </div>
      <div class="option">
        <span class="label">时长</span>
        <van-radio-group v-model="form.durationSeconds" direction="horizontal">
          <van-radio v-for="d in catalog.durations" :key="d" :name="d">{{ d }} 秒</van-radio>
        </van-radio-group>
      </div>
      <div class="option">
        <span class="label">风格</span>
        <div class="styles">
          <button v-for="s in catalog.styles" :key="s.id" type="button" :class="['style', { on: form.styleId === s.id }]" @click="form.styleId = s.id">
            <img :src="s.coverUrl" alt="" /><span>{{ s.name }}</span>
          </button>
        </div>
      </div>
      <div class="option">
        <span class="label">清晰度</span>
        <van-radio-group v-model="form.qualityId" direction="horizontal">
          <van-radio v-for="q in catalog.qualities" :key="q.id" :name="q.id">{{ q.name }}<small class="miv-hint"> {{ q.note }}</small></van-radio>
        </van-radio-group>
      </div>
    </section>

    <section class="miv-card block">
      <div class="miv-section-title">3. 制作方式</div>
      <van-radio-group v-model="form.mode">
        <van-cell-group inset :border="false" class="modes">
          <van-cell clickable title="一键成片（推荐）" label="AI 自动完成全部步骤，过程中随时可以暂停修改" @click="form.mode = 'auto'">
            <template #right-icon><van-radio name="auto" /></template>
          </van-cell>
          <van-cell clickable title="逐步确认" label="剧本、角色、分镜每一步都等你确认后再继续" @click="form.mode = 'guided'">
            <template #right-icon><van-radio name="guided" /></template>
          </van-cell>
        </van-cell-group>
      </van-radio-group>
    </section>

    <StickyActionBar>
      <template #info><span class="miv-hint">提交前会显示费用明细</span></template>
      <van-button type="primary" class="miv-btn-accent" :disabled="!canSubmit" :loading="submitting" @click="submit">开始制作</van-button>
    </StickyActionBar>
  </div>
</template>

<style scoped>
.nav { position: sticky; top: 0; z-index: 10; }
.create { display: flex; flex-direction: column; gap: var(--miv-space-3); max-width: 760px; }
.block { padding: var(--miv-space-4); }
.uploader { margin-top: var(--miv-space-3); }
.title-field, .text-field { padding-left: 0; padding-right: 0; }
.title-field { margin-top: var(--miv-space-2); font-weight: 600; }
.text-field { background: var(--miv-bg); border-radius: var(--miv-radius-md); padding: var(--miv-space-3); }
.warn { color: var(--miv-warning); margin-top: var(--miv-space-1); }
.option { padding: var(--miv-space-3) 0; border-bottom: 1px solid var(--miv-border); }
.option:last-child { border-bottom: 0; }
.label { display: block; font-size: 14px; color: var(--miv-text-2); margin-bottom: var(--miv-space-2); }
.styles { display: grid; grid-template-columns: repeat(4, 1fr); gap: var(--miv-space-2); }
.style { border: 2px solid transparent; border-radius: var(--miv-radius-md); padding: 0; overflow: hidden; background: none; cursor: pointer; text-align: center; font-size: 12px; color: var(--miv-text-2); }
.style img { width: 100%; aspect-ratio: 1; object-fit: cover; }
.style span { display: block; padding: 4px 0; }
.style.on { border-color: var(--miv-primary); color: var(--miv-primary-strong); }
.modes { margin: 0; }
@media (min-width: 1024px) { .nav { display: none; } .create { margin: 0 auto; } }
</style>
