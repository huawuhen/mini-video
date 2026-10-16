import { api, type TipKey } from '@/api';
import { useAuthStore } from '@/stores/auth';
import { MAIN_TOUR, tipStep } from '@/utils/tour';
import { useTour } from './useTour';

/**
 * 新手引导的触发规则（PRD 5.8）：
 * - 主引导：首页、已登录且 onboarding.tourCompletedAt 为 null 时自动开始；完成或跳过都记为「已看过」。
 * - 重播：force=true，只在前端播放，不改服务端状态。
 * - 场景小提示：tipsSeen 不含该 key 时出现一次，关闭后记录。
 */
export function useOnboarding() {
  const auth = useAuthStore();
  const tour = useTour();

  function startMainTour(force = false) {
    if (tour.state.active) return;
    const user = auth.user;
    if (!force && (!user || user.onboarding.tourCompletedAt)) return;
    tour.start(MAIN_TOUR, async () => {
      if (!auth.user || auth.user.onboarding.tourCompletedAt) return;
      try { auth.setOnboarding((await api.updateOnboarding({ tourCompleted: true })).onboarding); } catch { /* 下次进入首页会再试 */ }
    });
  }

  function showTip(key: TipKey, options?: Parameters<typeof tipStep>[1]) {
    const user = auth.user;
    if (!user || tour.state.active || user.onboarding.tipsSeen.includes(key)) return;
    tour.tip(tipStep(key, options), async () => {
      try { auth.setOnboarding((await api.updateOnboarding({ tipSeen: key })).onboarding); } catch { /* 忽略 */ }
    });
  }

  return { startMainTour, showTip, tourActive: () => tour.state.active };
}
