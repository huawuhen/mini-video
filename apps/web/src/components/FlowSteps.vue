<script setup lang="ts">
import { computed } from 'vue';
import type { ProjectStatus } from '@/api';
import { FLOW_STEPS, flowStepOf } from '@/utils/status';

const props = defineProps<{ status: ProjectStatus; pausedFrom?: ProjectStatus; vertical?: boolean;
  failedStep?: ProjectStatus }>(); // failedStep：失败发生时所处的项目状态（error.step），用于把失败定位到对应步骤
const currentIndex = computed(() => {
  const status = props.status === 'paused' && props.pausedFrom ? props.pausedFrom : props.status;
  // 失败/取消：停在失败（或取消前）所在的步骤，而不是回落到第 1 步
  const fallbackStep = props.failedStep ?? props.pausedFrom;
  const effective = (props.status === 'failed' || props.status === 'canceled') && fallbackStep
    ? fallbackStep : status;
  return FLOW_STEPS.findIndex((s) => s.key === flowStepOf(effective));
});
const allDone = computed(() => props.status === 'delivered' || props.status === 'expired');
const isFailed = computed(() => props.status === 'failed');
const isCanceled = computed(() => props.status === 'canceled');
</script>

<template>
  <ol :class="['flow', { vertical }]">
    <li
      v-for="(step, i) in FLOW_STEPS"
      :key="step.key"
      :class="{ done: i < currentIndex || allDone, current: i === currentIndex && !allDone && !isCanceled,
        failed: isFailed && i === currentIndex, canceled: isCanceled }"
    >
      <span class="dot">
        <van-icon v-if="i < currentIndex || allDone" name="success" size="12" />
        <template v-else>{{ i + 1 }}</template>
      </span>
      <span class="label">{{ step.label }}</span>
    </li>
  </ol>
</template>

<style scoped>
.flow { list-style: none; margin: 0; padding: 0; display: flex; justify-content: space-between; gap: var(--miv-space-1); }
li { flex: 1; display: flex; flex-direction: column; align-items: center; gap: var(--miv-space-1); color: var(--miv-text-3); font-size: 12px; position: relative; }
li:not(:last-child)::after { content: ''; position: absolute; top: 11px; left: calc(50% + 14px); right: calc(-50% + 14px); height: 2px; background: var(--miv-border); }
li.done:not(:last-child)::after { background: var(--miv-primary); }
.dot { width: 22px; height: 22px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; background: var(--miv-bg); border: 1px solid var(--miv-border); font-size: 12px; }
li.done .dot { background: var(--miv-primary); border-color: var(--miv-primary); color: var(--miv-on-primary); }
li.current { color: var(--miv-primary-strong); font-weight: 600; }
li.current .dot { border-color: var(--miv-primary); color: var(--miv-primary-strong); background: var(--miv-primary-soft); }
li.failed .dot { border-color: var(--miv-danger); background: var(--miv-danger); color: var(--miv-on-primary); }
li.failed { color: var(--miv-danger); font-weight: 600; }
li.canceled, li.canceled .dot { opacity: 0.55; }
.vertical { flex-direction: column; gap: var(--miv-space-4); }
.vertical li { flex-direction: row; font-size: 14px; }
.vertical li::after { display: none; }
</style>
