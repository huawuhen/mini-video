// project.bind_prompts（docs/ARCHITECTURE.md §4）：确认点 B 后，把锁定的形象与音色交给
// engine.story.bindPrompts 逐段生成镜头时间线，最终提示词由 Skill 代码拼装并写入
// segments.final_prompt；完成后入队第一个 segment.generate（片段严格串行，用户 2026-10-19 决定）。
import { PermanentJobError } from '../queue/index.js';
import { createSkillRegistry } from '../engine/skills/index.js';
import { videoSkuForMapping } from './understand.js';

// 按视频 SKU 的 model 选 Skill（docs/skills/wan-3.0.md §10）；未知模型回退 generic
const skillRegistry = createSkillRegistry();
import { updateProgress } from './state.js';

export function createBindPromptsHandler({ db, logger, storyAgent }) {
  return async function projectBindPrompts(payload, ctx) {
    const projectId = payload.projectId;
    const { rows: current } = await db.query(`SELECT user_id, status, style_id, ratio, tier_mapping_id
      FROM projects WHERE id = $1`, [projectId]);
    if (!current.length) throw new PermanentJobError('作品不存在');
    const project = current[0];
    if (project.status !== 'rendering') {
      ctx.logger.info('project_bind_skip', { projectId, status: project.status });
      return; // 已取消/暂停恢复中：幂等空转
    }
    const userId = project.user_id;
    const { rows: storyRows } = await db.query(`SELECT story FROM projects WHERE id = $1`, [projectId]);
    const story = storyRows[0]?.story;
    if (!story?.raw) throw new PermanentJobError('作品缺少故事理解结果，无法绑定提示词');

    const { rows: castRows } = await db.query(
      `SELECT pc.id, pc.idx, pc.voice_id, lv.image_key AS look_image_key, v.ref_audio_key
         FROM project_cast pc
         LEFT JOIN look_versions lv ON lv.id = pc.look_version_id
         LEFT JOIN voices v ON v.id = pc.voice_id
        WHERE pc.project_id = $1 ORDER BY pc.idx`, [projectId]);
    const cast = castRows.map((row) => ({
      id: row.id,
      ...(row.look_image_key ? { lookImageKey: row.look_image_key } : {}),
      ...(row.ref_audio_key ? { refAudioKey: row.ref_audio_key } : {}),
    }));
    const { rows: segmentRows } = await db.query(
      `SELECT id, idx FROM segments WHERE project_id = $1 ORDER BY idx`, [projectId]);
    const segments = segmentRows.map((row) => ({
      id: row.id,
      ...(story.raw.segments?.[row.idx] ?? {}),
    }));

    const { rows: styleRows } = await db.query(
      `SELECT name, prompt_hint AS "promptHint" FROM styles WHERE id = $1`, [project.style_id]);
    const sku = await videoSkuForMapping(db, project.tier_mapping_id);
    const skillId = skillRegistry.forModel(sku.model).id;
    const voicesEnabled = segmentRows.length >= 2;

    const bound = await storyAgent.bindPrompts({
      style: styleRows[0] ?? {}, ratio: project.ratio, segments, cast,
      bible: story.raw.bible, voicesEnabled, skillId,
    });
    await db.tx(async (t) => {
      for (const entry of bound) {
        const segment = segments[entry.segmentIndex];
        await t.query(
          `UPDATE segments SET final_prompt = $2 WHERE id = $1`,
          [segment.id, JSON.stringify({
            prompt: entry.prompt, imageRefs: entry.imageRefs, audioRefs: entry.audioRefs,
            usePrevTail: entry.usePrevTail, droppedRefs: entry.droppedRefs ?? 0,
            startState: entry.startState, endState: entry.endState, shots: entry.shots,
            skillId: entry.skillId, skillVersion: entry.skillVersion, degraded: entry.degraded,
          })],
        );
      }
    });
    const degradedCount = bound.filter((entry) => entry.degraded).length;
    if (degradedCount) logger.warn('project_bind_degraded', { projectId, degradedCount });
    await updateProgress(ctx.db, { projectId,
      progress: { percent: 45, message: '正在生成片段 1/' + segmentRows.length }, changed: ['segments'] });
    await ctx.enqueue({ type: 'segment.generate', payload: { projectId, idx: 0 },
      dedupeKey: `project:segment:${projectId}:0` });
    ctx.logger.info('project_bind_done', { projectId, segments: segmentRows.length, skillId });
  };
}
