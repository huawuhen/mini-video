<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { showConfirmDialog, showToast } from 'vant';
import { api, type ConfirmStage, type ProjectDetail } from '@/api';
import PriceTag from '@/components/PriceTag.vue';
import StageStepper from '@/components/StageStepper.vue';
import StatusTag from '@/components/StatusTag.vue';
import StickyActionBar from '@/components/StickyActionBar.vue';
import { useBreakpoint } from '@/composables/useBreakpoint';
import { useProjectLive } from '@/composables/useProjectLive';
import { isActiveStatus, stageOf, type StageKey } from '@/utils/status';
import AssetsView from './project/AssetsView.vue';
import DeliveryView from './project/DeliveryView.vue';
import PlanView from './project/PlanView.vue';
import ShotsView from './project/ShotsView.vue';

const route = useRoute();
const router = useRouter();
const { isDesktop } = useBreakpoint();
const projectId = computed(() => String(route.params.id));
const { project, error, refresh } = useProjectLive(projectId);
const busy = ref(false);

// 当前阶段（暂停时取暂停前的阶段）与用户正在查看的阶段
const effectiveStatus = computed(() => (project.value?.status === 'paused' ? project.value.pausedFrom : project.value?.status) || 'draft');
const current = computed<StageKey>(() => stageOf(effectiveStatus.value));
const viewing = ref<StageKey>('plan');
watch(current, (stage) => { viewing.value = stage; }, { immediate: true });

const paused = computed(() => project.value?.status === 'paused');
const editableStage = (stage: StageKey) => {
  const p = project.value;
  if (!p) return false;
  const reviewOf: Partial<Record<StageKey, string>> = { plan: 'plan_review', assets: 'asset_review', shots: 'shot_review' };
  return p.status === reviewOf[stage] || (paused.value && current.value === stage);
};
const shotsMode = computed(() => {
  if (viewing.value === 'shots') return editableStage('shots') ? 'review' : 'view';
  return ['shots_generating', 'composing', 'delivered'].includes(effectiveStatus.value) ? 'generate' : 'view';
});
const confirmStage = computed<ConfirmStage | null>(() => {
  const map: Record<string, ConfirmStage> = { plan_review: 'plan', asset_review: 'assets', shot_review: 'shots' };
  return (project.value && map[project.value.status]) || null;
});
const confirmLabel: Record<ConfirmStage, string> = { plan: '剧本没问题，继续', assets: '确认角色，继续', shots: '确认分镜，开始生成视频' };

async function run(action: (p: ProjectDetail) => Promise<unknown>, done?: string) {
  if (!project.value || busy.value) return;
  busy.value = true;
  try { await action(project.value); if (done) showToast(done); await refresh(); }
  catch (e) { showToast((e as Error).message); }
  finally { busy.value = false; }
}
const confirm = () => confirmStage.value && run((p) => api.confirm(p.id, confirmStage.value!));
const pause = () => run((p) => api.pause(p.id), '已暂停，可以修改后继续');
const resume = () => run((p) => api.resume(p.id));
const retry = () => run((p) => api.retry(p.id));
async function cancel() {
  try { await showConfirmDialog({ title: '取消制作？', message: '未完成部分的预占金额会退回到余额。' }); } catch { return; }
  run((p) => api.cancel(p.id), '已取消');
}
async function regeneratePlan() {
  try { await showConfirmDialog({ title: '重新写剧本？', message: '当前剧本会被替换为新生成的版本。' }); } catch { return; }
  run((p) => api.regeneratePlan(p.id), 'AI 正在重新写剧本');
}
</script>

<template>
  <van-nav-bar :title="project?.plan?.title || project?.title || '作品详情'" left-arrow @click-left="router.push('/projects')" class="nav" />
  <div class="miv-page detail">
    <van-empty v-if="error && !project" :description="error" />
    <van-skeleton v-else-if="!project" title :row="8" />
    <template v-else>
      <header class="head">
        <div class="title-row">
          <h1>{{ project.plan?.title || project.title }}</h1>
          <StatusTag :status="project.status" />
        </div>
        <div v-if="project.status !== 'delivered'" class="progress">
          <van-progress :percentage="project.progress.percent" :show-pivot="false" stroke-width="6" />
          <p class="miv-hint">
            <van-loading v-if="isActiveStatus(project.status)" size="12" class="spin" />{{ project.progress.message }}
          </p>
        </div>
        <van-notice-bar v-if="project.error" color="var(--miv-danger)" background="#FEF2F2" left-icon="warning-o" :text="project.error.message" wrapable />
      </header>

      <div class="body">
        <aside v-if="isDesktop" class="stage-nav miv-card">
          <StageStepper :current="current" :viewing="viewing" vertical @select="viewing = $event" />
          <div class="billing">
            <div class="miv-hint">预估费用</div>
            <PriceTag :fen="project.billing.quotedFen" />
            <div class="miv-hint">已结算 ¥{{ (project.billing.settledFen / 100).toFixed(2) }} · 冻结 ¥{{ (project.billing.frozenFen / 100).toFixed(2) }}</div>
          </div>
        </aside>
        <div class="main">
          <StageStepper v-if="!isDesktop" :current="current" :viewing="viewing" @select="viewing = $event" />

          <section v-if="viewing === 'input'" class="miv-card">
            <div class="miv-section-title">原始剧本</div>
            <p class="source">{{ project.sourceText }}</p>
            <p class="miv-hint">{{ project.options.ratio }} · {{ project.options.durationSeconds }} 秒 · {{ project.mode === 'auto' ? '一键成片' : '逐步确认' }}</p>
          </section>
          <template v-else-if="viewing === 'plan'">
            <PlanView :project="project" :editable="editableStage('plan')" @changed="refresh" />
            <van-button v-if="editableStage('plan')" plain block icon="replay" class="regen" @click="regeneratePlan">不满意，重新写一版</van-button>
          </template>
          <AssetsView v-else-if="viewing === 'assets'" :project="project" :editable="editableStage('assets') || shotsMode === 'generate'" @changed="refresh" />
          <ShotsView v-else-if="viewing === 'shots' || viewing === 'generate'" :project="project" :mode="shotsMode" @changed="refresh" />
          <DeliveryView v-else :project="project" @changed="refresh" />

          <StickyActionBar v-if="!['delivered', 'canceled'].includes(project.status)">
            <template #info>
              <span v-if="confirmStage" class="miv-hint">确认后继续下一步</span>
              <span v-else-if="paused" class="miv-hint">已暂停，修改完成后继续</span>
              <span v-else-if="project.status === 'failed'" class="miv-hint">已完成的部分会保留</span>
              <span v-else class="miv-hint">关闭页面也会继续制作</span>
            </template>
            <van-button v-if="confirmStage" type="primary" :loading="busy" @click="confirm">{{ confirmLabel[confirmStage] }}</van-button>
            <van-button v-else-if="paused" type="primary" :loading="busy" @click="resume">继续制作</van-button>
            <van-button v-else-if="project.status === 'failed'" type="primary" :loading="busy" @click="retry">重试</van-button>
            <van-button v-else-if="project.mode === 'auto'" plain type="primary" :loading="busy" @click="pause">暂停，我要修改</van-button>
            <van-button plain :disabled="busy" @click="cancel">取消</van-button>
          </StickyActionBar>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.nav { position: sticky; top: 0; z-index: 10; }
.head { margin-bottom: var(--miv-space-3); }
.title-row { display: flex; align-items: center; gap: var(--miv-space-2); }
h1 { font-size: 20px; flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.progress { margin-top: var(--miv-space-3); }
.progress p { margin-top: var(--miv-space-2); display: flex; align-items: center; gap: var(--miv-space-1); }
.main { display: flex; flex-direction: column; gap: var(--miv-space-3); min-width: 0; }
.source { white-space: pre-wrap; font-size: 14px; line-height: 1.7; margin-bottom: var(--miv-space-2); }
.regen { margin-top: var(--miv-space-2); }
.stage-nav { position: sticky; top: var(--miv-space-5); display: flex; flex-direction: column; gap: var(--miv-space-4); padding: var(--miv-space-3); }
.billing { border-top: 1px solid var(--miv-border); padding: var(--miv-space-3) var(--miv-space-2) 0; display: flex; flex-direction: column; gap: var(--miv-space-1); }
@media (min-width: 1024px) {
  .nav { display: none; }
  .head { padding-top: var(--miv-space-2); }
  h1 { font-size: 24px; }
  .body { display: grid; grid-template-columns: 220px 1fr; gap: var(--miv-space-5); align-items: start; }
}
</style>
