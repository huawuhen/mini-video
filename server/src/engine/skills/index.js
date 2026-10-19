// Registry of per-video-model prompt skills (docs/skills/wan-3.0.md §10).
// The caller picks the skill from the video SKU's `model` via forModel(); switching model
// or channel only changes the skillId, never the engine code.
import { wan30Skill } from './wan-3.0.js';
import { genericSkill } from './generic.js';

export const DEFAULT_SKILL_ID = wan30Skill.id;

export function createSkillRegistry(skills = [wan30Skill, genericSkill]) {
  const byId = new Map();
  const byModel = new Map();
  for (const skill of skills) {
    if (!skill?.id || typeof skill.id !== 'string') throw new TypeError('Skill 缺少 id');
    if (byId.has(skill.id)) throw new TypeError(`Skill id 重复：${skill.id}`);
    byId.set(skill.id, skill);
    for (const model of skill.models ?? []) {
      if (byModel.has(model)) throw new TypeError(`模型 ${model} 被多个 Skill 声明`);
      byModel.set(model, skill);
    }
  }
  return {
    list: () => [...byId.values()],
    get(skillId) {
      const skill = byId.get(skillId);
      if (!skill) throw new Error(`未知的提示词 Skill：${skillId}`);
      return skill;
    },
    forModel(model) {
      return byModel.get(model) ?? genericSkill;
    },
  };
}
