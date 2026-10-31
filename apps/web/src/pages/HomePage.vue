<script setup lang="ts">
// 首页 / 创作主页（PRD 5.1）：故事输入 → 数字人 → 风格 → 画质 → 价格区间 → 一键生成。
// 点「一键生成」不扣费，直接进入免费的故事理解；未登录时先保存草稿再去登录，回来后还原、不自动提交。
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { showToast } from 'vant';
import { api, type Character, type ProjectSummary } from '@/api';
import CharacterTray from '@/components/CharacterTray.vue';
import ProjectCard from '@/components/ProjectCard.vue';
import QualityPicker from '@/components/QualityPicker.vue';
import StylePicker from '@/components/StylePicker.vue';
import { useOnboarding } from '@/composables/useOnboarding';
import { useAuthStore } from '@/stores/auth';
import { useCatalogStore } from '@/stores/catalog';
import { formatFen } from '@/utils/money';

const DRAFT_KEY = 'miv-home-draft';
const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const catalogStore = useCatalogStore();
const onboarding = useOnboarding();
const catalog = computed(() => catalogStore.catalog);
const characters = ref<Character[]>([]);
const recent = ref<ProjectSummary[]>([]);
const estimate = ref<{ minFen: number; maxFen: number } | null>(null);
const submitting = ref(false);
const uploading = ref(false);
const draft = reactive({ storyText: '', sourceType: 'text' as 'text' | 'file', title: '', styleId: '', qualityTierId: '', characterIds: [] as string[] });

function restoreDraft() {
  try { Object.assign(draft, JSON.parse(sessionStorage.getItem(DRAFT_KEY) || '{}')); } catch { /* 忽略损坏的草稿 */ }
}
function saveDraft() { try { sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft)); } catch { /* 存储不可用 */ } }

const storyLength = computed(() => draft.storyText.trim().length);
const canSubmit = computed(() => !!catalog.value && storyLength.value >= catalog.value.limits.minStoryChars && !!draft.styleId && !!draft.qualityTierId);

let estimateTimer: ReturnType<typeof setTimeout> | undefined;
// M2-BE-04 复审建议 2：把登录状态加入 watch 源——登录后回到首页，价格区间立即出现，
// 不必等用户改一次选项
watch(() => [auth.user?.id ?? '', draft.styleId, draft.qualityTierId, draft.characterIds.join()], () => {
  clearTimeout(estimateTimer);
  // M2-BE-04⑤：estimate 需登录——未登录访问首页时不发（此前控制台 401 报错）
  if (!auth.user || !draft.styleId || !draft.qualityTierId) return;
  estimateTimer = setTimeout(async () => {
    try { estimate.value = await api.estimate({ styleId: draft.styleId, qualityTierId: draft.qualityTierId, characterIds: draft.characterIds }); } catch { estimate.value = null; }
  }, 250);
});
watch(draft, saveDraft, { deep: true });

onMounted(async () => {
  restoreDraft();
  const loaded = await catalogStore.load();
  draft.styleId ||= loaded.styles[0]?.id || '';
  draft.qualityTierId ||= loaded.qualityTiers[0]?.id || '';
  if (auth.loggedIn) {
    const [chars, projects] = await Promise.all([api.listCharacters(), api.listProjects()]);
    characters.value = chars.items;
    draft.characterIds = draft.characterIds.filter((id) => chars.items.some((c) => c.id === id));
    recent.value = projects.items.slice(0, 4);
  }
  await nextTick();
  if (route.query.tour === '1') {
    router.replace({ query: {} });
    onboarding.startMainTour(true);
  } else {
    onboarding.startMainTour();
  }
});

async function onUpload(file: File) {
  uploading.value = true;
  try {
    const result = await api.uploadStory(file);
    draft.storyText = result.text;
    draft.title = result.title;
    draft.sourceType = 'file';
  } catch (e) { showToast((e as Error).message); } finally { uploading.value = false; }
}
function pickFile() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.txt,.docx';
  input.onchange = () => { const file = input.files?.[0]; if (file) onUpload(file); };
  input.click();
}
function addCharacter() {
  if (!auth.loggedIn) { router.push({ path: '/login', query: { redirect: '/assets/new' } }); return; }
  router.push('/assets/new');
}

async function generate() {
  if (!canSubmit.value || submitting.value) return;
  if (!auth.loggedIn) {
    saveDraft();
    router.push({ path: '/login', query: { redirect: '/' } });
    return;
  }
  submitting.value = true;
  try {
    const project = await api.createProject({
      storyText: draft.storyText, sourceType: draft.sourceType, title: draft.title || undefined,
      styleId: draft.styleId, qualityTierId: draft.qualityTierId, characterIds: draft.characterIds,
      idempotencyKey: crypto.randomUUID(),
    });
    Object.assign(draft, { storyText: '', title: '', sourceType: 'text', characterIds: [] });
    router.push(`/projects/${project.id}`);
  } catch (e) { showToast((e as Error).message); } finally { submitting.value = false; }
}
</script>

<template>
  <div class="miv-page home">
    <section class="hero">
      <van-swipe v-if="catalog" class="showcase" :autoplay="4000" indicator-color="var(--miv-primary)">
        <van-swipe-item v-for="s in catalog.styles" :key="s.id">
          <div class="slide">
            <img v-if="s.coverUrl" :src="s.coverUrl" alt="" />
            <div class="caption"><strong>一句话生成的家庭大片</strong><span>{{ s.name }} · {{ s.description }}</span></div>
          </div>
        </van-swipe-item>
      </van-swipe>
      <div class="intro">
        <h1>写下你的故事，<br class="br" />AI 帮你拍成片</h1>
        <p class="miv-muted">不用会剪辑，不用懂参数。选好家人和风格，一键生成带声音的短片。</p>
      </div>
    </section>

    <section class="create miv-card">
      <div class="story" data-tour="story-input">
        <van-field
          v-model="draft.storyText"
          type="textarea"
          rows="4"
          autosize
          :maxlength="catalog?.limits.maxStoryChars"
          show-word-limit
          placeholder="写下一段想记录的故事，或者宝宝今天发生的一件趣事…"
          :border="false"
          @update:model-value="draft.sourceType = 'text'"
        />
        <div class="story-tools">
          <van-button size="mini" plain icon="description-o" :loading="uploading" @click="pickFile">上传 txt/docx</van-button>
          <span v-if="draft.sourceType === 'file' && draft.title" class="miv-hint">已导入《{{ draft.title }}》</span>
          <span class="miv-hint expand-hint">一句话也没关系，AI 会帮你扩写成完整剧本</span>
        </div>
      </div>

      <div class="block" data-tour="character-tray">
        <div class="label">我的数字资产库 <span class="miv-hint">（可多选，AI 也会自动识别故事里的人物）</span></div>
        <CharacterTray v-model="draft.characterIds" :characters="characters" :style-id="draft.styleId" @add="addCharacter" />
      </div>

      <div v-if="catalog" class="block" data-tour="style-picker">
        <div class="label">风格</div>
        <StylePicker v-model="draft.styleId" :styles="catalog.styles" />
      </div>

      <div v-if="catalog" class="block" data-tour="quality-picker">
        <div class="label">画质</div>
        <QualityPicker v-model="draft.qualityTierId" :tiers="catalog.qualityTiers" />
      </div>

      <div class="submit" data-tour="generate-button">
        <p class="estimate">
          <template v-if="estimate">预计 <b>¥{{ formatFen(estimate.minFen) }}~{{ formatFen(estimate.maxFen) }}</b>，确认故事后给出准确价格</template>
          <template v-else>写故事和整理故事免费，确认角色后才扣费</template>
        </p>
        <van-button type="primary" block class="miv-btn-accent" icon="play-circle-o" :loading="submitting" :disabled="!canSubmit" @click="generate">一键生成</van-button>
      </div>
    </section>

    <section v-if="recent.length" class="miv-section">
      <div class="miv-section-title">最近作品 <router-link to="/projects" class="miv-hint">全部 ›</router-link></div>
      <div class="miv-grid"><ProjectCard v-for="p in recent" :key="p.id" :project="p" :remind-days="catalog?.limits.expiryRemindDays" /></div>
    </section>
  </div>
</template>

<style scoped>
.home { display: flex; flex-direction: column; gap: var(--miv-space-4); }
.showcase { border-radius: var(--miv-radius-lg); overflow: hidden; }
.slide { position: relative; aspect-ratio: 16 / 9; background: var(--miv-primary-soft); }
.slide img { width: 100%; height: 100%; object-fit: cover; }
.caption { position: absolute; left: var(--miv-space-3); bottom: var(--miv-space-4); display: flex; flex-direction: column; gap: 2px; padding: var(--miv-space-2) var(--miv-space-3); border-radius: var(--miv-radius-md); background: var(--miv-chip-bg); font-size: 12px; color: var(--miv-text-2); }
.caption strong { font-size: 14px; color: var(--miv-text); }
.intro { margin-top: var(--miv-space-4); }
h1 { font-size: 24px; line-height: 1.35; margin-bottom: var(--miv-space-2); }
.create { display: flex; flex-direction: column; gap: var(--miv-space-4); }
.story { border-radius: var(--miv-radius-md); background: var(--miv-bg); padding: var(--miv-space-3); }
.story :deep(.van-field) { padding: 0; background: transparent; }
.story-tools { display: flex; align-items: center; gap: var(--miv-space-2); margin-top: var(--miv-space-2); flex-wrap: wrap; }
.expand-hint { margin-left: auto; }
@media (max-width: 767px) { .expand-hint { flex-basis: 100%; margin-left: 0; } }
.label { font-size: 15px; font-weight: 600; margin-bottom: var(--miv-space-2); }
.estimate { font-size: 13px; color: var(--miv-text-2); margin-bottom: var(--miv-space-2); text-align: center; }
.estimate b { color: var(--miv-accent); }
@media (min-width: 1024px) {
  .hero { display: grid; grid-template-columns: 1.2fr 1fr; gap: var(--miv-space-6); align-items: center; }
  .intro { margin-top: 0; }
  h1 { font-size: 34px; }
  .br { display: none; }
  .create { max-width: 880px; }
}
</style>
