// 作品服务（docs/API.md §6；本任务先提供服务层，HTTP 路由与 SSE 属 M1-BE-06）。
// 创建幂等：同用户同幂等键重放返回同一作品、不重复消耗免费次数；免费次数按北京日计数。
import { newId } from '../db/ids.js';
import { appError } from '../http/errors.js';
import { enqueue } from '../queue/index.js';
import { createLookVersion } from '../characters/service.js';
import { consumeQuote } from '../wallet/pricing.js';
import { transition, requireProject, groupOf, appendEvent, GROUPS } from './state.js';
import { projectMoneySummary, videoUnitFen, reserveProjectLooks, reserveProjectVideo, refundProject } from './money.js';

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
export async function createProject(db, { userId, input, config, channelRouter = null }) {
  // M2-BE-03：用户侧门禁——无生效 LLM 渠道时创建即报 NO_ACTIVE_CHANNEL（503，明确中文文案）；
  // mock 链路（无 router）不拦截。放在事务外：pickRow 只读渠道表，无上游调用。
  if (channelRouter) await channelRouter.pick('llm');
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
    if (replayed.length) {
      // 同键不同内容：拒绝，避免静默拿到旧行
      const { rows: existing } = await t.query(`SELECT * FROM projects WHERE id = $1`, [replayed[0].id]);
      const same = existing[0]
        && existing[0].story_text === storyText
        && existing[0].style_id === input.styleId
        && existing[0].quality_tier_id === input.qualityTierId
        && existing[0].ratio === ratio
        && JSON.stringify(existing[0].selected_character_ids ?? []) === JSON.stringify(characterIds);
      if (!same) throw appError('IDEMPOTENCY_CONFLICT', '相同的幂等键已被不同的创建请求使用');
      return { replayed: true, projectId: replayed[0].id };
    }
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

/** 数字人在指定风格下当前选中的成功形象；无则 null。 */
async function existingLookVersionId(t, characterId, styleId) {
  const { rows } = await t.query(
    `SELECT lv.id FROM character_looks cl JOIN look_versions lv ON lv.id = cl.selected_version_id
      WHERE cl.character_id = $1 AND cl.style_id = $2 AND lv.status = 'succeeded'
      ORDER BY lv.created_at DESC, lv.id DESC LIMIT 1`,
    [characterId, styleId],
  );
  return rows[0]?.id ?? null;
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
  // M2-BE-04③（API 2026-10-31 新增 looksPaidFen）：本作品已结算的形象费——
  // 确认点 B「角色形象（已支付）」显示它（此前显示 looksFen=待生成费，交付前恒 0，误导）
  const { rows: lookSettled } = await t.query(
    `SELECT COALESCE(SUM(l.amount_fen), 0)::int AS fen FROM ledger l
       JOIN look_versions lv ON l.ref_id = lv.id
       JOIN project_cast pc ON pc.look_version_id = lv.id
      WHERE pc.project_id = $1 AND l.kind = 'settle' AND l.ref_type = 'look'`,
    [project.id]);
  return {
    looksToGenerate, looksFen, looksPaidFen: lookSettled[0]?.fen ?? 0,
    videoFen, totalFen: looksFen + videoFen,
    reservedFen: money.reservedFen, settledFen: money.settledFen, refundedFen: money.refundedFen,
    frozenFen: money.frozenFen,
  };
}

// ───────────── 确认点 A（API §6.3）─────────────

/** 幂等确认：同作品同步骤同幂等键重放返回 { replayed: true }；新键登记后继续。 */
async function claimConfirm(t, { projectId, step, idempotencyKey }) {
  const { rows } = await t.query(
    `INSERT INTO project_confirm_log (id, project_id, step, idempotency_key)
     VALUES ($1, $2, $3, $4) ON CONFLICT (project_id, step, idempotency_key) DO NOTHING RETURNING id`,
    [newId('prj'), projectId, step, idempotencyKey],
  );
  return { replayed: rows.length === 0 };
}

/** 为「将新建」的角色建数字人（PRD：故事确认后对未匹配角色自动新建），返回 castId → characterId。 */
async function createCharactersForNewCast(t, { userId, projectId }) {
  const { rows: newCast } = await t.query(
    `SELECT id, name, description FROM project_cast
      WHERE project_id = $1 AND character_id IS NULL ORDER BY idx`,
    [projectId],
  );
  const map = new Map();
  for (const member of newCast) {
    const characterId = newId('chr');
    await t.query(
      `INSERT INTO characters (id, user_id, name, description) VALUES ($1, $2, $3, $4)`,
      [characterId, userId, member.name, member.description ?? ''],
    );
    await t.query(`UPDATE project_cast SET character_id = $2 WHERE id = $1`, [member.id, characterId]);
    map.set(member.id, characterId);
  }
  return map;
}

/**
 * 确认故事（API §6.3）：未匹配角色自动新建数字人 → 缺形象的角色按 cast_looks 报价扣形象费并
 * 预占 → 为每个缺口建 look_versions/gen_tasks 并入队 look.generate；缺口为 0 直接 cast_review。
 */
export async function confirmStory(db, { userId, projectId, quoteId, idempotencyKey, config, urlFor, channelRouter = null }) {
  if (channelRouter) await channelRouter.pick('image'); // 缺口形象将生成：无生效图片渠道提前明确报错
  return db.tx(async (t) => {
    const project = await requireProject(t, { userId, projectId });
    await t.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`project:confirm:${projectId}`]);
    // 幂等重放先于状态校验：同键重放即使状态已推进也返回成功（手机双击/重试不报错）
    const { replayed } = await claimConfirm(t, { projectId, step: 'story', idempotencyKey });
    if (replayed) return { replayed: true, projectId };
    if (project.status !== 'story_review') throw appError('PROJECT_STATE_INVALID');

    await createCharactersForNewCast(t, { userId, projectId });
    const { rows: missing } = await t.query(
      `SELECT pc.id AS cast_id, pc.character_id, c.name, c.description,
              COALESCE(c.default_voice_id, NULL) AS default_voice_id
         FROM project_cast pc LEFT JOIN characters c ON c.id = pc.character_id
        WHERE pc.project_id = $1 AND pc.look_version_id IS NULL ORDER BY pc.idx`,
      [projectId],
    );
    if (missing.length) {
      if (!quoteId) throw appError('VALIDATION_FAILED', '需要先获取形象生成报价', undefined);
      const { quote } = await consumeQuote(t, { userId, quoteId, kind: 'cast_looks', refType: 'project', refId: projectId });
      const amountFen = quote.amount_fen;
      await reserveProjectLooks(t, { userId, projectId, amountFen });
      const { rows: styleRows } = await t.query(`SELECT prompt_hint FROM styles WHERE id = $1`, [project.style_id]);
      const { rows: imageSku } = await t.query(
        `SELECT sku_code, version, price_fen FROM skus WHERE kind = 'image' AND status = 'active'
          ORDER BY version DESC, effective_at DESC LIMIT 1`);
      for (const member of missing) {
        const { rows: photos } = await t.query(
          `SELECT up.storage_key FROM character_photos cp JOIN uploads up ON up.id = cp.upload_id
            WHERE cp.character_id = $1 ORDER BY cp.sort, cp.id`, [member.character_id]);
        const versionId = newId('lkv');
        const genTaskId = newId('gt');
        const replayKey = `project:${projectId}:look:${member.cast_id}`;
        await t.query(
          `INSERT INTO gen_tasks (id, user_id, kind, sku_code, sku_version, provider, status, request, idempotency_key)
           VALUES ($1, $2, 'image', $3, $4, 'unassigned', 'created', $5, $6)`,
          [genTaskId, userId, imageSku[0].sku_code, imageSku[0].version, JSON.stringify({
            versionId, characterId: member.character_id, styleId: project.style_id,
            storageKey: `users/${userId}/looks/${versionId}.png`,
            amountFen: imageSku[0].price_fen, promptHint: styleRows[0]?.prompt_hint ?? '',
            description: member.description ?? '', referenceKeys: photos.map((row) => row.storage_key),
            skuCode: imageSku[0].sku_code, // M2-BE-01：look.generate 按此解析真实分辨率（ENG-02 遗留项）
          }), replayKey],
        );
        await t.query(
          `INSERT INTO character_looks (id, character_id, style_id) VALUES ($1, $2, $3)
           ON CONFLICT (character_id, style_id) DO NOTHING`,
          [newId('look'), member.character_id, project.style_id],
        );
        await t.query(
          `INSERT INTO look_versions (id, look_id, gen_task_id, status)
           SELECT $1, cl.id, $2, 'pending' FROM character_looks cl
            WHERE cl.character_id = $3 AND cl.style_id = $4`,
          [versionId, genTaskId, member.character_id, project.style_id],
        );
        await t.query(`UPDATE project_cast SET look_version_id = $2 WHERE id = $1`, [member.cast_id, versionId]);
        await enqueue(t, { type: 'look.generate', payload: { versionId }, dedupeKey: `look:${versionId}` });
      }
      await transition(t, { projectId, userId, from: ['story_review'], to: 'casting',
        progress: { percent: 30, message: '正在生成角色形象' }, changed: ['cast', 'pricing'] });
    } else {
      await transition(t, { projectId, userId, from: ['story_review'], to: 'cast_review',
        progress: { percent: 40, message: '角色已就绪，等待你确认' }, changed: ['cast', 'pricing'] });
    }
    return { replayed: false, projectId };
  });
}

/** 纠正匹配（API §6.3）：story_review 时改绑数字人；null 表示确认点后新建。 */
export async function updateCastCharacter(db, { userId, projectId, castId, characterId }) {
  return db.tx(async (t) => {
    const project = await requireProject(t, { userId, projectId });
    if (characterId) {
      const { rows } = await t.query(
        `SELECT id FROM characters WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
        [characterId, userId]);
      if (!rows.length) throw appError('NOT_FOUND');
    }
    const lookVersionId = characterId
      ? await existingLookVersionId(t, characterId, project.style_id)
      : null;
    const { rowCount } = await t.query(
      `UPDATE project_cast SET character_id = $3, match_source = $4, look_version_id = $5
        WHERE id = $1 AND project_id = $2 AND (SELECT status FROM projects WHERE id = $2) = 'story_review'`,
      [castId, projectId, characterId, characterId ? 'user' : 'new', lookVersionId],
    );
    if (!rowCount) throw appError('PROJECT_STATE_INVALID');
    await appendEvent(t, { projectId, status: 'story_review',
      progress: { percent: 15, message: '故事已就绪，等待你确认' }, changed: ['cast'] });
    return { ok: true };
  });
}

// ───────────── 确认点 B 前置：角色形象/声音调整（API §6.4 的读侧与纠正）─────────────
// （PUT /cast/:castId 与 cast looks 属确认点 B，C4 实现。）

// ───────────── 确认点 B（API §6.4）─────────────

async function requireSegmentCount(db, projectId) {
  const { rows } = await db.query(`SELECT count(*)::int AS n FROM segments WHERE project_id = $1`, [projectId]);
  return rows[0].n;
}

/** 调整角色（API §6.4 PUT /cast/:castId）：绑定形象版本与音色；确认（locked_at）后不可改。 */
export async function updateCast(db, { userId, projectId, castId, lookVersionId, voiceId }) {
  return db.tx(async (t) => {
    const project = await requireProject(t, { userId, projectId });
    if (project.status !== 'cast_review') throw appError('PROJECT_STATE_INVALID');
    const { rows: castRows } = await t.query(
      `SELECT * FROM project_cast WHERE id = $1 AND project_id = $2`, [castId, projectId]);
    if (!castRows.length) throw appError('NOT_FOUND');
    const cast = castRows[0];
    if (cast.locked_at) throw appError('PROJECT_STATE_INVALID', '确认后角色已锁定');

    if (lookVersionId !== undefined) {
      if (lookVersionId === null) {
        await t.query(`UPDATE project_cast SET look_version_id = NULL WHERE id = $1`, [castId]);
      } else {
        const { rows } = await t.query(
          `SELECT lv.id FROM look_versions lv JOIN character_looks cl ON cl.id = lv.look_id
            WHERE lv.id = $1 AND cl.character_id = $2 AND cl.style_id = $3 AND lv.status = 'succeeded'`,
          [lookVersionId, cast.character_id, project.style_id]);
        if (!rows.length) throw appError('VALIDATION_FAILED', '只能选择该角色生成成功的形象版本');
        await t.query(`UPDATE project_cast SET look_version_id = $2 WHERE id = $1`, [castId, lookVersionId]);
      }
    }
    if (voiceId !== undefined) {
      const segmentCount = await requireSegmentCount(t, projectId);
      if (segmentCount < 2) {
        throw appError('VALIDATION_FAILED', '单片段作品不使用参考声音');
      }
      if (voiceId !== null) {
        const { rows } = await t.query(`SELECT id FROM voices WHERE id = $1 AND status = 'active'`, [voiceId]);
        if (!rows.length) throw appError('VALIDATION_FAILED', undefined, { fields: { voiceId: '取值不正确' } });
      }
      try {
        await t.query(`UPDATE project_cast SET voice_id = $2, voice_source = 'user' WHERE id = $1`,
          [castId, voiceId]);
      } catch (error) {
        // 同一作品两个角色不能用同一音色（project_cast_voice_uniq 唯一索引）
        if (error?.code === '23505') throw appError('VOICE_DUPLICATED', '该声音已被本作品其他角色使用');
        throw error;
      }
    }
    await appendEvent(t, { projectId, status: 'cast_review',
      progress: { percent: 40, message: '角色已就绪，等待你确认' }, changed: ['cast'] });
    return { ok: true };
  });
}

/** 确认角色（API §6.4）：校验形象/音色齐备 → consumeQuote(project_render) + 预占视频费 →
 * 锁定 cast → rendering，入队 project.bind_prompts。 */
export async function confirmCast(db, { userId, projectId, quoteId, idempotencyKey, config, channelRouter = null }) {
  if (channelRouter) await channelRouter.pick('video'); // 视频费预占前：无生效视频渠道明确报错（不预占）
  return db.tx(async (t) => {
    const project = await requireProject(t, { userId, projectId });
    await t.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`project:confirm:${projectId}`]);
    const { replayed } = await claimConfirm(t, { projectId, step: 'cast', idempotencyKey });
    if (replayed) return { replayed: true, projectId };
    if (project.status !== 'cast_review') throw appError('PROJECT_STATE_INVALID');

    const { rows: cast } = await t.query(
      `SELECT pc.id, pc.voice_id, lv.status AS look_status
         FROM project_cast pc
         LEFT JOIN look_versions lv ON lv.id = pc.look_version_id
        WHERE pc.project_id = $1 ORDER BY pc.idx`, [projectId]);
    const notReady = cast.filter((member) => member.look_status !== 'succeeded');
    if (notReady.length) throw appError('VALIDATION_FAILED', '还有角色形象未就绪，请等待生成或重新选择');
    const segmentCount = await requireSegmentCount(t, projectId);
    const voicesEnabled = segmentCount >= 2;
    if (voicesEnabled && cast.some((member) => !member.voice_id)) {
      throw appError('VALIDATION_FAILED', '请为每个角色选择声音');
    }
    if (!quoteId) throw appError('VALIDATION_FAILED', '需要先获取视频生成报价');

    const { quote } = await consumeQuote(t, { userId, quoteId, kind: 'project_render', refType: 'project', refId: projectId });
    await reserveProjectVideo(t, { userId, projectId, amountFen: quote.amount_fen });
    await t.query(`UPDATE project_cast SET locked_at = now() WHERE project_id = $1`, [projectId]);
    await transition(t, { projectId, userId, from: ['cast_review'], to: 'rendering',
      progress: { percent: 45, message: `正在生成片段 1/${segmentCount}` }, changed: ['pricing'] });
    await enqueue(t, { type: 'project.bind_prompts', payload: { projectId },
      dedupeKey: `project:bind:${projectId}` });
    return { replayed: false, projectId };
  });
}

/** 确认点 B 重新生成形象（API §6.4 POST /cast/:castId/looks，kind=look_regenerate 作品风格）。
 * 复用 BE-04 的 createLookVersion（报价、预占、gen_tasks、自动选中、写数字资产库）；
 * 新版本绑定到作品角色仍由 updateCast 完成。 */
export async function createCastLook(db, { userId, projectId, castId, quoteId, idempotencyKey, urlFor }) {
  const project = await requireProject(db, { userId, projectId });
  if (project.status !== 'cast_review') throw appError('PROJECT_STATE_INVALID');
  const { rows } = await db.query(
    `SELECT character_id FROM project_cast WHERE id = $1 AND project_id = $2`, [castId, projectId]);
  if (!rows.length || !rows[0].character_id) throw appError('NOT_FOUND');
  const { version } = await createLookVersion(db, { userId, characterId: rows[0].character_id,
    styleId: project.style_id, quoteId, idempotencyKey, urlFor });
  return { version };
}

// ───────────── 进行中控制（API §6.5）─────────────

const RESUMABLE = {
  understanding: async (db, t, project) => {
    await enqueue(t, { type: 'project.understand', payload: { projectId: project.id },
      dedupeKey: `project:understand:${project.id}:resume` });
  },
  casting: async (db, t, project) => {
    // 形象可能已全部生成（暂停期间完成）：推进检查；否则停留等待（不会有了——生成已停，
    // 需 retry 补生成；此处仅处理「暂停期间完成」的正常情形）
    const { rows: missing } = await t.query(
      `SELECT 1 FROM project_cast WHERE project_id = $1 AND look_version_id IS NULL LIMIT 1`, [project.id]);
    if (!missing.length) {
      await transition(t, { projectId: project.id, userId: project.user_id, from: ['casting'],
        to: 'cast_review', progress: { percent: 40, message: '角色已就绪，等待你确认' }, changed: ['cast'] });
    }
  },
  rendering: async (db, t, project) => {
    // 从第一个未成功的片段续跑（bind 未做则先 bind）
    const { rows: bindMissing } = await t.query(
      `SELECT 1 FROM segments WHERE project_id = $1 AND final_prompt IS NULL LIMIT 1`, [project.id]);
    if (bindMissing.length) {
      await enqueue(t, { type: 'project.bind_prompts', payload: { projectId: project.id },
        dedupeKey: `project:bind:${project.id}:resume` });
      return;
    }
    const { rows: next } = await t.query(
      `SELECT idx FROM segments WHERE project_id = $1 ORDER BY idx`, [project.id]);
    for (const segment of next) {
      const { rows: takes } = await t.query(
        `SELECT status FROM segment_takes WHERE segment_id = (
           SELECT id FROM segments WHERE project_id = $1 AND idx = $2)`,
        [project.id, segment.idx]);
      if (!takes.some((take) => take.status === 'succeeded')) {
        const { rows: running } = await t.query(
          `SELECT 1 FROM segment_takes WHERE segment_id = (
             SELECT id FROM segments WHERE project_id = $1 AND idx = $2)
             AND status IN ('pending', 'running')`,
          [project.id, segment.idx]);
        if (!running.length && segment.idx > 0) {
          await enqueue(t, { type: 'segment.generate', payload: { projectId: project.id, idx: segment.idx } });
        }
        if (!running.length && segment.idx === 0) {
          await enqueue(t, { type: 'segment.generate', payload: { projectId: project.id, idx: 0 } });
        }
        break; // 串行：只续跑第一个未成功的片段
      }
    }
  },
  composing: async (db, t, project) => {
    await enqueue(t, { type: 'project.compose', payload: { projectId: project.id },
      dedupeKey: `project:compose:${project.id}:resume` });
  },
};

export async function pauseProject(db, { userId, projectId }) {
  return db.tx(async (t) => {
    const project = await requireProject(t, { userId, projectId });
    await transition(t, { projectId, userId, from: ['understanding', 'casting', 'rendering'], to: 'paused',
      pausedFrom: project.status, progress: { percent: project.progress?.percent ?? 0, message: '已暂停' } });
    return { ok: true };
  });
}

export async function resumeProject(db, { userId, projectId }) {
  return db.tx(async (t) => {
    const project = await requireProject(t, { userId, projectId });
    const from = project.paused_from;
    if (!from) throw appError('PROJECT_STATE_INVALID');
    await transition(t, { projectId, userId, from: ['paused'], to: from,
      progress: null, changed: [] });
    const kick = RESUMABLE[from];
    if (kick) await kick(db, t, { ...project, status: from });
    return { ok: true };
  });
}

export async function retryProject(db, { userId, projectId }) {
  return db.tx(async (t) => {
    const project = await requireProject(t, { userId, projectId });
    if (project.status !== 'failed') throw appError('PROJECT_STATE_INVALID');
    const step = project.error?.step ?? 'rendering';
    // 提交结果未知（unknown）的片段/形象：金额保持冻结、绝不重提（上游可能已受理，重提=双倍生成）。
    // 用户只能 cancel 拿回未冻结部分；冻结部分等 M2 对账。
    if (step === 'rendering' || step === 'casting') {
      const unknownSql = step === 'rendering'
        ? `SELECT 1 FROM segment_takes t JOIN segments s ON s.id = t.segment_id
            WHERE s.project_id = $1 AND t.status = 'unknown' LIMIT 1`
        : `SELECT 1 FROM gen_tasks gt
            JOIN look_versions lv ON lv.gen_task_id = gt.id
            JOIN project_cast pc ON pc.look_version_id = lv.id
           WHERE pc.project_id = $1 AND gt.status = 'unknown' LIMIT 1`;
      const { rows: unknownRows } = await t.query(unknownSql, [projectId]);
      if (unknownRows.length) {
        throw appError('PROJECT_STATE_INVALID',
          step === 'rendering' ? '该片段结果待核对，请联系客服' : '该形象结果待核对，请联系客服');
      }
    }
    // 恢复到失败步骤（失败金额按 A 口径保持冻结，重试成功后照常结算）
    await transition(t, { projectId, userId, from: ['failed'], to: step,
      progress: null, changed: [] });
    if (step === 'understanding') {
      await enqueue(t, { type: 'project.understand', payload: { projectId },
        dedupeKey: `project:understand:${projectId}:retry` });
    } else if (step === 'casting') {
      // 为失败的形象版本补建新版本（amountFen=0：钱已在失败时退回，平台承担），
      // 并从失败版本的原始请求复制 description/referenceKeys/promptHint，保证生成一致
      const { rows: failedCasts } = await t.query(
        `SELECT pc.id AS cast_id, pc.character_id, lv.id AS failed_version_id, gt.request AS original_request
           FROM project_cast pc JOIN look_versions lv ON lv.id = pc.look_version_id
           JOIN gen_tasks gt ON gt.id = lv.gen_task_id
          WHERE pc.project_id = $1 AND lv.status = 'failed' ORDER BY pc.idx`, [projectId]);
      const { rows: styleRows } = await t.query(`SELECT prompt_hint FROM styles WHERE id = $1`, [project.style_id]);
      const { rows: imageSku } = await t.query(
        `SELECT sku_code, version FROM skus WHERE kind = 'image' AND status = 'active'
          ORDER BY version DESC, effective_at DESC LIMIT 1`);
      for (const member of failedCasts) {
        const original = typeof member.original_request === 'string'
          ? JSON.parse(member.original_request) : member.original_request ?? {};
        const versionId = newId('lkv');
        const genTaskId = newId('gt');
        await t.query(
          `INSERT INTO gen_tasks (id, user_id, kind, sku_code, sku_version, provider, status, request, idempotency_key)
           VALUES ($1, $2, 'image', $3, $4, 'unassigned', 'created', $5, $6)`,
          [genTaskId, userId, imageSku[0].sku_code, imageSku[0].version, JSON.stringify({
            versionId, characterId: member.character_id, styleId: project.style_id,
            storageKey: `users/${userId}/looks/${versionId}.png`, amountFen: 0,
            promptHint: original.promptHint ?? styleRows[0]?.prompt_hint ?? '',
            description: original.description ?? '',
            referenceKeys: original.referenceKeys ?? [],
            skuCode: original.skuCode ?? imageSku[0].sku_code, // 与失败版本同 SKU，保持生成一致
          }), `project:${projectId}:look:${member.cast_id}:${member.failed_version_id}`],
        );
        await t.query(
          `INSERT INTO look_versions (id, look_id, gen_task_id, status)
           SELECT $1, cl.id, $2, 'pending' FROM character_looks cl
            WHERE cl.character_id = $3 AND cl.style_id = $4`,
          [versionId, genTaskId, member.character_id, project.style_id],
        );
        await t.query(`UPDATE project_cast SET look_version_id = $2 WHERE id = $1`, [member.cast_id, versionId]);
        await enqueue(t, { type: 'look.generate', payload: { versionId }, dedupeKey: `look:${versionId}` });
      }
    } else if (step === 'rendering') {
      // 第一个没有成功 take 的片段重新生成（segment.generate 会建新 take；失败段金额已退回）
      const { rows: next } = await t.query(
        `SELECT s.idx FROM segments s
          WHERE s.project_id = $1
            AND NOT EXISTS (SELECT 1 FROM segment_takes t WHERE t.segment_id = s.id AND t.status = 'succeeded')
          ORDER BY s.idx LIMIT 1`, [projectId]);
      if (next.length) {
        await enqueue(t, { type: 'segment.generate', payload: { projectId, idx: next[0].idx } });
      }
    } else if (step === 'composing') {
      await enqueue(t, { type: 'project.compose', payload: { projectId },
        dedupeKey: `project:compose:${projectId}:retry` });
    }
    return { ok: true };
  });
}

export async function cancelProject(db, { userId, projectId }) {
  return db.tx(async (t) => {
    const project = await requireProject(t, { userId, projectId });
    const money = await projectMoneySummary(t, { userId, projectId });
    // 提交结果未知（unknown）的片段金额保持冻结待对账（docs/ARCHITECTURE §4：只退未提交部分）
    const { rows: unknownRows } = await t.query(
      `SELECT COALESCE(SUM(s.duration_seconds), 0)::bigint AS seconds
         FROM segments s JOIN segment_takes st ON st.segment_id = s.id
        WHERE s.project_id = $1 AND st.status = 'unknown'`, [projectId]);
    let unknownFrozen = 0;
    if (Number(unknownRows[0].seconds) > 0) {
      const unit = await videoUnitFen(t, project.tier_mapping_id);
      unknownFrozen = Number(unknownRows[0].seconds) * unit;
    }
    const refundable = Math.max(0, money.frozenFen - unknownFrozen);
    const purpose = 'cancel'; // 状态迁移守卫保证 cancel 只会成功一次，幂等键固定即可
    await refundProject(t, { userId, projectId, amountFen: refundable, purpose });
    await transition(t, { projectId, userId,
      from: ['understanding', 'story_review', 'casting', 'cast_review', 'rendering', 'composing', 'paused', 'failed'],
      to: 'canceled', progress: { percent: 0, message: '已取消' } });
    return { ok: true, refundedFen: refundable, frozenFen: unknownFrozen };
  });
}

// ───────────── API §6.1 列表/详情/删除 与 §6.6 交付后 ─────────────

const SUMMARY_SELECT = `
  SELECT p.*,
    (SELECT r.cover_key FROM renders r WHERE r.project_id = p.id AND r.cover_key IS NOT NULL
      ORDER BY r.created_at DESC, r.id DESC LIMIT 1) AS cover_key,
    (SELECT r.duration_seconds FROM renders r WHERE r.project_id = p.id AND r.status = 'succeeded'
      ORDER BY r.created_at DESC, r.id DESC LIMIT 1) AS duration_seconds
    FROM projects p`;

export function projectSummary(row, urlFor) {
  const summary = {
    id: row.id, title: row.title, status: row.status, group: groupOf(row.status),
    progress: row.progress ?? { percent: 0, message: '' },
    createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
  };
  const coverUrl = row.cover_key && urlFor ? urlFor(row.cover_key) : undefined;
  if (coverUrl) summary.coverUrl = coverUrl;
  if (row.duration_seconds) summary.durationSeconds = row.duration_seconds;
  if (row.expires_at) summary.expiresAt = row.expires_at.toISOString();
  return summary;
}

/** 列表（API §6.1）：group 过滤 + 游标翻页（(updated_at, id) 倒序，cursor 为 base64 编码）。 */
export async function listProjects(db, { userId, group, cursor, limit = 20, urlFor }) {
  const statuses = group ? GROUPS[group] : null;
  if (group && !statuses) throw appError('VALIDATION_FAILED', undefined, { fields: { group: '取值不正确' } });
  let cursorTuple = null;
  if (cursor) {
    try {
      const [updatedAt, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
      cursorTuple = { updatedAt, id };
    } catch { throw appError('VALIDATION_FAILED', undefined, { fields: { cursor: '取值不正确' } }); }
  }
  const size = Math.min(Math.max(Number.isSafeInteger(limit) ? limit : 20, 1), 50);
  const params = [userId];
  const where = ['p.user_id = $1', 'p.deleted_at IS NULL'];
  if (statuses) { params.push(statuses); where.push(`p.status = ANY($${params.length}::text[])`); }
  if (cursorTuple) {
    params.push(cursorTuple.updatedAt, cursorTuple.id);
    where.push(`(p.updated_at, p.id) < ($${params.length - 1}::timestamptz, $${params.length})`);
  }
  params.push(size + 1);
  const { rows } = await db.query(
    `${SUMMARY_SELECT} WHERE ${where.join(' AND ')}
      ORDER BY p.updated_at DESC, p.id DESC LIMIT $${params.length}`, params,
  );
  const page = rows.slice(0, size);
  const nextCursor = rows.length > size
    ? Buffer.from(`${page.at(-1).updated_at.toISOString()}|${page.at(-1).id}`).toString('base64url') : null;
  return { items: page.map((row) => projectSummary(row, urlFor)), nextCursor };
}

/** 删除作品（API §6.1）：进行中先走取消（退未结算），软删除并立即删除视频文件；
 * 标题/封面引用与故事文字保留（PRD：过期/删除后仍可展示与「再做一部」）。 */
export async function deleteProject(db, { userId, projectId, storage }) {
  const project = await requireProject(db, { userId, projectId });
  if (project.status !== 'delivered' && project.status !== 'expired' && project.status !== 'canceled') {
    await cancelProject(db, { userId, projectId });
  }
  const { rows: videoRows } = await db.query(
    `SELECT video_key, cover_key FROM renders WHERE project_id = $1 AND (video_key IS NOT NULL OR cover_key IS NOT NULL)`,
    [projectId],
  );
  const keys = videoRows.flatMap((row) => [row.video_key, row.cover_key]).filter(Boolean);
  await db.tx(async (t) => {
    await t.query(
      `UPDATE projects SET deleted_at = now(), updated_at = now() WHERE id = $1 AND deleted_at IS NULL`,
      [projectId],
    );
    if (keys.length) {
      await t.query(`UPDATE renders SET video_key = NULL, cover_key = NULL WHERE project_id = $1`, [projectId]);
      await t.query(
        `UPDATE segment_takes SET video_key = NULL, last_frame_key = NULL
          WHERE segment_id IN (SELECT id FROM segments WHERE project_id = $1) AND (video_key IS NOT NULL OR last_frame_key IS NOT NULL)`,
        [projectId],
      );
    }
  });
  if (keys.length) await storage.remove(keys);
  return { ok: true };
}

/** 交付后改剧情（API §6.6 PATCH）：仅 delivered；下一次 re-take 生效。 */
export async function updateSegmentPlot(db, { userId, projectId, segmentId, plot }) {
  const value = typeof plot === 'string' ? plot.trim() : '';
  if (!value || value.length > 1000) throw appError('VALIDATION_FAILED', '剧情为 1~1000 字');
  return db.tx(async (t) => {
    const project = await requireProject(t, { userId, projectId });
    if (project.status === 'expired') throw appError('PROJECT_EXPIRED');
    if (project.status !== 'delivered') throw appError('PROJECT_STATE_INVALID');
    const { rowCount } = await t.query(
      `UPDATE segments SET plot = $2 WHERE id = $1 AND project_id = $3`,
      [segmentId, value, projectId],
    );
    if (!rowCount) throw appError('NOT_FOUND');
    await appendEvent(t, { projectId, status: 'delivered',
      progress: { percent: 100, message: '已完成' }, changed: ['segments'] });
    return { ok: true };
  });
}

/** 交付后重新生成片段（API §6.6 POST takes）：新增候选 take（永不覆盖旧版本），
 * segment_take 报价扣费预占；成功后 gen.poll 自动切换选中并按新 render 重新拼接。 */
export async function createSegmentTake(db, { userId, projectId, segmentId, quoteId, idempotencyKey, config, channelRouter = null }) {
  if (channelRouter) await channelRouter.pick('video'); // re-take 同样需要生效视频渠道
  return db.tx(async (t) => {
    const project = await requireProject(t, { userId, projectId });
    if (project.status === 'expired') throw appError('PROJECT_EXPIRED');
    if (project.status !== 'delivered') throw appError('PROJECT_STATE_INVALID');
    const { rows: segmentRows } = await t.query(
      `SELECT * FROM segments WHERE id = $1 AND project_id = $2`, [segmentId, projectId]);
    if (!segmentRows.length) throw appError('NOT_FOUND');
    const segment = segmentRows[0];
    const replayKey = `segment.take.create:${userId}:${idempotencyKey}`;
    await t.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [replayKey]);
    // gen_tasks 幂等：同键已有任务直接复用其 take
    const { rows: existing } = await t.query(`SELECT id FROM gen_tasks WHERE idempotency_key = $1`, [replayKey]);
    if (existing.length) {
      const { rows: takes } = await t.query(`SELECT id FROM segment_takes WHERE gen_task_id = $1`, [existing[0].id]);
      return { replayed: true, takeId: takes[0]?.id };
    }
    const { quote } = await consumeQuote(t, { userId, quoteId, kind: 'segment_take', refType: 'segment', refId: segmentId });
    const takeId = newId('take');
    await reserveProjectVideo(t, { userId, projectId, amountFen: quote.amount_fen,
      purpose: `retake:${takeId}` });
    const genTaskId = newId('gt');
    const { rows: skuRows } = await t.query(
      `SELECT s.sku_code, s.version, s.resolution FROM tier_mappings tm
         JOIN skus s ON s.sku_code = tm.video_sku_code AND s.kind = 'video' AND s.status = 'active'
        WHERE tm.id = $1 ORDER BY s.version DESC LIMIT 1`, [project.tier_mapping_id]);
    const { rows: castRows } = await t.query(`SELECT id FROM project_cast WHERE project_id = $1 ORDER BY idx`, [projectId]);
    await t.query(
      `INSERT INTO segment_takes (id, segment_id, status) VALUES ($1, $2, 'pending')`,
      [takeId, segment.id],
    );
    await t.query(
      `INSERT INTO gen_tasks (id, user_id, kind, sku_code, sku_version, provider, status, request, idempotency_key)
       VALUES ($1, $2, 'video', $3, $4, 'unassigned', 'created', $5, $6)`,
      [genTaskId, userId, skuRows[0].sku_code, skuRows[0].version, JSON.stringify({
        takeId, projectId, segmentId: segment.id, idx: segment.idx,
        prompt: segment.final_prompt?.prompt ?? '', imageRefs: segment.final_prompt?.imageRefs ?? [],
        audioRefs: segment.final_prompt?.audioRefs ?? [], durationSeconds: segment.duration_seconds,
        ratio: project.ratio, videoKey: `users/${userId}/projects/${projectId}/takes/${takeId}.mp4`,
        lastFrameKey: `users/${userId}/projects/${projectId}/takes/${takeId}.last.jpg`,
        posterKey: `users/${userId}/projects/${projectId}/takes/${takeId}.poster.jpg`,
        amountFen: quote.amount_fen, resolution: skuRows[0].resolution ?? '720p',
        redelivery: true, castCount: castRows.length,
      }), replayKey],
    );
    await t.query(`UPDATE segment_takes SET gen_task_id = $2 WHERE id = $1`, [takeId, genTaskId]);
    await enqueue(t, { type: 'segment.generate', payload: { projectId, idx: segment.idx, takeId, redelivery: true } });
    return { replayed: false, takeId };
  });
}

/** 交付后切换选中版本（API §6.6 PUT selection）：只能选本片段 succeeded 的 take；
 * 切换后按新 render 重新拼接（免费，状态保持 delivered）。 */
export async function selectSegmentTake(db, { userId, projectId, segmentId, takeId }) {
  return db.tx(async (t) => {
    const project = await requireProject(t, { userId, projectId });
    if (project.status === 'expired') throw appError('PROJECT_EXPIRED');
    if (project.status !== 'delivered') throw appError('PROJECT_STATE_INVALID');
    const { rows } = await t.query(
      `SELECT id FROM segment_takes WHERE id = $1 AND segment_id = $2 AND status = 'succeeded'`,
      [takeId, segmentId],
    );
    if (!rows.length) throw appError('VALIDATION_FAILED', '只能选择生成成功的片段版本');
    const { rowCount } = await t.query(
      `UPDATE segments SET selected_take_id = $2 WHERE id = $1 AND project_id = $3`,
      [segmentId, takeId, projectId],
    );
    if (!rowCount) throw appError('NOT_FOUND');
    await transition(t, { projectId, userId, from: ['delivered'], to: 'delivered',
      progress: { percent: 100, message: '正在重新拼接' }, changed: ['segments'] }).catch((error) => {
      if (error?.code !== 'PROJECT_STATE_INVALID') throw error;
    });
    await enqueue(t, { type: 'project.compose', payload: { projectId },
      dedupeKey: `project:compose:${projectId}:reselect:${takeId}` });
    return { ok: true };
  });
}

/** 下载地址（API §6.6 GET download）：delivered 且成片存在；302 到带 attname 的签名链接。 */
export async function projectDownload(db, { userId, projectId, storage, ttlSeconds }) {
  const project = await requireProject(db, { userId, projectId });
  if (project.status === 'expired') throw appError('PROJECT_EXPIRED');
  if (project.status !== 'delivered') throw appError('PROJECT_STATE_INVALID');
  const { rows } = await db.query(
    `SELECT video_key FROM renders WHERE project_id = $1 AND status = 'succeeded' AND video_key IS NOT NULL
      ORDER BY created_at DESC, id DESC LIMIT 1`, [projectId],
  );
  if (!rows.length) throw appError('NOT_FOUND', '成片尚未就绪');
  const filename = `${(project.title || '我的作品').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60) || 'video'}.mp4`;
  return storage.signedUrl(rows[0].video_key, { ttlSeconds: ttlSeconds ?? 600, download: filename });
}
