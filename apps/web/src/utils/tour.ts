import type { TipKey } from '@/api';
import type { TourStep } from '@/composables/useTour';

/** 首页主引导 5 步（PRD 5.8；文案为【默认】，可调整）。 */
export const MAIN_TOUR: TourStep[] = [
  { target: 'story-input', title: '写下你的故事', text: '在这里写下想记录的故事，一句话也可以，AI 会帮你补全细节' },
  { target: 'character-tray', title: '我的数字资产库', text: '上传照片生成专属数字人，永久保存在你的数字资产库，以后每部作品都能用' },
  { target: 'style-picker', title: '选择风格', text: '选一种你喜欢的画面风格' },
  { target: 'quality-picker', title: '选择画质', text: '标准更实惠，高清更细腻，价格直接标在这里' },
  { target: 'generate-button', title: '一键生成', text: '点这里开始。写故事和整理故事都免费，确认角色后才会扣费' },
];

/** 场景小提示：首次进入对应视图时各出现一次。 */
export function tipStep(key: TipKey, options: { voicesEnabled?: boolean; retentionDays?: number } = {}): TourStep {
  switch (key) {
    case 'story_review':
      return { target: 'story-confirm', title: '确认故事', text: '看看 AI 整理的故事，不满意可以直接改' };
    case 'cast_review':
      return options.voicesEnabled
        ? { target: 'cast-voice', title: '角色的声音', text: '点这里试听或更换声音，不选的话 AI 会帮你配' }
        : { target: 'cast-pricing', title: '最终价格', text: '这是本片的最终价格，确认后才会扣费' };
    case 'delivery':
      return { target: 'delivery-save', title: '保存作品', text: `作品保存 ${Math.round((options.retentionDays ?? 90) / 30)} 个月，记得保存到手机` };
  }
}
