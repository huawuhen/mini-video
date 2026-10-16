<script setup lang="ts">
// 交付页（PRD 5.5 / 3.2 / 8.1）：播放、保存到手机、复制链接、保存期提示、片段版本切换 / 改剧情 / 重新生成；
// 已过期：置灰，保留封面和故事，可「用这个故事再做一部」。
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { showConfirmDialog, showToast } from 'vant';
import { api, useMock, type ProjectDetail } from '@/api';
import ExpiryBanner from '@/components/ExpiryBanner.vue';
import MediaPlaceholder from '@/components/MediaPlaceholder.vue';
import SegmentCard from '@/components/SegmentCard.vue';
import { useCharge } from '@/composables/useCharge';
import { useOnboarding } from '@/composables/useOnboarding';
import { useCatalogStore } from '@/stores/catalog';

const props = defineProps<{ project: ProjectDetail }>();
const emit = defineEmits<{ updated: [ProjectDetail]; refresh: [] }>();
const router = useRouter();
const { confirmCharge } = useCharge();
const onboarding = useOnboarding();
const catalogStore = useCatalogStore();
const expired = computed(() => props.project.status === 'expired');
const render = computed(() => props.project.render);
const rerendering = computed(() => render.value?.status === 'running');
const limits = computed(() => catalogStore.catalog?.limits);
const editing = ref<{ id: string; plot: string } | null>(null);
const busy = ref(false);
// 竖屏视频按视口高度限制宽度，避免超出一屏
const playerMaxWidth = computed(() => {
  const [w, h] = props.project.ratio.split(':').map(Number);
  return h > w ? `min(420px, calc(70vh * ${w} / ${h}))` : '100%';
});

onMounted(() => { if (!expired.value) onboarding.showTip('delivery', { retentionDays: limits.value?.retentionDays }); });

async function act(action: () => Promise<ProjectDetail>, done?: string) {
  if (busy.value) return;
  busy.value = true;
  try { emit('updated', await action()); if (done) showToast(done); } catch (e) { showToast((e as Error).message); emit('refresh'); } finally { busy.value = false; }
}
function download() {
  if (useMock) { showToast('演示环境没有真实视频，接入后端后可下载'); return; }
  window.location.href = api.downloadUrl(props.project.id);
}
async function copyLink() {
  try { await navigator.clipboard.writeText(window.location.href); showToast('链接已复制'); } catch { showToast('复制失败，请手动复制地址栏链接'); }
}
const selectTake = (segmentId: string, takeId: string) => act(() => api.selectTake(props.project.id, segmentId, takeId), '已切换版本，正在重新拼接（免费）');
async function regenerate(segmentId: string) {
  const s = props.project.segments.find((x) => x.id === segmentId);
  const quote = await confirmCharge({ kind: 'segment_take', projectId: props.project.id, segmentId }, `重新生成片段 ${(s?.index ?? 0) + 1}`, '确认并生成');
  if (quote) act(() => api.regenerateSegment(props.project.id, segmentId, quote.quoteId, crypto.randomUUID()), '已开始生成，完成后自动替换并重新拼接');
}
async function savePlot() {
  const e = editing.value;
  if (!e) return;
  editing.value = null;
  await act(() => api.updateSegment(props.project.id, e.id, e.plot), '剧情已修改，点「重新生成」后生效');
}
async function remake() {
  try { await showConfirmDialog({ title: '用这个故事再做一部？', message: '会带着原来的故事回到首页，重新制作需要重新计费。' }); } catch { return; }
  try {
    sessionStorage.setItem('miv-home-draft', JSON.stringify({ storyText: props.project.storyText, sourceType: 'text', title: props.project.title, styleId: props.project.styleId, qualityTierId: props.project.qualityTierId, characterIds: props.project.cast.map((m) => m.characterId).filter(Boolean) }));
  } catch { /* 存储不可用：直接去首页 */ }
  router.push('/');
}
</script>

<template>
  <div :class="['delivery', { expired }]">
    <div class="player" :style="{ maxWidth: playerMaxWidth }">
      <video v-if="render?.videoUrl && !expired" :src="render.videoUrl" :poster="render.coverUrl" controls playsinline />
      <MediaPlaceholder v-else :src="render?.coverUrl || project.coverUrl" :ratio="project.ratio" :loading="rerendering" text="正在重新拼接…">
        <span v-if="expired" class="expired-mask">已过期，视频已清理</span>
        <van-icon v-else-if="!rerendering" name="play-circle-o" class="play" />
      </MediaPlaceholder>
    </div>
    <div class="side">
      <div class="miv-card">
        <h2>{{ project.title }}</h2>
        <p class="miv-hint">{{ render?.durationSeconds ?? project.durationSeconds }} 秒 · {{ catalogStore.styleName(project.styleId) }} · {{ project.ratio }}</p>
        <template v-if="!expired">
          <div class="save" data-tour="delivery-save">
            <van-button type="primary" class="miv-btn-accent" block icon="down" :disabled="rerendering" @click="download">保存到手机</van-button>
            <ExpiryBanner :expires-at="project.expiresAt" :remind-days="limits?.expiryRemindDays ?? 7" :retention-days="limits?.retentionDays ?? 90" />
          </div>
          <van-button block plain icon="link-o" class="copy" @click="copyLink">复制链接</van-button>
        </template>
        <template v-else>
          <p class="miv-muted story">{{ project.storyText }}</p>
          <van-button type="primary" block @click="remake">用这个故事再做一部</van-button>
        </template>
      </div>

      <div v-if="!expired" class="segments">
        <div class="miv-section-title">片段 <span class="miv-hint">不满意可以单独重新生成，旧版本保留</span></div>
        <SegmentCard
          v-for="s in project.segments"
          :key="s.id"
          :segment="s"
          :ratio="project.ratio"
          :editable="!busy && !rerendering"
          @select="selectTake(s.id, $event)"
          @edit="editing = { id: s.id, plot: s.plot }"
          @regenerate="regenerate(s.id)"
        />
      </div>
    </div>
  </div>

  <van-dialog :show="!!editing" title="修改片段剧情" show-cancel-button confirm-button-text="保存" @confirm="savePlot" @cancel="editing = null">
    <van-field v-if="editing" v-model="editing.plot" type="textarea" rows="4" autosize maxlength="500" show-word-limit />
  </van-dialog>
</template>

<style scoped>
.delivery { display: grid; gap: var(--miv-space-4); }
.player { width: 100%; margin: 0 auto; }
.player video { width: 100%; border-radius: var(--miv-radius-md); background: var(--miv-media-bg); }
.play { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); font-size: 56px; color: var(--miv-chip-bg); }
.expired .player { filter: grayscale(1); opacity: 0.7; }
.expired-mask { position: absolute; inset: auto 0 0 0; padding: var(--miv-space-2); text-align: center; background: var(--miv-chip-bg); font-size: 13px; color: var(--miv-text-2); }
.side { display: flex; flex-direction: column; gap: var(--miv-space-3); min-width: 0; }
h2 { font-size: 18px; margin-bottom: var(--miv-space-1); }
.save { display: flex; flex-direction: column; gap: var(--miv-space-2); margin-top: var(--miv-space-3); }
.copy { margin-top: var(--miv-space-2); }
.story { margin: var(--miv-space-3) 0; white-space: pre-wrap; }
.segments { display: flex; flex-direction: column; gap: var(--miv-space-2); }
@media (min-width: 1024px) { .delivery { grid-template-columns: minmax(0, 420px) 1fr; align-items: start; } .player { margin: 0; position: sticky; top: var(--miv-space-5); } }
</style>
