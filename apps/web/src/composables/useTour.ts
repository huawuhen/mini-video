import { reactive, readonly } from 'vue';

/** 新手引导步骤：target 对应页面元素的 data-tour 属性（docs/UI.md §7）。 */
export interface TourStep { target: string; title: string; text: string }
type EndHandler = (completed: boolean) => void;

const state = reactive({
  active: false,
  mode: 'tour' as 'tour' | 'tip',   // tour：多步主引导；tip：单步场景小提示
  steps: [] as TourStep[],
  index: 0,
});
let onEnd: EndHandler | undefined;

function begin(mode: 'tour' | 'tip', steps: TourStep[], end?: EndHandler) {
  if (!steps.length) return;
  state.mode = mode;
  state.steps = steps;
  state.index = 0;
  state.active = true;
  onEnd = end;
}
function finish(completed: boolean) {
  if (!state.active) return;
  state.active = false;
  const handler = onEnd;
  onEnd = undefined;
  handler?.(completed);
}

/** 全局唯一的引导状态；SpotlightTour 组件负责渲染，页面只调用 start / tip。 */
export function useTour() {
  return {
    state: readonly(state),
    start: (steps: TourStep[], end?: EndHandler) => begin('tour', steps, end),
    tip: (step: TourStep, end?: EndHandler) => begin('tip', [step], end),
    next: () => (state.index < state.steps.length - 1 ? state.index++ : finish(true)),
    prev: () => { if (state.index > 0) state.index--; },
    /** 目标元素在当前页面不存在时跳过该步（PRD 5.8） */
    skipMissing: () => (state.index < state.steps.length - 1 ? state.index++ : finish(true)),
    finish,
  };
}
