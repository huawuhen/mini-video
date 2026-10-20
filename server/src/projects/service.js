// 作品服务（docs/API.md §6；本任务先提供服务层，HTTP 路由与 SSE 属 M1-BE-06）。
// 创建幂等：同用户同幂等键重放返回同一作品、不重复消耗免费次数；免费次数按北京日计数。
import { newId } from '../db/ids.js';
import { appError } from '../http/errors.js';
import { enqueue } from '../queue/index.js';
import { transition, requireProject, groupOf } from './state.js';
import { projectMoneySummary, videoUnitFen } from './money.js';

/** 作品详情（API §6.2 ProjectDetail）：story 去掉引擎原始输出，cast/segments/takes/render 聚合。 */
export async function getProjectDetail(db, { userId, projectId, urlFor }) {
  const project = await requireProject(db, { userId, projectId });
  const storyRow = project.story ?? {};
  const { raw, ...story } = storyRow;
  const { rows: castRows } = await db.query(
    `SELECT pc.*, lv.status AS look_status, lv.image_key AS look_image_key,
            gt.status AS gen_status, c.default_voice_id
       FROM project_cast pc
       LEFT JOIN look_versions lv ON lv.id = pc.look_version_id
       LEFT JOIN gen_tasks gt ON gt.id = lv.gen_task_id
       LEFT JOIN characters c ON c.id = pc.character_id
      WHERE pc.project_id = $1 ORDER BY pc.idx`, [projectId]);
  const cast = [];
  for (const [index, row] of castRows.entries()) {
    const member = {
      id: row.id, name: row.name, description: row.description,
      gender: row.gender, ageGroup: row.age_group,
      ...(row.character_id ? { characterId: row.character_id } : {}),
      matchSource: row.match_source,
    };
    if (row.look_version_id && row.look_status === 'succeeded') {
      member.look = { status: 'ready', versionId: row.look_version_id,
        ...(row.look_image_key && urlFor ? { imageUrl: urlFor(row.look_image_key) } : {}),
        versions: [] };
    } else if (row.look_version_id && ['created', 'submitting', 'running'].includes(row.gen_status)) {
      member.look = { status: 'generating', versionId: row.look_version_id, versions: [] };
    } else if (row.look_version_id && row.look_status === 'failed') {
      member.look = { status: 'failed', versionId: row.look_version_id, versions: [] };
    } else {
      member.look = { status: 'missing', versions: [] };
    }
    if (row.voice_id) member.voice = { voiceId: row.voice_id, source: row.voice_source ?? 'ai' };
    cast.push(member);
  }
  const { rows: segmentRows } = await db.query(
    `SELECT * FROM segments WHERE project_id = $1 ORDER BY idx`, [projectId]);
  const segments = [];
  for (const row of segmentRows) {
    const { rows: takeRows } = await db.query(
      `SELECT * FROM segment_takes WHERE segment_id = $1 ORDER BY created_at, id`, [row.id]);
    segments.push({
      id: row.id, index: row.idx, durationSeconds: row.duration_seconds,
      plot: row.plot,
      dialogue: row.dialogue ?? [],
      transition: row.transition, castIds: row.cast_ids ?? [],
      ...(row.selected_take_id ? { selectedTakeId: row.selected_take_id } : {}),
      takes: takeRows.map((take) => ({
        id: take.id, status: take.status,
        ...(take.video_key && urlFor ? { videoUrl: urlFor(take.video_key) } : {}),
        ...(take.poster_key && urlFor ? { posterUrl: urlFor(take.poster_key) } : {}),
        ...(take.error?.message ? { error: take.error.message } : {}),
        createdAt: take.created_at.toISOString(),
      })),
    });
  }
  const { rows: renderRows } = await db.query(
    `SELECT * FROM renders WHERE project_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`, [projectId]);
  const renderRow = renderRows[0];
  const detail = {
    id: project.id, title: project.title, status: project.status, group: groupOf(project.status),
    storyText: project.story_text, sourceType: project.source_type,
    styleId: project.style_id, qualityTierId: project.quality_tier_id, ratio: project.ratio,
    progress: project.progress ?? { percent: 0, message: '' },
    createdAt: project.created_at.toISOString(), updatedAt: project.updated_at.toISOString(),
    ...(project.paused_from ? { pausedFrom: project.paused_from } : {}),
    ...(project.error ? { error: project.error } : {}),
    ...(project.story ? { story } : {}),
    cast,
    segments,
    voicesEnabled: segmentRows.length >= 2,
    ...(project.delivered_at ? { deliveredAt: project.delivered_at.toISOString() } : {}),
    ...(project.expires_at ? { expiresAt: project.expires_at.toISOString() } : {}),
    ...(renderRow ? { render: {
      id: renderRow.id, status: renderRow.status,
      ...(renderRow.video_key && urlFor ? { videoUrl: urlFor(renderRow.video_key) } : {}),
      ...(renderRow.cover_key && urlFor ? { coverUrl: urlFor(renderRow.cover_key) } : {}),
      ...(renderRow.duration_seconds ? { durationSeconds: renderRow.duration_seconds } : {}),
      createdAt: renderRow.created_at.toISOString(),
    } } : {}),
  };
  detail.pricing = await buildPricing(db, { userId, project });
  return detail;
}

/** 北京时间（UTC+8）当日零点对应的 UTC 时刻；免费次数按此切日（用户 2026-10-19 决定）。 */
export function beijingDayStartUtc(now = new Date()) {
  return new Date(Math.floor((now.getTime() + 8 * 3_600_000) / 86_400_000) * 86_400_000 - 8 * 3_600_000);
}

/** 消耗 1 次当日免费故事理解（创建与重新整理各计 1 次）；超出抛 429。 */
export async function consumeFreeQuota(t, { userId, max }) {
  const windowStart = beijingDayStartUtc();
  const { rows } = await t.query(
    `INSERT INTO rate_counters (key, window_start, count) VALUES ($1, $2, 1)
      ON CONFLICT (key, window_start) DO UPDATE SET count = rate_counters.count + 1 RETURNING count`,
    [`free_quota:${userId}`, windowStart],
  );
  if (rows[0].count > max) {
    const retryAfterSeconds = Math.max(1, Math.ceil((windowStart.getTime() + 86_400_000 - Date.now()) / 1000));
    throw appError('FREE_QUOTA_EXHAUSTED', '今天的免费故事理解次数已用完，明天再来吧', { retryAfterSeconds });
  }
}

function assertStoryText(storyText) {
  const value = typeof storyText === 'string' ? storyText.trim() : '';
  if (!value) throw appError('STORY_TOO_SHORT', '故事内容不能为空');
  if (value.length > 3000) throw appError('STORY_TOO_LONG', '故事最长 3000 字');
  return value;
}

async function requireActiveStyle(t, styleId) {
  const { rows } = await t.query(`SELECT id FROM styles WHERE id = $1 AND status = 'active'`, [styleId]);
  if (!rows.length) throw appError('VALIDATION_FAILED', undefined, { fields: { styleId: '取值不正确' } });
}

async function requireActiveTier(t, tierId) {
  const { rows } = await t.query(`SELECT id FROM quality_tiers WHERE id = $1 AND status = 'active'`, [tierId]);
  if (!rows.length) throw appError('VALIDATION_FAILED', undefined, { fields: { qualityTierId: '取值不正确' } });
}

/** 创建时锁定档位映射版本（PRD 4.6）：之后取价与时长都用这一版。 */
async function lockTierMapping(t, tierId) {
  const { rows } = await t.query(
    `SELECT id FROM tier_mappings WHERE tier_id = $1 ORDER BY version DESC LIMIT 1`, [tierId]);
  if (!rows.length) throw appError('VALIDATION_FAILED', undefined, { fields: { qualityTierId: '该画质暂不可用' } });
  return rows[0].id;
}

async function requireOwnCharacters(t, userId, characterIds) {
  if (!characterIds.length) return;
  const { rows } = await t.query(
    `SELECT id FROM characters WHERE id = ANY($1) AND user_id = $2 AND deleted_at IS NULL`,
    [characterIds, userId],
  );
  if (rows.length !== new Set(characterIds).size) {
    throw appError('VALIDATION_FAILED', undefined, { fields: { characterIds: '包含不存在或不可用的数字人' } });
  }
}

/**
 * 创建作品（API §6.1）：校验 → 消耗 1 次免费次数 → 插入 understanding → 入队 project.understand。
 * 同幂等键并发先取 advisory 锁再查重放；重放不消耗次数。
 */
export async function createProject(db, { userId, input, config }) {
  const storyText = assertStoryText(input.storyText);
  if (!['text', 'file'].includes(input.sourceType)) {
    throw appError('VALIDATION_FAILED', undefined, { fields: { sourceType: '取值不正确' } });
  }
  const ratio = input.ratio ?? '9:16';
  if (!['9:16', '16:9', '1:1'].includes(ratio)) {
    throw appError('VALIDATION_FAILED', undefined, { fields: { ratio: '取值不正确' } });
  }
  const characterIds = [...new Set(input.characterIds ?? [])];
  return db.tx(async (t) => {
    const replayKey = `project.create:${userId}:${input.idempotencyKey}`;
    await t.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [replayKey]);
    const { rows: replayed } = await t.query(
      `SELECT id FROM projects WHERE user_id = $1 AND idempotency_key = $2 AND deleted_at IS NULL`,
      [userId, input.idempotencyKey],
    );
    if (replayed.length) return { replayed: true, projectId: replayed[0].id };
    await requireActiveStyle(t, input.styleId);
    await requireActiveTier(t, input.qualityTierId);
    await requireOwnCharacters(t, userId, characterIds);
    await consumeFreeQuota(t, { userId, max: config.projects.freeDailyQuota });
    const tierMappingId = await lockTierMapping(t, input.qualityTierId);
    const id = newId('prj');
    await t.query(
      `INSERT INTO projects (id, user_id, story_text, source_type, style_id, quality_tier_id,
         tier_mapping_id, ratio, status, selected_character_ids, idempotency_key, progress)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'understanding', $9, $10, $11)`,
      [id, userId, storyText, input.sourceType, input.styleId, input.qualityTierId, tierMappingId,
        ratio, characterIds, input.idempotencyKey,
        JSON.stringify({ percent: 10, message: '正在理解故事、规划片段' })],
    );
    await t.query(
      `INSERT INTO project_events (project_id, status, progress) VALUES ($1, 'understanding', $2)`,
      [id, JSON.stringify({ percent: 10, message: '正在理解故事、规划片段' })],
    );
    await t.query(`SELECT pg_notify('project_events', $1)`,
      [JSON.stringify({ projectId: id, status: 'understanding' })]);
    await enqueue(t, { type: 'project.understand', payload: { projectId: id }, dedupeKey: `project:understand:${id}` });
    return { replayed: false, projectId: id };
  });
}

/** 重新整理（确认点 A）：消耗 1 次免费次数、按剧本处理（不再扩写）、清空旧规划后重跑。 */
export async function reanalyzeProject(db, { userId, projectId, storyText, config }) {
  const text = assertStoryText(storyText);
  return db.tx(async (t) => {
    const project = await requireProject(t, { userId, projectId });
    if (project.status !== 'story_review') throw appError('PROJECT_STATE_INVALID');
    await t.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`project:reanalyze:${projectId}`]);
    await consumeFreeQuota(t, { userId, max: config.projects.freeDailyQuota });
    await t.query(`DELETE FROM segments WHERE project_id = $1`, [projectId]);
    await t.query(`DELETE FROM project_cast WHERE project_id = $1`, [projectId]);
    await t.query(`UPDATE projects SET story_text = $2, story = NULL, updated_at = now() WHERE id = $1`,
      [projectId, text]);
    await transition(t, { projectId, userId, from: ['story_review'], to: 'understanding',
      progress: { percent: 10, message: '正在按你的修改重新理解故事' }, changed: ['story'] });
    await enqueue(t, { type: 'project.understand', payload: { projectId }, dedupeKey: `project:understand:${projectId}:rev` });
    return { ok: true };
  });
}

/** Pricing（API §6.2）：形象缺口按当前图片 SKU 计价，视频按锁定档位映射的当前 SKU 计价。 */
export async function buildPricing(t, { userId, project }) {
  const { rows: cast } = await t.query(
    `SELECT look_version_id FROM project_cast WHERE project_id = $1`, [project.id]);
  const { rows: segments } = await t.query(
    `SELECT duration_seconds FROM segments WHERE project_id = $1 ORDER BY idx`, [project.id]);
  const { rows: imageSku } = await t.query(
    `SELECT price_fen FROM skus WHERE kind = 'image' AND status = 'active'
      ORDER BY version DESC, effective_at DESC LIMIT 1`);
  const unit = await videoUnitFen(t, project.tier_mapping_id);
  const looksToGenerate = cast.filter((member) => !member.look_version_id).length;
  const looksFen = looksToGenerate * (imageSku[0]?.price_fen ?? 0);
  const videoFen = segments.reduce((sum, segment) => sum + segment.duration_seconds, 0) * unit;
  const money = await projectMoneySummary(t, { userId, projectId: project.id });
  return {
    looksToGenerate, looksFen, videoFen, totalFen: looksFen + videoFen,
    reservedFen: money.reservedFen, settledFen: money.settledFen, refundedFen: money.refundedFen,
  };
}
