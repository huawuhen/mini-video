<script setup lang="ts">
// ◆ 确认点 B：角色确认（PRD 3.1 / 4.7 / 5.3）。每个角色：形象版本 + 声音（只有 1 个片段时不显示声音）；
// 底部显示最终精确总价，确认时一次性预占视频费。casting 状态下只读，显示形象生成进度。
import { computed, onMounted, ref, watch } from 'vue';
import { showToast } from 'vant';
import { api, type ProjectDetail } from '@/api';
import CastRow from '@/components/CastRow.vue';
import PriceTag from '@/components/PriceTag.vue';
import StickyActionBar from '@/components/StickyActionBar.vue';
import VoicePicker from '@/components/VoicePicker.vue';
import { useCharge } from '@/composables/useCharge';
import { useOnboarding } from '@/composables/useOnboarding';
import { useCatalogStore } from '@/stores/catalog';
import { useWalletStore } from '@/stores/wallet';

const props = defineProps<{ project: ProjectDetail }>();
const emit = defineEmits<{ updated: [ProjectDetail]; refresh: [] }>();
const { confirmCharge } = useCharge();
const onboarding = useOnboarding();
const catalogStore = useCatalogStore();
const walletStore = useWalletStore();
const busy = ref(false);
const voiceFor = ref<string | null>(null);
const reviewing = computed(() => props.project.status === 'cast_review');
const voiceMember = computed(() => props.project.cast.find((m) => m.id === voiceFor.value));
const usedVoices = computed(() => props.project.cast.filter((m) => m.id !== voiceFor.value).map((m) => m.voice?.voiceId).filter((v): v is string => !!v));
const enough = computed(() => (walletStore.wallet?.availableFen ?? 0) >= props.project.pricing.videoFen);

onMounted(() => { walletStore.refresh(); });
watch(reviewing, (on) => { if (on) onboarding.showTip('cast_review', { voicesEnabled: props.project.voicesEnabled }); }, { immediate: true });

async function act(action: () => Promise<ProjectDetail>, done?: string) {
  if (busy.value) return;
  busy.value = true;
  try { emit('updated', await action()); if (done) showToast(done); } catch (e) { showToast((e as Error).message); emit('refresh'); } finally { busy.value = false; }
}
const pickLook = (castId: string, lookVersionId: string) => act(() => api.updateCast(props.project.id, castId, { lookVersionId }), '已切换形象，可随时切回');
function pickVoice(voiceId: string | null) {
  const castId = voiceFor.value;
  if (castId && voiceId) act(() => api.updateCast(props.project.id, castId, { voiceId }));
}
async function regenerate(castId: string) {
  const m = props.project.cast.find((x) => x.id === castId);
  if (!m?.characterId) return;
  const quote = await confirmCharge({ kind: 'look_regenerate', characterId: m.characterId, styleId: props.project.styleId }, `重新生成「${m.name}」的形象`, '确认并生成');
  if (quote) act(() => api.regenerateCastLook(props.project.id, castId, quote.quoteId, crypto.randomUUID()), '已开始生成，旧版本会保留');
}
async function confirm() {
  const quote = await confirmCharge({ kind: 'project_render', projectId: props.project.id }, '确认并开始制作', '确认并开始制作');
  if (quote) act(() => api.confirmCast(props.project.id, quote.quoteId, crypto.randomUUID()), '已开始制作');
}
</script>

<template>
  <section class="miv-card">
    <div class="miv-section-title">
      确认角色
      <span v-if="!reviewing" class="miv-hint"><van-loading size="12" /> {{ project.progress.message }}</span>
    </div>
    <p v-if="project.voicesEnabled" class="miv-hint intro">本片有 {{ project.segments.length }} 段，每个角色在各段都会使用同一个声音。</p>
    <CastRow
      v-for="(m, i) in project.cast"
      :key="m.id"
      :member="m"
      mode="cast"
      :voice="catalogStore.voiceById(m.voice?.voiceId)"
      :voices-enabled="project.voicesEnabled"
      :editable="reviewing && !busy"
      :tour-voice="i === 0"
      @pick-look="pickLook(m.id, $event)"
      @pick-voice="voiceFor = m.id"
      @regenerate="regenerate(m.id)"
    />
  </section>

  <section class="miv-card pricing" data-tour="cast-pricing">
    <div class="miv-section-title">费用明细</div>
    <div class="line"><span>角色形象（已支付）</span><PriceTag :fen="project.pricing.looksPaidFen ?? 0" size="sm" /></div>
    <div class="line"><span>视频生成 · {{ project.story?.totalSeconds }} 秒 · {{ catalogStore.tierName(project.qualityTierId) }}</span><PriceTag :fen="project.pricing.videoFen" size="sm" /></div>
    <div class="line total"><span>本片总价（不含已支付形象费）</span><PriceTag :fen="project.pricing.totalFen" /></div>
    <p class="miv-hint">点「确认并开始制作」时预占视频费，生成失败的片段会退回。当前余额 ¥{{ ((walletStore.wallet?.availableFen ?? 0) / 100).toFixed(2) }}</p>
  </section>

  <StickyActionBar v-if="reviewing">
    <template #info><span class="miv-hint">确认后开始生成视频</span></template>
    <van-button v-if="enough" type="primary" class="miv-btn-accent" :loading="busy" @click="confirm">确认并开始制作</van-button>
    <van-button v-else type="primary" class="miv-btn-accent" :to="{ path: '/wallet', query: { back: `/projects/${project.id}` } }">去充值</van-button>
  </StickyActionBar>

  <VoicePicker
    :show="!!voiceFor"
    :voices="catalogStore.voices"
    :selected-id="voiceMember?.voice?.voiceId"
    :disabled-ids="usedVoices"
    :title="`「${voiceMember?.name ?? ''}」的声音`"
    @update:show="!$event && (voiceFor = null)"
    @select="pickVoice"
  />
</template>

<style scoped>
.intro { margin-bottom: var(--miv-space-1); }
.pricing { display: flex; flex-direction: column; gap: var(--miv-space-2); }
.line { display: flex; justify-content: space-between; align-items: center; font-size: 14px; color: var(--miv-text-2); }
.total { color: var(--miv-text); font-weight: 600; border-top: 1px solid var(--miv-border); padding-top: var(--miv-space-2); }
</style>
