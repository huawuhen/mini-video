<script setup lang="ts">
// 聚光灯新手引导（PRD 5.8，docs/UI.md §7）：半透明遮罩 + 目标元素镂空高亮 + 解释气泡。
// 全局只挂一个（App.vue），由 useTour() 的状态驱动。
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { useTour } from '@/composables/useTour';
import { useBreakpoint } from '@/composables/useBreakpoint';

const tour = useTour();
const { isMobile } = useBreakpoint();
const PADDING = 6;   // 镂空区域外扩
const GAP = 12;      // 气泡与目标的间距
const MARGIN = 12;   // 气泡与视口边缘的最小距离

const rect = ref<{ top: number; left: number; width: number; height: number } | null>(null);
const bubble = ref<HTMLElement | null>(null);
const bubblePos = ref({ top: 0, left: 0, placement: 'bottom' as 'top' | 'bottom' | 'left' | 'right' });
const step = computed(() => tour.state.steps[tour.state.index]);
const isTour = computed(() => tour.state.mode === 'tour');
const isLast = computed(() => tour.state.index === tour.state.steps.length - 1);
const reducedMotion = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

let target: HTMLElement | null = null;
let observer: ResizeObserver | null = null;
let frame = 0;

function findTarget(key: string): HTMLElement | null {
  const candidates = document.querySelectorAll<HTMLElement>(`[data-tour="${key}"]`);
  return [...candidates].find((el) => el.getClientRects().length > 0) ?? null;
}

function measure() {
  if (!target) return;
  const r = target.getBoundingClientRect();
  rect.value = { top: r.top - PADDING, left: r.left - PADDING, width: r.width + PADDING * 2, height: r.height + PADDING * 2 };
  nextTick(placeBubble);
}
const scheduleMeasure = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(measure); };

/** 依次尝试各方向，选第一个放得下的；手机竖屏只考虑上 / 下。 */
function placeBubble() {
  const r = rect.value;
  const el = bubble.value;
  if (!r || !el) return;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const bw = el.offsetWidth;
  const bh = el.offsetHeight;
  const order: ('bottom' | 'top' | 'right' | 'left')[] = isMobile.value ? ['bottom', 'top'] : ['bottom', 'top', 'right', 'left'];
  const fits = {
    bottom: r.top + r.height + GAP + bh <= vh - MARGIN,
    top: r.top - GAP - bh >= MARGIN,
    right: r.left + r.width + GAP + bw <= vw - MARGIN,
    left: r.left - GAP - bw >= MARGIN,
  };
  const placement = order.find((p) => fits[p]) ?? (r.top > vh / 2 ? 'top' : 'bottom');
  const clampX = (x: number) => Math.min(Math.max(x, MARGIN), vw - bw - MARGIN);
  const clampY = (y: number) => Math.min(Math.max(y, MARGIN), vh - bh - MARGIN);
  const centerX = clampX(r.left + r.width / 2 - bw / 2);
  const centerY = clampY(r.top + r.height / 2 - bh / 2);
  const positions = {
    bottom: { top: clampY(r.top + r.height + GAP), left: centerX },
    top: { top: clampY(r.top - GAP - bh), left: centerX },
    right: { top: centerY, left: clampX(r.left + r.width + GAP) },
    left: { top: centerY, left: clampX(r.left - GAP - bw) },
  };
  bubblePos.value = { ...positions[placement], placement };
}

async function showStep() {
  observer?.disconnect();
  target = null;
  rect.value = null;
  if (!tour.state.active || !step.value) return;
  await nextTick();
  target = findTarget(step.value.target);
  if (!target) {
    // 目标在当前布局中不存在：主引导跳过该步，小提示直接结束
    if (isTour.value) tour.skipMissing(); else tour.finish(false);
    return;
  }
  target.scrollIntoView({ block: 'center', inline: 'nearest', behavior: reducedMotion ? 'auto' : 'smooth' });
  observer = new ResizeObserver(scheduleMeasure);
  observer.observe(target);
  setTimeout(() => {
    measure();
    nextTick(() => bubble.value?.querySelector<HTMLElement>('[data-primary]')?.focus({ preventScroll: true }));
  }, reducedMotion ? 0 : 320);
}

function onKeydown(e: KeyboardEvent) {
  if (!tour.state.active) return;
  if (e.key === 'Escape') { e.preventDefault(); tour.finish(false); }
  else if (e.key === 'ArrowRight' && isTour.value) { e.preventDefault(); tour.next(); }
  else if (e.key === 'ArrowLeft' && isTour.value) { e.preventDefault(); tour.prev(); }
  else if (e.key === 'Tab' && bubble.value) {
    // 焦点锁定在气泡内
    const focusables = [...bubble.value.querySelectorAll<HTMLElement>('button:not([disabled])')];
    if (!focusables.length) return;
    const index = focusables.indexOf(document.activeElement as HTMLElement);
    const nextIndex = e.shiftKey ? (index <= 0 ? focusables.length - 1 : index - 1) : (index + 1) % focusables.length;
    e.preventDefault();
    focusables[nextIndex].focus();
  }
}

/** 主引导中点遮罩不关闭（防误触）；小提示点任意处关闭。 */
function onMaskClick() { if (!isTour.value) tour.finish(true); }
/** 点高亮区域只进入下一步，不触发元素本身的功能（拦截层在目标之上）。 */
function onHoleClick() { if (isTour.value) tour.next(); else tour.finish(true); }

watch(() => [tour.state.active, tour.state.index, tour.state.steps] as const, ([active]) => {
  if (active) {
    window.addEventListener('resize', scheduleMeasure, { passive: true });
    window.addEventListener('scroll', scheduleMeasure, { passive: true, capture: true });
    window.addEventListener('keydown', onKeydown);
  } else {
    cleanup();
  }
  showStep();
}, { immediate: true });

function cleanup() {
  observer?.disconnect();
  cancelAnimationFrame(frame);
  window.removeEventListener('resize', scheduleMeasure);
  window.removeEventListener('scroll', scheduleMeasure, { capture: true });
  window.removeEventListener('keydown', onKeydown);
}
onBeforeUnmount(cleanup);

const holeStyle = computed(() => rect.value && {
  top: `${rect.value.top}px`, left: `${rect.value.left}px`, width: `${rect.value.width}px`, height: `${rect.value.height}px`,
});
</script>

<template>
  <Teleport to="body">
    <div v-if="tour.state.active && step" class="tour" :class="{ still: reducedMotion }" role="dialog" aria-modal="true" :aria-label="step.title">
      <div class="blocker" :class="{ dim: !rect }" @click="onMaskClick" />
      <template v-if="holeStyle">
        <div class="hole" :style="holeStyle" />
        <div class="hole-catch" :style="holeStyle" @click="onHoleClick" />
      </template>
      <div
        v-show="rect"
        ref="bubble"
        class="bubble"
        :class="`at-${bubblePos.placement}`"
        :style="{ top: `${bubblePos.top}px`, left: `${bubblePos.left}px` }"
        aria-live="polite"
      >
        <div class="head">
          <strong>{{ step.title }}</strong>
          <button v-if="isTour" type="button" class="skip" @click="tour.finish(false)">跳过</button>
        </div>
        <p>{{ step.text }}</p>
        <div class="foot">
          <span v-if="isTour" class="count">{{ tour.state.index + 1 }}/{{ tour.state.steps.length }}</span>
          <span v-else />
          <div class="actions">
            <button v-if="isTour && tour.state.index > 0" type="button" class="ghost" @click="tour.prev()">上一步</button>
            <button v-if="isTour" type="button" class="primary" data-primary @click="tour.next()">{{ isLast ? '开始创作' : '下一步' }}</button>
            <button v-else type="button" class="primary" data-primary @click="tour.finish(true)">知道了</button>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.tour { position: fixed; inset: 0; z-index: var(--miv-z-tour); }
.blocker { position: absolute; inset: 0; }
.blocker.dim { background: var(--miv-overlay); }
.hole {
  position: fixed; border-radius: var(--miv-radius-md); pointer-events: none;
  box-shadow: 0 0 0 9999px var(--miv-overlay), 0 0 0 2px var(--miv-primary);
  transition: top 0.3s ease, left 0.3s ease, width 0.3s ease, height 0.3s ease;
}
.hole-catch { position: fixed; cursor: pointer; border-radius: var(--miv-radius-md); }
.bubble {
  position: fixed; width: min(320px, calc(100vw - 24px)); background: var(--miv-surface); color: var(--miv-text);
  border-radius: var(--miv-radius-lg); box-shadow: var(--miv-shadow); padding: var(--miv-space-4);
  transition: top 0.3s ease, left 0.3s ease;
}
.head { display: flex; align-items: center; justify-content: space-between; gap: var(--miv-space-2); }
.head strong { font-size: 16px; }
p { margin: var(--miv-space-2) 0 var(--miv-space-3); font-size: 14px; line-height: 1.6; color: var(--miv-text-2); }
.foot { display: flex; align-items: center; justify-content: space-between; }
.count { font-size: 12px; color: var(--miv-text-3); font-variant-numeric: tabular-nums; }
.actions { display: flex; gap: var(--miv-space-2); }
button { font: inherit; border: 0; cursor: pointer; border-radius: var(--miv-radius-sm); padding: 6px 14px; font-size: 14px; }
.primary { background: var(--miv-primary); color: var(--miv-on-primary); }
.ghost { background: var(--miv-bg); color: var(--miv-text-2); }
.skip { background: transparent; color: var(--miv-text-3); padding: 2px 4px; font-size: 13px; }
button:focus-visible { outline: 2px solid var(--miv-primary-strong); outline-offset: 2px; }
.still .hole, .still .bubble { transition: none; }
@media (prefers-reduced-motion: reduce) { .hole, .bubble { transition: none; } }
</style>
