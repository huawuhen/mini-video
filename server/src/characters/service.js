// 数字资产库（docs/API.md §5、PRD §4.1；CODEX_HANDOFF §6 M1-BE-04 要点 b~f）。
// 所有查询带 user_id，他人资源一律 404；替换类操作只增不改（形象版本只新增、切换用 selection）。
// 引用上传遵循 BE-03 约定：同事务条件 UPDATE，返回行数不足即 400；旧照片只解除引用，对象由 uploads.sweep 回收。
import { newId } from '../db/ids.js';
import { appError } from '../http/errors.js';
import { enqueue, PermanentJobError } from '../queue/index.js';
import { consumeQuote } from '../wallet/pricing.js';
import { refund, reserve, settle } from '../wallet/service.js';

async function requireCharacter(t, userId, id) {
  const { rows } = await t.query(
    `SELECT * FROM characters WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
    [id, userId],
  );
  if (!rows.length) throw appError('NOT_FOUND');
  return rows[0];
}

async function requireActiveVoice(t, voiceId) {
  const { rows } = await t.query(`SELECT id FROM voices WHERE id = $1 AND status = 'active'`, [voiceId]);
  if (!rows.length) throw appError('VALIDATION_FAILED', undefined, { fields: { defaultVoiceId: '取值不正确' } });
}

async function requireActiveStyle(t, styleId) {
  const { rows } = await t.query(`SELECT id FROM styles WHERE id = $1 AND status = 'active'`, [styleId]);
  if (!rows.length) throw appError('VALIDATION_FAILED', undefined, { fields: { styleId: '取值不正确' } });
}

/**
 * 引用上传（要点 b + §6 审查 1）：同事务条件 UPDATE，行数与传入不符 = 不存在/已清理/不属于本人/已被其他数字人使用 → 400。
 * 独占语义：一张上传不能被**其他**数字人使用；本数字人重复引用（替换流程先删后加）允许。
 */
async function referenceUploads(t, userId, characterId, uploadIds) {
  if (!uploadIds.length) return;
  const { rows } = await t.query(
    `UPDATE uploads SET referenced_at = now()
      WHERE id = ANY($1) AND user_id = $2
        AND NOT EXISTS (
          SELECT 1 FROM character_photos cp WHERE cp.upload_id = uploads.id AND cp.character_id <> $3)
      RETURNING id`,
    [uploadIds, userId, characterId],
  );
  if (rows.length !== uploadIds.length) {
    throw appError('VALIDATION_FAILED', '部分图片不存在、已失效或已被其他数字人使用，请重新上传');
  }
  for (const [index, uploadId] of uploadIds.entries()) {
    await t.query(
      `INSERT INTO character_photos (id, character_id, upload_id, sort) VALUES ($1, $2, $3, $4)`,
      [newId('cph'), characterId, uploadId, index],
    );
  }
}

/** 列表与详情共用的单行序列化。avatarUrl 优先最近使用风格的当前形象，否则第一张参考照片。 */
function serializeCharacter(row, urlFor) {
  const character = {
    id: row.id,
    name: row.name,
    tags: row.tags ?? [],
    worksCount: Number(row.works_count ?? 0),
    styleIds: row.style_ids ?? [],
    createdAt: row.created_at.toISOString(),
  };
  if (row.default_voice_id) character.defaultVoiceId = row.default_voice_id;
  const avatarKey = row.look_image_key || row.first_photo_key;
  const avatarUrl = avatarKey ? urlFor(avatarKey) : undefined;
  if (avatarUrl) character.avatarUrl = avatarUrl;
  return character;
}

const LIST_SELECT = `
  SELECT c.*,
    (SELECT count(*)::int FROM project_cast pc JOIN projects p ON p.id = pc.project_id
      WHERE pc.character_id = c.id AND p.deleted_at IS NULL) AS works_count,
    (SELECT COALESCE(array_agg(DISTINCT cl.style_id), '{}') FROM character_looks cl
      JOIN look_versions lv ON lv.id = cl.selected_version_id
      WHERE cl.character_id = c.id AND lv.status = 'succeeded') AS style_ids,
    (SELECT lv.image_key FROM character_looks cl
      JOIN look_versions lv ON lv.id = cl.selected_version_id
      WHERE cl.character_id = c.id AND lv.status = 'succeeded'
      ORDER BY lv.created_at DESC, lv.id DESC LIMIT 1) AS look_image_key,
    (SELECT up.storage_key FROM character_photos cp JOIN uploads up ON up.id = cp.upload_id
      WHERE cp.character_id = c.id ORDER BY cp.sort, cp.id LIMIT 1) AS first_photo_key
  FROM characters c`;

export async function listCharacters(db, { userId, urlFor }) {
  const { rows } = await db.query(
    `${LIST_SELECT} WHERE c.user_id = $1 AND c.deleted_at IS NULL ORDER BY c.created_at DESC, c.id DESC`,
    [userId],
  );
  return { items: rows.map((row) => serializeCharacter(row, urlFor)) };
}

function serializeLookVersion(row, urlFor) {
  const version = { id: row.id, status: row.status, createdAt: row.created_at.toISOString() };
  const imageUrl = row.image_key ? urlFor(row.image_key) : undefined;
  if (imageUrl) version.imageUrl = imageUrl;
  if (Array.isArray(row.view_keys) && row.view_keys.length) {
    const viewUrls = row.view_keys.map((key) => urlFor(key)).filter(Boolean);
    if (viewUrls.length) version.viewUrls = viewUrls;
  }
  if (row.error?.message) version.error = row.error.message;
  return version;
}

export async function getCharacterDetail(db, { userId, id, urlFor }) {
  const { rows } = await db.query(`${LIST_SELECT} WHERE c.id = $1 AND c.user_id = $2 AND c.deleted_at IS NULL`, [id, userId]);
  if (!rows.length) throw appError('NOT_FOUND');
  const row = rows[0];

  const photos = (await db.query(
    `SELECT cp.upload_id, up.storage_key FROM character_photos cp JOIN uploads up ON up.id = cp.upload_id
      WHERE cp.character_id = $1 ORDER BY cp.sort, cp.id`,
    [id],
  )).rows.map((p) => {
    const photo = { uploadId: p.upload_id };
    const url = urlFor(p.storage_key);
    if (url) photo.url = url;
    return photo;
  });

  const lookRows = (await db.query(
    // character_looks 没有时间列：按最早版本的产生时间排
    `SELECT cl.* FROM character_looks cl
      WHERE cl.character_id = $1
      ORDER BY (SELECT min(lv.created_at) FROM look_versions lv WHERE lv.look_id = cl.id), cl.id`,
    [id],
  )).rows;
  const versionRows = lookRows.length ? (await db.query(
    `SELECT * FROM look_versions WHERE look_id = ANY($1) ORDER BY created_at, id`,
    [lookRows.map((l) => l.id)],
  )).rows : [];

  const looks = lookRows.map((look) => {
    const versions = versionRows.filter((v) => v.look_id === look.id);
    const selected = versions.find((v) => v.id === look.selected_version_id);
    const lookOut = { styleId: look.style_id, versions: versions.map((v) => serializeLookVersion(v, urlFor)) };
    if (look.selected_version_id) lookOut.selectedVersionId = look.selected_version_id;
    const imageUrl = selected?.status === 'succeeded' && selected.image_key ? urlFor(selected.image_key) : undefined;
    if (imageUrl) lookOut.imageUrl = imageUrl;
    return lookOut;
  });

  return {
    ...serializeCharacter(row, urlFor),
    ...(row.description ? { description: row.description } : {}),
    photos,
    looks,
  };
}

export async function createCharacter(db, { userId, input, urlFor }) {
  return db.tx(async (t) => {
    if (input.defaultVoiceId) await requireActiveVoice(t, input.defaultVoiceId);
    if (!input.photoUploadIds.length && !input.description) {
      throw appError('VALIDATION_FAILED', undefined, { fields: { description: '没有照片时必须填写外貌描述' } });
    }
    const id = newId('chr');
    const { rows } = await t.query(
      `INSERT INTO characters (id, user_id, name, tags, description, default_voice_id)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [id, userId, input.name, input.tags ?? [], input.description ?? '', input.defaultVoiceId ?? null],
    );
    await referenceUploads(t, userId, id, input.photoUploadIds);
    return getCharacterDetail(t, { userId, id, urlFor });
  });
}

export async function updateCharacter(db, { userId, id, patch, urlFor }) {
  return db.tx(async (t) => {
    const character = await requireCharacter(t, userId, id);
    if (patch.defaultVoiceId) await requireActiveVoice(t, patch.defaultVoiceId);
    const { rows: photoCount } = await t.query(
      `SELECT count(*)::int AS n FROM character_photos WHERE character_id = $1`, [id]);
    if (photoCount[0].n === 0 && patch.description === '') {
      throw appError('VALIDATION_FAILED', undefined, { fields: { description: '没有照片的数字人必须保留外貌描述' } });
    }
    await t.query(
      `UPDATE characters SET
         name = COALESCE($2, name),
         tags = COALESCE($3, tags),
         description = CASE WHEN $4::jsonb IS NULL THEN description ELSE COALESCE($4::jsonb #>> '{}', '') END,
         default_voice_id = CASE WHEN $5::jsonb IS NULL THEN default_voice_id ELSE NULLIF($5::jsonb #>> '{}', '') END,
         updated_at = now()
       WHERE id = $1`,
      [id, patch.name ?? null, patch.tags ?? null,
        patch.description === undefined ? null : JSON.stringify(patch.description ?? ''),
        patch.defaultVoiceId === undefined ? null : JSON.stringify(patch.defaultVoiceId ?? '')],
    );
    return getCharacterDetail(t, { userId, id, urlFor });
  });
}

/** 整体替换照片（要点 f/b）：删旧关联行 → 引用新上传（条件 UPDATE，行数不符 400）→ 旧上传解除引用（对象由 uploads.sweep 回收）。 */
export async function replacePhotos(db, { userId, id, uploadIds, maxPhotos, urlFor }) {
  return db.tx(async (t) => {
    const character = await requireCharacter(t, userId, id);
    if (!Array.isArray(uploadIds) || uploadIds.length < 1 || uploadIds.length > maxPhotos) {
      throw appError('VALIDATION_FAILED', undefined, { fields: { uploadIds: `需 1~${maxPhotos} 张` } });
    }
    // 同一数字人的并发替换串行化，避免唯一约束竞争（并发场景下第二个事务按最终状态重放，仍成功）
    await t.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`chr:photos:${character.id}`]);
    const { rows: oldPhotos } = await t.query(
      `SELECT upload_id FROM character_photos WHERE character_id = $1`, [id],
    );
    await t.query(`DELETE FROM character_photos WHERE character_id = $1`, [id]);
    await referenceUploads(t, userId, id, uploadIds);
    // 旧照片解除引用；仅当没有任何其他数字人的照片行还在使用时才清（§6 审查 1，防御遗留共用数据）
    await t.query(
      `UPDATE uploads SET referenced_at = NULL
        WHERE id = ANY($1) AND NOT (id = ANY($2))
          AND NOT EXISTS (
            SELECT 1 FROM character_photos cp WHERE cp.upload_id = uploads.id AND cp.character_id <> $3)`,
      [oldPhotos.map((p) => p.upload_id), uploadIds, id],
    );
    return getCharacterDetail(t, { userId, id, urlFor });
  });
}

/**
 * 生成形象（要点 d）：一个事务完成 consumeQuote → reserve（金额 > 0 才调用）→
 * character_looks/look_versions(pending) + gen_tasks → enqueue look.generate。
 * 同一 idempotencyKey 重放返回同一版本、不重复扣费；幂等键由用户 id + 请求键派生。
 */
export async function createLookVersion(db, { userId, characterId, styleId, quoteId, idempotencyKey, urlFor }) {
  return db.tx(async (t) => {
    const replayKey = `look.create:${userId}:${idempotencyKey}`;
    // §6 审查 2：同键并发（手机双击）先按「用户+请求键」串行化——否则两个事务都查不到重放，
    // 第二个会在 consumeQuote 上误报 QUOTE_EXPIRED，而实际已在生成
    await t.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [replayKey]);
    const { rows: replayed } = await t.query(
      `SELECT lv.* FROM look_versions lv JOIN gen_tasks gt ON gt.id = lv.gen_task_id
        WHERE gt.idempotency_key = $1`,
      [replayKey],
    );
    if (replayed.length) return { replayed: true, version: serializeLookVersion(replayed[0], urlFor) };

    const character = await requireCharacter(t, userId, characterId);
    await requireActiveStyle(t, styleId);
    const { quote } = await consumeQuote(t, { userId, quoteId, kind: 'look_regenerate', refType: 'character', refId: characterId });
    const amountFen = quote.amount_fen;

    const versionId = newId('lkv');
    // 钱包约定：金额为 0 时跳过扣费调用；幂等键 look:<versionId>:reserve（API.md §3 计费约定）
    if (amountFen > 0) {
      await reserve(t, {
        userId, amountFen, refType: 'look', refId: versionId,
        idempotencyKey: `look:${versionId}:reserve`, title: '生成形象预占',
      });
    }

    await t.query(
      `INSERT INTO character_looks (id, character_id, style_id) VALUES ($1, $2, $3)
       ON CONFLICT (character_id, style_id) DO NOTHING`,
      [newId('look'), characterId, styleId],
    );
    const { rows: lookRows } = await t.query(
      `SELECT id FROM character_looks WHERE character_id = $1 AND style_id = $2`,
      [characterId, styleId],
    );
    const genTaskId = newId('gt');
    // §6 审查 4：把外貌描述、风格提示词与照片 key 一起交给 provider；provider 在处理器提交时写入 imageProvider.id
    const { rows: styleRows } = await t.query(`SELECT prompt_hint FROM styles WHERE id = $1`, [styleId]);
    const { rows: photoRows } = await t.query(
      `SELECT up.storage_key FROM character_photos cp JOIN uploads up ON up.id = cp.upload_id
        WHERE cp.character_id = $1 ORDER BY cp.sort, cp.id`,
      [characterId],
    );
    await t.query(
      `INSERT INTO gen_tasks (id, user_id, kind, sku_code, sku_version, provider, status, request, idempotency_key)
       VALUES ($1, $2, 'image', $3, $4, 'unassigned', 'created', $5, $6)`,
      [genTaskId, userId, quote.price_snapshot.image.skuCode, quote.price_snapshot.image.version,
        JSON.stringify({
          versionId, characterId, styleId, storageKey: `users/${userId}/looks/${versionId}`, amountFen,
          promptHint: styleRows[0]?.prompt_hint ?? '', description: character.description ?? '',
          referenceKeys: photoRows.map((r) => r.storage_key),
        }), replayKey],
    );
    await t.query(
      `INSERT INTO look_versions (id, look_id, gen_task_id, status) VALUES ($1, $2, $3, 'pending')`,
      [versionId, lookRows[0].id, genTaskId],
    );
    await enqueue(t, { type: 'look.generate', payload: { versionId }, dedupeKey: `look:${versionId}` });
    const version = (await t.query(`SELECT * FROM look_versions WHERE id = $1`, [versionId])).rows[0];
    return { replayed: false, version: serializeLookVersion(version, urlFor) };
  });
}

/** 切换选中版本（要点 f）：只能选本数字人、本风格、状态 succeeded 的版本。 */
export async function selectLookVersion(db, { userId, characterId, styleId, versionId, urlFor }) {
  return db.tx(async (t) => {
    const character = await requireCharacter(t, userId, characterId);
    const { rows } = await t.query(
      `SELECT cl.id AS look_id
         FROM character_looks cl
         JOIN look_versions lv ON lv.look_id = cl.id
        WHERE cl.character_id = $1 AND cl.style_id = $2 AND lv.id = $3 AND lv.status = 'succeeded'`,
      [character.id, styleId, versionId],
    );
    if (!rows.length) throw appError('VALIDATION_FAILED', '只能选择生成成功的形象版本');
    await t.query(`UPDATE character_looks SET selected_version_id = $2 WHERE id = $1`, [rows[0].look_id, versionId]);
    return getCharacterDetail(t, { userId, id: characterId, urlFor });
  });
}

/** 软删除：不影响历史作品（project_cast 引用保留），不删形象与版本。 */
export async function deleteCharacter(db, { userId, id }) {
  const { rowCount } = await db.query(
    `UPDATE characters SET deleted_at = now(), updated_at = now()
      WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
    [id, userId],
  );
  if (!rowCount) throw appError('NOT_FOUND');
  return { ok: true };
}

/**
 * look.generate 处理器（要点 e）：先读状态再调用上游，事务内不等待上游；必须幂等——
 * 重复执行、租约被抢都不能重复结算或重复退回（金额操作全部带 look:<versionId>:settle|refund 幂等键，
 * 且版本状态迁移带 `AND status = 'pending'` 守卫，输掉竞争的一方不动钱）。
 * 提交结果未知：版本保持 pending、金额保持冻结、gen_tasks 置 unknown，不自动重提。
 * §6 审查 3：只有 created 才允许提交——submitting 时上游可能已接受请求，重提会重复生成/重复计费；
 * 刚提交过的抛可重试错误交队列退避后再看；停滞超阈值置 unknown（保持冻结）等 M2 对账，绝不调 provider。
 */
const SUBMIT_STALE_MS = 10 * 60 * 1000;

export function createLookGenerateHandler({ db, logger, storage, imageProvider }) {
  return async function lookGenerate(payload, ctx) {
    const versionId = payload.versionId;
    const { rows } = await db.query(
      `SELECT lv.*, gt.user_id, gt.id AS gen_task_id, gt.status AS task_status, gt.updated_at AS task_updated_at, gt.request
         FROM look_versions lv JOIN gen_tasks gt ON gt.id = lv.gen_task_id
        WHERE lv.id = $1`,
      [versionId],
    );
    const version = rows[0];
    if (!version) throw new PermanentJobError('形象版本不存在');
    if (version.status === 'succeeded' || version.status === 'failed') return; // 已终态：幂等空转
    const request = version.request; // { versionId, characterId, styleId, storageKey, amountFen, promptHint, description, referenceKeys }

    // 提交守卫：只有 created → submitting；其余状态按下面分派，绝不重提
    const claim = await db.tx(async (t) => {
      const created = await t.query(
        `UPDATE gen_tasks SET status = 'submitting', provider = $2, updated_at = now()
          WHERE id = $1 AND status = 'created' RETURNING id`,
        [version.gen_task_id, imageProvider.id], // §6 审查 4：provider 记录真实注入实现
      );
      if (created.rows.length) return { claimed: true };
      const { rows: cur } = await t.query(`SELECT status, updated_at FROM gen_tasks WHERE id = $1`, [version.gen_task_id]);
      return { claimed: false, status: cur[0].status, updatedAt: cur[0].updated_at };
    });
    if (!claim.claimed) {
      if (claim.status === 'submitting' && Date.now() - claim.updatedAt.getTime() < SUBMIT_STALE_MS) {
        // 刚提交过、可能仍在执行：抛可重试错误，队列退避后再看（不调 provider、不动 job 结果）
        throw new Error('形象任务正在处理中，等待下次检查');
      }
      if (claim.status === 'submitting') {
        // 停滞：上次执行在上游接受请求后崩溃 → 提交结果未知：置 unknown、保持冻结、不重提，等 M2 对账
        await db.tx((t) => t.query(
          `UPDATE gen_tasks SET status = 'unknown', updated_at = now() WHERE id = $1`,
          [version.gen_task_id],
        ));
        ctx.logger.error('look_generate_stale_submitting', { versionId });
        return;
      }
      ctx.logger.info('look_generate_skip', { versionId, taskStatus: claim.status });
      return; // succeeded/failed/unknown 等状态：无事可做
    }

    await ctx.extendLease?.(); // 长耗时调用前续租，避免被误判租约过期后重复领取
    let result;
    try {
      result = await imageProvider.generate({
        characterId: request.characterId,
        styleId: request.styleId,
        promptHint: request.promptHint,
        description: request.description,
        referenceKeys: request.referenceKeys ?? [], // 该数字人的参考照片 key（§6 审查 4）
      });
    } catch (err) {
      if (err.retryable === true) {
        await db.tx((t) => t.query(
          `UPDATE gen_tasks SET status = 'created', updated_at = now() WHERE id = $1 AND status = 'submitting'`,
          [version.gen_task_id],
        ));
        throw err;
      }
      await db.tx((t) => t.query(
        `UPDATE gen_tasks SET status = 'unknown', updated_at = now() WHERE id = $1 AND status = 'submitting'`,
        [version.gen_task_id],
      ));
      ctx.logger.error('look_generate_submission_unknown', { versionId, code: err?.code });
      return; // 未明确证明未提交：不再重提，版本 pending，费用冻结待对账
    }
    await ctx.extendLease?.();

    if (result.status === 'unknown') {
      await db.tx((t) => t.query(
        `UPDATE gen_tasks SET status = 'unknown', updated_at = now() WHERE id = $1`,
        [version.gen_task_id],
      ));
      ctx.logger.warn('look_generate_unknown', { versionId }); // 保持 pending 与冻结，不自动重提
      return;
    }

    if (result.status === 'succeeded') {
      let imageKey = request.storageKey;
      try {
        await storage.put(imageKey, result.buffer, { contentType: result.contentType ?? 'image/png' });
      } catch (err) {
        await db.tx((t) => t.query(`UPDATE gen_tasks SET status = 'created', updated_at = now() WHERE id = $1`, [version.gen_task_id]));
        throw err; // 存储失败：回退状态交队列重试
      }
      const done = await db.tx(async (t) => {
        const claimed2 = await t.query(
          `UPDATE look_versions SET status = 'succeeded', image_key = $2
            WHERE id = $1 AND status = 'pending' RETURNING look_id`,
          [versionId, imageKey],
        );
        if (!claimed2.rows.length) return false; // 输掉竞争：另一个执行已完成，不动钱
        await t.query(
          `UPDATE character_looks SET selected_version_id = $2 WHERE id = $1`, // 自动选中新版本（旧版本保留）
          [claimed2.rows[0].look_id, versionId],
        );
        await t.query(
          `UPDATE gen_tasks SET status = 'succeeded', result = $2, updated_at = now() WHERE id = $1`,
          [version.gen_task_id, JSON.stringify({ imageKey })],
        );
        if (request.amountFen > 0) {
          await settleReserved(t, { userId: version.user_id, versionId, amountFen: request.amountFen });
        }
        return true;
      });
      ctx.logger.info('look_generate_succeeded', { versionId, selected: done });
      return;
    }

    // 业务失败
    const done = await db.tx(async (t) => {
      const claimed2 = await t.query(
        `UPDATE look_versions SET status = 'failed', error = $2
          WHERE id = $1 AND status = 'pending' RETURNING id`,
        [versionId, JSON.stringify({ message: result.error ?? '形象生成失败' })],
      );
      if (!claimed2.rows.length) return false;
      await t.query(
        `UPDATE gen_tasks SET status = 'failed', error = $2, updated_at = now() WHERE id = $1`,
        [version.gen_task_id, JSON.stringify({ message: result.error ?? '形象生成失败' })],
      );
      if (request.amountFen > 0) {
        await refundReserved(t, { userId: version.user_id, versionId, amountFen: request.amountFen });
      }
      return true;
    });
    ctx.logger[done ? 'info' : 'warn']('look_generate_failed', { versionId, idempotentSkip: !done });
  };
}

/** 结算/退回都走钱包幂等键（look:<versionId>:settle|refund），重复执行只生效一次。 */
function settleReserved(t, { userId, versionId, amountFen }) {
  return settle(t, {
    userId, amountFen, refType: 'look', refId: versionId,
    idempotencyKey: `look:${versionId}:settle`, title: '生成形象结算',
  });
}

function refundReserved(t, { userId, versionId, amountFen }) {
  return refund(t, {
    userId, amountFen, refType: 'look', refId: versionId,
    idempotencyKey: `look:${versionId}:refund`, title: '生成形象退回',
  });
}
