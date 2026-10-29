<script setup lang="ts">
// 作品详情（docs/UI.md §5）：顶部五步进度，按状态切换视图；暂停/失败/取消显示状态卡片。
import { computed, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { showConfirmDialog, showToast } from 'vant';
import { api, type ProjectDetail } from '@/api';
import FlowSteps from '@/components/FlowSteps.vue';
import StatusTag from '@/components/StatusTag.vue';
import { useBreakpoint } from '@/composables/useBreakpoint';
import { useProjectLive } from '@/composables/useProjectLive';
import { useCatalogStore } from '@/stores/catalog';
import { ratioLabel } from '@/utils/status';
import CastReviewView from './project/CastReviewView.vue';
import DeliveryView from './project/DeliveryView.vue';
import ProducingView from './project/ProducingView.vue';
import StoryReviewView from './project/StoryReviewView.vue';
import UnderstandingView from './project/UnderstandingView.vue';

const route = useRoute();
const router = useRouter();
const { isDesktop } = useBreakpoint();
const catalogStore = useCatalogStore();
catalogStore.load();
const projectId = computed(() => String(route.params.id));
const { project, error, refresh } = useProjectLive(projectId);
const techOpen = ref<string[]>([]); // 「技术详情」折叠区：内部 ID 与错误码只放这里（UI.md §1）

/** 暂停时按暂停前的状态展示内容 */
const viewStatus = computed(() => (project.value?.status === 'paused' ? project.value.pausedFrom : project.value?.status));
const canPause = computed(() => ['understanding', 'casting', 'rendering'].includes(project.value?.status || ''));
const canCancel = computed(() => ['understanding', 'story_review', 'casting', 'cast_review', 'rendering', 'paused'].includes(project.value?.status || ''));

async function run(action: (p: ProjectDetail) => Promise<ProjectDetail | unknown>, done?: string) {
  if (!project.value) return;
  try {
    const result = await action(project.value);
    if (result && typeof result === 'object' && 'status' in result) project.value = result as ProjectDetail;
    else await refresh();
    if (done) showToast(done);
  } catch (e) { showToast((e as Error).message); }
}
const pause = () => run((p) => api.pause(p.id), '已暂停');
const resume = () => run((p) => api.resume(p.id));
const retry = () => run((p) => api.retry(p.id));
async function cancel() {
  try { await showConfirmDialog({ title: '取消制作？', message: '未开始的部分会退回预占的费用；已生成的角色形象会保留在你的数字资产库。' }); } catch { return; }
  run((p) => api.cancel(p.id), '已取消');
}
function onUpdated(p: ProjectDetail) { project.value = p; }
</script>

<template>
  <van-nav-bar :title="project?.title || '作品详情'" left-arrow @click-left="router.push('/projects')" class="nav" />
  <div class="miv-page detail">
    <van-empty v-if="error && !project" :description="error" />
    <van-skeleton v-else-if="!project" title :row="8" />
    <template v-else>
      <header class="head">
        <div class="title-row">
          <h1>{{ project.title || '新作品' }}</h1>
          <StatusTag :status="project.status" />
        </div>
        <p class="miv-hint">{{ catalogStore.styleName(project.styleId) }} · {{ catalogStore.tierName(project.qualityTierId) }} · {{ ratioLabel[project.ratio] }}</p>
      </header>

      <div class="body">
        <aside v-if="isDesktop" class="side miv-card">
          <FlowSteps :status="project.status" :paused-from="project.pausedFrom" :failed-step="project.error?.step" vertical />
          <div class="side-actions">
            <van-button v-if="canPause" size="small" plain block @click="pause">暂停</van-button>
            <van-button v-if="canCancel" size="small" plain block @click="cancel">取消制作</van-button>
          </div>
        </aside>
        <div class="main">
          <FlowSteps v-if="!isDesktop" :status="project.status" :paused-from="project.pausedFrom" :failed-step="project.error?.step" class="steps" />

          <div v-if="project.status === 'paused'" class="state miv-card">
            <van-icon name="pause-circle-o" size="28" color="var(--miv-warning)" />
            <div><strong>已暂停</strong><p class="miv-hint">已提交的片段会继续完成，其余步骤等你继续。</p></div>
            <van-button type="primary" size="small" @click="resume">继续制作</van-button>
          </div>
          <div v-else-if="project.status === 'failed'" class="state miv-card danger">
            <van-icon name="warning-o" size="28" color="var(--miv-danger)" />
            <div>
              <strong>{{ project.error?.message || '制作遇到问题' }}</strong>
              <!-- 结果未知（TAKE_UNKNOWN/LOOK_UNKNOWN）：金额冻结待人工核对，重试会被后端拒绝，不显示重试入口 -->
              <p class="miv-hint">{{ project.error?.code?.endsWith('UNKNOWN')
                ? '金额已冻结，客服核对后会尽快处理，无需重复操作。'
                : '已完成的部分会保留，重试不会重复扣费。' }}</p>
              <van-collapse v-model="techOpen" :border="false" class="tech">
                <van-collapse-item title="技术详情" name="tech" :border="false">{{ project.error?.code }} · {{ project.id }}</van-collapse-item>
              </van-collapse>
            </div>
            <div class="actions">
              <van-button v-if="!project.error?.code?.endsWith('UNKNOWN')" type="primary" size="small" @click="retry">重试</van-button>
              <!-- 失败/结果未知均可取消：未提交与可退部分立即退回（unknown 片段冻结待客服核对） -->
              <van-button size="small" plain @click="cancel">取消制作</van-button>
            </div>
          </div>
          <div v-else-if="project.status === 'canceled'" class="state miv-card">
            <van-icon name="close" size="28" color="var(--miv-text-3)" />
            <div><strong>已取消</strong><p class="miv-hint">{{ project.progress.message }}</p></div>
            <van-button size="small" plain to="/">再做一部</van-button>
          </div>

          <UnderstandingView v-if="viewStatus === 'understanding'" :project="project" />
          <StoryReviewView v-else-if="viewStatus === 'story_review'" :project="project" @updated="onUpdated" @refresh="refresh" />
          <CastReviewView v-else-if="viewStatus === 'casting' || viewStatus === 'cast_review'" :project="project" @updated="onUpdated" @refresh="refresh" />
          <ProducingView v-else-if="viewStatus === 'rendering' || viewStatus === 'composing'" :project="project" />
          <DeliveryView v-else-if="viewStatus === 'delivered' || viewStatus === 'expired'" :project="project" @updated="onUpdated" @refresh="refresh" />

          <div v-if="!isDesktop && (canPause || canCancel)" class="mobile-actions">
            <van-button v-if="canPause" size="small" plain @click="pause">暂停</van-button>
            <van-button v-if="canCancel" size="small" plain @click="cancel">取消制作</van-button>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.nav { position: sticky; top: 0; z-index: 10; }
.head { margin-bottom: var(--miv-space-3); display: flex; flex-direction: column; gap: var(--miv-space-1); }
.title-row { display: flex; align-items: center; gap: var(--miv-space-2); }
h1 { font-size: 20px; flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.main { display: flex; flex-direction: column; gap: var(--miv-space-3); min-width: 0; }
.steps { margin-bottom: var(--miv-space-1); }
.state { display: flex; align-items: flex-start; gap: var(--miv-space-3); }
.state > div { flex: 1; min-width: 0; }
.state.danger { background: var(--miv-danger-soft); }
.tech { margin-top: var(--miv-space-1); font-size: 12px; }
.tech :deep(.van-cell) { padding: 0; background: transparent; font-size: 12px; }
.mobile-actions { display: flex; justify-content: center; gap: var(--miv-space-2); padding: var(--miv-space-2) 0 var(--miv-space-4); }
.side { position: sticky; top: var(--miv-space-5); display: flex; flex-direction: column; gap: var(--miv-space-5); }
.side-actions { display: flex; flex-direction: column; gap: var(--miv-space-2); }
@media (min-width: 1024px) {
  .nav { display: none; }
  .head { padding-top: var(--miv-space-2); }
  h1 { font-size: 24px; }
  .body { display: grid; grid-template-columns: 200px 1fr; gap: var(--miv-space-5); align-items: start; }
}
</style>
