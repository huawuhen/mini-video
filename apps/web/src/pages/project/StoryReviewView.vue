<script setup lang="ts">
// ◆ 确认点 A：故事确认（PRD 3.1 / 5.3）。展示梗概、角色匹配、时长与视频费；可改故事后免费重新整理。
import { computed, onMounted, ref } from 'vue';
import { showConfirmDialog, showToast } from 'vant';
import { api, type Character, type ProjectDetail } from '@/api';
import CastRow from '@/components/CastRow.vue';
import PriceTag from '@/components/PriceTag.vue';
import StickyActionBar from '@/components/StickyActionBar.vue';
import { useCharge } from '@/composables/useCharge';
import { useOnboarding } from '@/composables/useOnboarding';
import { useCatalogStore } from '@/stores/catalog';
import { formatFen } from '@/utils/money';

const props = defineProps<{ project: ProjectDetail }>();
const emit = defineEmits<{ updated: [ProjectDetail]; refresh: [] }>();
const { confirmCharge } = useCharge();
const onboarding = useOnboarding();
const catalogStore = useCatalogStore();
const editing = ref(false);
const storyText = ref(props.project.storyText);
const busy = ref(false);
const library = ref<Character[]>([]);
const rematchFor = ref<string | null>(null);
const story = computed(() => props.project.story);
const rematchActions = computed(() => [
  ...library.value.map((c) => ({ name: c.name, subname: c.styleIds.includes(props.project.styleId) ? '已有本风格形象' : '需生成形象', value: c.id })),
  { name: '新建一个数字人', subname: '按故事描述生成', value: null as string | null },
]);

onMounted(async () => {
  onboarding.showTip('story_review');
  library.value = (await api.listCharacters()).items;
});

async function act(action: () => Promise<ProjectDetail>, done?: string) {
  if (busy.value) return;
  busy.value = true;
  try { emit('updated', await action()); if (done) showToast(done); } catch (e) { showToast((e as Error).message); emit('refresh'); } finally { busy.value = false; }
}
async function reanalyze() {
  if (storyText.value.trim() === props.project.storyText.trim()) { editing.value = false; return; }
  try { await showConfirmDialog({ title: '重新整理故事？', message: '会按修改后的故事重新理解和规划，免费，但会占用一次今日免费次数。' }); } catch { return; }
  act(() => api.reanalyzeStory(props.project.id, storyText.value), 'AI 正在重新整理');
}
function onRematch(action: { value: string | null }) {
  const castId = rematchFor.value;
  rematchFor.value = null;
  if (castId) act(() => api.setCastCharacter(props.project.id, castId, action.value));
}
async function confirm() {
  const p = props.project;
  let quoteId: string | undefined;
  if (p.pricing.looksToGenerate > 0) {
    const quote = await confirmCharge({ kind: 'cast_looks', projectId: p.id }, `为 ${p.pricing.looksToGenerate} 个角色生成形象`, '确认并生成形象');
    if (!quote) return;
    quoteId = quote.quoteId;
  }
  act(() => api.confirmStory(p.id, quoteId, crypto.randomUUID()));
}
</script>

<template>
  <section class="miv-card">
    <div class="miv-section-title">
      AI 整理后的故事
      <van-button v-if="!editing" size="mini" plain icon="edit" @click="editing = true; storyText = project.storyText">修改故事</van-button>
    </div>
    <van-notice-bar v-if="story?.notice" left-icon="info-o" :text="story.notice" wrapable class="notice" />
    <template v-if="!editing">
      <p class="synopsis">{{ story?.synopsis }}</p>
      <details class="raw"><summary class="miv-hint">查看原始故事</summary><p>{{ project.storyText }}</p></details>
    </template>
    <template v-else>
      <van-field v-model="storyText" type="textarea" rows="5" autosize :maxlength="catalogStore.catalog?.limits.maxStoryChars" show-word-limit class="editor" />
      <div class="edit-actions">
        <van-button size="small" plain @click="editing = false">取消</van-button>
        <van-button size="small" type="primary" :loading="busy" @click="reanalyze">重新整理（免费）</van-button>
      </div>
    </template>
  </section>

  <section class="miv-card">
    <div class="miv-section-title">角色 <span class="miv-hint">匹配不对可以更换</span></div>
    <CastRow v-for="m in project.cast" :key="m.id" :member="m" mode="story" :voices-enabled="project.voicesEnabled" :editable="!busy" @rematch="rematchFor = m.id" />
  </section>

  <section class="miv-card plan">
    <div><span class="miv-hint">预计成片</span><strong>{{ story?.totalSeconds }} 秒 · 共 {{ story?.segmentCount }} 段</strong></div>
    <div><span class="miv-hint">视频费（确认角色后预占）</span><PriceTag :fen="project.pricing.videoFen" /></div>
    <div v-if="project.pricing.looksToGenerate"><span class="miv-hint">{{ project.pricing.looksToGenerate }} 个角色需生成形象</span><PriceTag :fen="project.pricing.looksFen" /></div>
  </section>

  <StickyActionBar>
    <template #info>
      <span class="miv-hint">{{ project.pricing.looksToGenerate ? `下一步生成角色形象 ¥${formatFen(project.pricing.looksFen)}` : '下一步确认角色，暂不扣费' }}</span>
    </template>
    <span data-tour="story-confirm"><van-button type="primary" :loading="busy" :disabled="editing" @click="confirm">确认，下一步</van-button></span>
  </StickyActionBar>

  <van-action-sheet :show="!!rematchFor" :actions="rematchActions" cancel-text="取消" title="这个角色用谁？" @select="onRematch" @update:show="!$event && (rematchFor = null)" />
</template>

<style scoped>
.notice { margin-bottom: var(--miv-space-3); border-radius: var(--miv-radius-md); }
.synopsis { font-size: 15px; line-height: 1.8; white-space: pre-wrap; }
.raw { margin-top: var(--miv-space-3); }
.raw p { font-size: 13px; line-height: 1.7; color: var(--miv-text-2); white-space: pre-wrap; margin-top: var(--miv-space-2); }
.editor { background: var(--miv-bg); border-radius: var(--miv-radius-md); }
.edit-actions { display: flex; justify-content: flex-end; gap: var(--miv-space-2); margin-top: var(--miv-space-2); }
.plan { display: grid; gap: var(--miv-space-3); grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); }
.plan > div { display: flex; flex-direction: column; gap: 2px; }
</style>
