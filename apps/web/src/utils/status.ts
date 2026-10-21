import type { AgeGroup, Gender, ProjectGroup, ProjectStatus, Ratio, TakeStatus, GenStatus } from '@/api/types';

type Tone = 'primary' | 'success' | 'warning' | 'danger' | 'default';
export const projectStatusMeta: Record<ProjectStatus, { label: string; tone: Tone }> = {
  understanding: { label: '理解故事中', tone: 'primary' },
  story_review: { label: '待确认故事', tone: 'warning' },
  casting: { label: '生成形象中', tone: 'primary' },
  cast_review: { label: '待确认角色', tone: 'warning' },
  rendering: { label: '生成视频中', tone: 'primary' },
  composing: { label: '拼接成片中', tone: 'primary' },
  delivered: { label: '已完成', tone: 'success' },
  expired: { label: '已过期', tone: 'default' },
  paused: { label: '已暂停', tone: 'warning' },
  failed: { label: '制作失败', tone: 'danger' },
  canceled: { label: '已取消', tone: 'default' },
};
export const genStatusLabel: Record<GenStatus | TakeStatus, string> = {
  pending: '排队中', running: '生成中', succeeded: '已完成', failed: '失败', unknown: '确认中',
};

/** docs/API.md §6.1 分组规则（前后端一致）。 */
export function groupOf(status: ProjectStatus): ProjectGroup {
  switch (status) {
    case 'story_review': case 'cast_review': return 'review';
    case 'delivered': return 'done';
    case 'failed': case 'canceled': return 'failed';
    case 'expired': return 'expired';
    default: return 'active';
  }
}
export const projectGroups: { key: ProjectGroup; label: string }[] = [
  { key: 'active', label: '进行中' },
  { key: 'review', label: '待确认' },
  { key: 'done', label: '已完成' },
  { key: 'failed', label: '失败' },
  { key: 'expired', label: '已过期' },
];

/** 作品五步（UI.md §5 FlowSteps）。 */
export const FLOW_STEPS = [
  { key: 'write', label: '写故事' },
  { key: 'story', label: '确认故事' },
  { key: 'cast', label: '确认角色' },
  { key: 'produce', label: '制作中' },
  { key: 'deliver', label: '成片' },
] as const;
export type FlowStepKey = (typeof FLOW_STEPS)[number]['key'];

export function flowStepOf(status: ProjectStatus): FlowStepKey {
  switch (status) {
    case 'understanding': case 'story_review': return 'story';
    case 'casting': case 'cast_review': return 'cast';
    case 'rendering': case 'composing': return 'produce';
    case 'delivered': case 'expired': return 'deliver';
    default: return 'write';
  }
}
/** 后台正在推进（需要较快刷新）的状态。 */
export const isWorkingStatus = (s: ProjectStatus) => ['understanding', 'casting', 'rendering', 'composing'].includes(s);

export const genderLabel: Record<Gender, string> = { female: '女', male: '男', unknown: '' };
export const ageLabel: Record<AgeGroup, string> = { child: '儿童', teen: '少年', young: '青年', middle: '中年', elder: '老人' };

/** 画幅的中文名（UI.md §1 零参数：界面不出现分辨率式参数，只显示业务名）。 */
export const ratioLabel: Record<Ratio, string> = { '9:16': '竖屏', '16:9': '横屏', '1:1': '方形' };
