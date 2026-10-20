// project.understand（docs/ARCHITECTURE.md §4）：想法判定 →（想法先扩写）→ 故事理解与片段
// 规划 → 持久化 story/cast/segments → story_review。LLM 通过注入的 storyAgent 调用；
// 引擎自带修复重试与确定性兜底，处理器只在重试耗尽的意外错误把项目置为 failed。
import { classifyInput } from '../engine/story/index.js';
import { createSkillRegistry } from '../engine/skills/index.js';
import { PermanentJobError } from '../queue/index.js';
import { newId } from '../db/ids.js';
import { transition } from './state.js';

async function selectedCharacters(db, userId, selectedIds) {
  if (!selectedIds.length) return [];
  // 数字资产库没有性别/年龄段列：引擎用名字与描述匹配，缺省性别按 unknown 处理
  const { rows } = await db.query(
    `SELECT id, name, description, default_voice_id AS "defaultVoiceId"
       FROM characters WHERE id = ANY($1) AND user_id = $2 AND deleted_at IS NULL`,
    [selectedIds, userId],
  );
  return rows.map((row) => ({ ...row, selected: true }));
}

async function activeVoices(db) {
  const { rows } = await db.query(
    `SELECT id, name, gender, age_group AS "ageGroup", description FROM voices WHERE status = 'active'
      ORDER BY sort, id`,
  );
  return rows;
}

async function styleHint(db, styleId) {
  const { rows } = await db.query(
    `SELECT name, prompt_hint AS "promptHint" FROM styles WHERE id = $1`, [styleId]);
  return rows[0] ?? null;
}

/** 档位锁定映射 → 当前生效视频 SKU：allowedDurations 与 Skill 选择都以此为准。 */
export async function videoSkuForMapping(db, tierMappingId) {
  const { rows } = await db.query(
    `SELECT s.model, s.durations FROM tier_mappings tm
       JOIN skus s ON s.sku_code = tm.video_sku_code AND s.kind = 'video' AND s.status = 'active'
      WHERE tm.id = $1 ORDER BY s.version DESC LIMIT 1`,
    [tierMappingId],
  );
  if (!rows.length) throw new PermanentJobError('档位映射没有生效的视频 SKU');
  return { model: rows[0].model, durations: rows[0].durations ?? [] };
}

/** 已勾选数字人在作品风格下的现有形象：understand 后回填 look_version_id（BE-02 约定）。 */
async function existingLookVersion(t, characterId, styleId) {
  const { rows } = await t.query(
    `SELECT lv.id FROM character_looks cl JOIN look_versions lv ON lv.id = cl.selected_version_id
      WHERE cl.character_id = $1 AND cl.style_id = $2 AND lv.status = 'succeeded'
      ORDER BY lv.created_at DESC, lv.id DESC LIMIT 1`,
    [characterId, styleId],
  );
  return rows[0]?.id ?? null;
}

// 按视频 SKU 的 model 选 Skill（与 bind_prompts 同口径，复审建议 7）
const skillRegistry = createSkillRegistry();

export function createUnderstandHandler({ db, logger, storyAgent, config }) {
  const maxAttempts = config.worker.maxAttempts ?? 5;
  return async function projectUnderstand(payload, ctx) {
    const projectId = payload.projectId;
    const { rows: current } = await db.query(
      `SELECT user_id, status FROM projects WHERE id = $1`, [projectId]);
    if (!current.length) throw new PermanentJobError('作品不存在');
    if (current[0].status !== 'understanding') {
      ctx.logger.info('project_understand_skip', { projectId, status: current[0].status });
      return; // 已取消/重分析中：幂等空转
    }
    const userId = current[0].user_id;
    try {
      await runUnderstand({ db, logger: ctx.logger, storyAgent, config, projectId, userId });
    } catch (error) {
      if (ctx.job.attempts >= maxAttempts) {
        // 重试耗尽：进入 failed，用户可重试（retry 重新入队本 job）
        await db.tx((t) => transition(t, {
          projectId, userId, from: ['understanding'], to: 'failed',
          error: { code: 'STORY_FAILED', message: '故事理解失败，请稍后重试', step: 'understanding' },
          progress: { percent: 0, message: '故事理解失败' },
        }).catch((error) => {
          if (error?.code !== 'PROJECT_STATE_INVALID') throw error; // 竞争（已取消/重分析）时放弃置败
        }));
      }
      throw error;
    }
  };
}

async function runUnderstand({ db, logger, storyAgent, config, projectId, userId }) {
  const project = (await db.query(`SELECT * FROM projects WHERE id = $1`, [projectId])).rows[0];
  const [characters, voices, style, sku] = await Promise.all([
    selectedCharacters(db, userId, project.selected_character_ids ?? []),
    activeVoices(db), styleHint(db, project.style_id), videoSkuForMapping(db, project.tier_mapping_id),
  ]);
  const maxSeconds = config.projects.maxSeconds;
  const allowedDurations = sku.durations;

  // 想法判定（确定性）：想法先扩写成剧本，之后一律按剧本忠实处理（用户 2026-10-19 决定）。
  const inputKind = classifyInput(project.story_text, { ideaCharThreshold: config.projects.ideaCharThreshold });
  let expanded = false;
  let scriptText = project.story_text;
  let expandedUsage;
  if (inputKind === 'idea') {
    const expandedResult = await storyAgent.expandIdea({
      idea: project.story_text, style, maxSeconds, allowedDurations, characters });
    scriptText = expandedResult.script;
    expanded = true;
    expandedUsage = expandedResult.usage;
    logger.info('project_idea_expanded', { projectId, degraded: expandedResult.degraded });
  }
  const skillId = skillRegistry.forModel(sku.model).id;
  const result = await storyAgent.understand({
    storyText: scriptText, inputKind, expanded, style, maxSeconds, allowedDurations, characters, voices,
    skillId,
  });
  // 平台成本核算（复审建议 6）：扩写 + 理解两次调用的 usage 累计
  const usage = { inputTokens: 0, outputTokens: 0 };
  for (const part of [expandedUsage, result.usage]) {
    usage.inputTokens += Number.isSafeInteger(part?.inputTokens) ? part.inputTokens : 0;
    usage.outputTokens += Number.isSafeInteger(part?.outputTokens) ? part.outputTokens : 0;
  }

  await db.tx(async (t) => {
    const fresh = (await t.query(`SELECT status, selected_character_ids, style_id FROM projects WHERE id = $1`,
      [projectId])).rows[0];
    if (!fresh || fresh.status !== 'understanding') return; // 竞争（已取消/重分析）：放弃本次结果
    await t.query(`DELETE FROM segments WHERE project_id = $1`, [projectId]);
    await t.query(`DELETE FROM project_cast WHERE project_id = $1`, [projectId]);
    const castIds = [];
    for (const [index, person] of result.cast.entries()) {
      const id = newId('cast');
      castIds.push(id);
      const isUserPicked = person.characterId
        && (fresh.selected_character_ids ?? []).includes(person.characterId);
      const voiceId = person.voiceId ?? null;
      const isDefaultVoice = Boolean(person.characterId && voiceId)
        && ((await t.query(`SELECT 1 FROM characters WHERE id = $1 AND default_voice_id = $2`,
          [person.characterId, voiceId])).rowCount > 0);
      const lookVersionId = person.characterId
        ? await existingLookVersion(t, person.characterId, fresh.style_id) : null;
      await t.query(
        `INSERT INTO project_cast (id, project_id, idx, name, description, gender, age_group,
           character_id, match_source, look_version_id, voice_id, voice_source)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [id, projectId, index, person.name, person.description ?? '', person.gender, person.ageGroup,
          person.characterId ?? null, person.characterId ? (isUserPicked ? 'user' : 'ai') : 'new',
          lookVersionId, voiceId, voiceId ? (isDefaultVoice ? 'default' : 'ai') : null],
      );
    }
    for (const [index, segment] of result.segments.entries()) {
      await t.query(
        `INSERT INTO segments (id, project_id, idx, duration_seconds, plot, camera_notes, dialogue,
           ambience, transition, cast_ids)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [newId('seg'), projectId, index, segment.durationSeconds, segment.plot, segment.cameraNotes ?? '',
          JSON.stringify(segment.dialogue.map((line) => ({ castId: castIds[line.castIndex], line: line.line }))),
          segment.ambience ?? '', segment.transition, segment.castIndexes.map((i) => castIds[i])],
      );
    }
    const story = {
      inputKind: result.inputKind, expanded: result.expanded, script: result.script,
      synopsis: result.synopsis, totalSeconds: result.totalSeconds, segmentCount: result.segmentCount,
      compressed: result.compressed, ...(result.notice ? { notice: result.notice } : {}),
      usage, // LLM 用量（扩写 + 理解累计；LLM 费用平台承担，仅内部核算）
      raw: result, // 引擎原始输出（bible/每段 endState/takeMode 等，bind_prompts 直接消费）
    };
    await t.query(
      `UPDATE projects SET story = $2, title = CASE WHEN title = '' THEN $3 ELSE title END,
         updated_at = now() WHERE id = $1`,
      [projectId, JSON.stringify(story), result.title],
    );
    await transition(t, { projectId, userId, from: ['understanding'], to: 'story_review',
      progress: { percent: 15, message: '故事已就绪，等待你确认' },
      changed: ['story', 'cast', 'segments'] });
  });
  logger.info('project_understood', { projectId, degraded: result.degraded,
    compressed: result.compressed, segments: result.segmentCount });
}
