<script setup lang="ts">
// ◆ 确认点 A：故事确认（PRD 3.1 / 5.3 / API.md §6.3）。展示并可编辑剧本全文（story.script）；
// 一句话想法已被 AI 扩写成剧本时给出标注；「重新整理」把修改后的剧本重新规划，按剧本处理不再扩写。
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
const scriptText = ref(scriptOf(props.project));
const busy = ref(false);
const library = ref<Character[]>([]);
const rematchFor = ref<string | null>(null);
const story = computed(() => props.project.story);
const rematchActions = computed(() => [
  ...library.value.map((c) => ({ name: c.name, subname: c.styleIds.includes(props.project.styleId) ? '已有本风格形象' : '需生成形象', value: c.id })),
  { name: '新建一个数字人', subname: '按故事描述生成', value: null as string | null },
]);

/** 确认点 A 的剧本全文：story.script 优先；后端未返回 story 时回退原始输入。 */
function scriptOf(p: ProjectDetail) { return p.story?.script ?? p.storyText; }

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
  if (scriptText.value.trim() === scriptOf(props.project).trim()) { editing.value = false; return; }
  try {
    await showConfirmDialog({
      title: '按修改后的剧本重新整理？',
      message: '会按现在的剧本重新规划片段和画面，免费；这段文字会按剧本处理，不会再扩写。占用一次今日免费次数。',
    });
  } catch { return; }
  act(() => api.reanalyzeStory(props.project.id, scriptText.value), 'AI 正在重新整理剧本');
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
      <span class="title-with-tag">
        剧本
        <span v-if="story?.expanded" class="expanded-tag"><van-icon name="magic" /> AI 已为你扩写成剧本</span>
      </span>
      <van-button v-if="!editing" size="mini" plain icon="edit" @click="editing = true; scriptText = scriptOf(project)">修改剧本</van-button>
    </div>
    <van-notice-bar v-if="story?.notice" left-icon="info-o" :text="story.notice" wrapable class="notice" />
    <template v-if="!editing">
      <p class="script">{{ story?.script ?? project.storyText }}</p>
      <details class="raw">
        <summary class="miv-hint">查看原始输入与梗概</summary>
        <p class="raw-block"><span class="miv-hint">原始输入</span>{{ project.storyText }}</p>
        <p v-if="story?.synopsis" class="raw-block"><span class="miv-hint">故事梗概</span>{{ story.synopsis }}</p>
      </details>
    </template>
    <template v-else>
      <van-field v-model="scriptText" type="textarea" rows="8" autosize :maxlength="catalogStore.catalog?.limits.maxStoryChars" show-word-limit class="editor" />
      <p class="miv-hint editor-hint">这里就是最终拍片用的剧本，可以直接修改；保存后 AI 按剧本重新规划，不会再改写你的文字。</p>
      <div class="edit-actions">
        <van-button size="small" plain @click="editing = false">取消</van-button>
        <van-button size="small" type="primary" :loading="busy" @click="reanalyze">按剧本重新整理（免费）</van-button>
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
.title-with-tag { display: flex; align-items: center; gap: var(--miv-space-2); flex-wrap: wrap; }
.expanded-tag { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; font-weight: 400; padding: 2px 10px; border-radius: 999px; background: var(--miv-primary-soft); color: var(--miv-primary-strong); }
.notice { margin-bottom: var(--miv-space-3); border-radius: var(--miv-radius-md); }
.script { font-size: 15px; line-height: 1.9; white-space: pre-wrap; }
.raw { margin-top: var(--miv-space-3); }
.raw p { margin-top: var(--miv-space-2); }
.raw-block { display: flex; flex-direction: column; gap: 2px; font-size: 13px; line-height: 1.7; color: var(--miv-text-2); white-space: pre-wrap; }
.editor { background: var(--miv-bg); border-radius: var(--miv-radius-md); }
.editor-hint { margin-top: var(--miv-space-2); }
.edit-actions { display: flex; justify-content: flex-end; gap: var(--miv-space-2); margin-top: var(--miv-space-2); }
.plan { display: grid; gap: var(--miv-space-3); grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); }
.plan > div { display: flex; flex-direction: column; gap: 2px; }
</style>
