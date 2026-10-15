import type { GenStatus, ProjectStatus } from '@/api';

type Tone = 'primary' | 'success' | 'warning' | 'danger' | 'default';
export const projectStatusMeta: Record<ProjectStatus, { label: string; tone: Tone }> = {
  draft: { label: '草稿', tone: 'default' },
  planning: { label: '写剧本中', tone: 'primary' },
  plan_review: { label: '待确认剧本', tone: 'warning' },
  assets_generating: { label: '生成角色中', tone: 'primary' },
  asset_review: { label: '待确认角色', tone: 'warning' },
  storyboarding: { label: '设计分镜中', tone: 'primary' },
  shot_review: { label: '待确认分镜', tone: 'warning' },
  shots_generating: { label: '生成视频中', tone: 'primary' },
  composing: { label: '合成成片中', tone: 'primary' },
  delivered: { label: '已完成', tone: 'success' },
  paused: { label: '已暂停', tone: 'warning' },
  failed: { label: '制作失败', tone: 'danger' },
  canceled: { label: '已取消', tone: 'default' },
};
export const genStatusLabel: Record<GenStatus, string> = { pending: '排队中', running: '生成中', succeeded: '已完成', failed: '失败' };

/** 6 个步骤与项目状态的对应关系（StageStepper 使用）。 */
export const STAGES = [
  { key: 'input', label: '输入' },
  { key: 'plan', label: '剧本' },
  { key: 'assets', label: '角色场景' },
  { key: 'shots', label: '分镜' },
  { key: 'generate', label: '生成' },
  { key: 'deliver', label: '成片' },
] as const;
export type StageKey = (typeof STAGES)[number]['key'];

export function stageOf(status: ProjectStatus): StageKey {
  switch (status) {
    case 'draft': return 'input';
    case 'planning': case 'plan_review': return 'plan';
    case 'assets_generating': case 'asset_review': return 'assets';
    case 'storyboarding': case 'shot_review': return 'shots';
    case 'shots_generating': return 'generate';
    case 'composing': case 'delivered': return 'deliver';
    default: return 'input';
  }
}
export const isActiveStatus = (s: ProjectStatus) => !['delivered', 'failed', 'canceled', 'paused'].includes(s) && !s.endsWith('_review');
