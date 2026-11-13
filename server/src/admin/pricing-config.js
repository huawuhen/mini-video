// 管理端·价格与配置 / 审计服务（M3-ADM-04，docs/API.md §8.4~8.5）。
// SKU 价格版本化（新增版本不覆盖历史）、档位与映射版本、风格 / 音色管理、运营参数白名单、
// 审计只读列表。路由层只做校验与审计调用，这里只写 SQL 与业务规则。
import { newId } from '../db/ids.js';
import { appError } from '../http/errors.js';

// ───────────── SKU 价格版本（§8.4） ─────────────

/** 当前生效版本（active 且已生效的最大 version）+ 历史版本数 + 毛利率。 */
async function skuView(t, skuCode) {
  const { rows } = await t.query(
    `SELECT k.sku_code, k.kind, k.model, k.resolution, k.unit, k.price_fen, k.cost_fen,
            k.version, k.effective_at,
            (SELECT count(*)::int FROM skus h WHERE h.sku_code = k.sku_code) AS versions
       FROM skus k
      WHERE k.sku_code = $1 AND k.status = 'active' AND k.effective_at <= now()
      ORDER BY k.version DESC LIMIT 1`,
    [skuCode],
  );
  return rows.length ? toAdminSku(rows[0]) : null;
}

/** 指定版本的视图（POST 新增版本的响应：新版本行本身——未来生效时它还不是「当前生效版本」）。 */
async function skuVersionView(t, skuCode, version) {
  const { rows } = await t.query(
    `SELECT k.sku_code, k.kind, k.model, k.resolution, k.unit, k.price_fen, k.cost_fen,
            k.version, k.effective_at,
            (SELECT count(*)::int FROM skus h WHERE h.sku_code = k.sku_code) AS versions
       FROM skus k WHERE k.sku_code = $1 AND k.version = $2`,
    [skuCode, version],
  );
  return rows.length ? toAdminSku(rows[0]) : null;
}

function toAdminSku(row) {
  const price = Number(row.price_fen);
  const cost = Number(row.cost_fen);
  return {
    skuCode: row.sku_code, kind: row.kind, model: row.model,
    resolution: row.resolution ?? null, unit: row.unit,
    priceFen: price, costFen: cost, version: row.version, versions: Number(row.versions),
    effectiveAt: row.effective_at.toISOString(),
    marginRate: price > 0 ? Math.round(((price - cost) / price) * 10_000) / 10_000 : null,
  };
}

export async function listSkus(db) {
  const { rows } = await db.query(
    `SELECT DISTINCT ON (k.sku_code) k.sku_code, k.kind, k.model, k.resolution, k.unit,
            k.price_fen, k.cost_fen, k.version, k.effective_at,
            (SELECT count(*)::int FROM skus h WHERE h.sku_code = k.sku_code) AS versions
       FROM skus k
      WHERE k.status = 'active' AND k.effective_at <= now()
      ORDER BY k.sku_code, k.version DESC`);
  return { items: rows.map(toAdminSku) };
}

/**
 * 新增价格版本（不覆盖历史）：复制最新版本的 kind/model/渠道/时长等属性，只换价格与生效时间。
 * 生效时间缺省立即生效；未来生效的版本先入库存为 active，到点后按 version 取数自动切换
 * （latestActiveSku 取「active 且已生效的最大 version」）——旧版本此时保持 active，
 * 否则生效前会出现「无可用价格」的 INTERNAL。立即生效时才把旧版本置 inactive（与 API.md 一致）。
 * 幂等：同键同参数重放返回当前版本；同键不同参数 409。
 */
export async function createSkuVersion(db, { skuCode, priceFen, costFen = null, effectiveAt = null, idempotencyKey, adminId }) {
  return db.tx(async (t) => {
    await t.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`admin:sku:${skuCode}`]);
    const { rows: baseRows } = await t.query(
      `SELECT * FROM skus WHERE sku_code = $1 ORDER BY version DESC LIMIT 1`, [skuCode]);
    const base = baseRows[0];
    if (!base) throw appError('NOT_FOUND', 'SKU 不存在');
    if (base.kind === 'llm' && priceFen !== 0) {
      throw appError('VALIDATION_FAILED', 'LLM 的用户价固定为 0（平台承担），不能设置价格');
    }
    if (idempotencyKey) {
      const { rows: replay } = await t.query(`SELECT * FROM skus WHERE idempotency_key = $1`, [idempotencyKey]);
      if (replay.length) {
        const first = replay[0];
        const same = first.sku_code === skuCode
          && Number(first.price_fen) === priceFen
          && (costFen === null || Number(first.cost_fen) === costFen)
          && (effectiveAt === null || first.effective_at.getTime() === effectiveAt.getTime());
        if (!same) throw appError('IDEMPOTENCY_CONFLICT');
        return { replayed: true, sku: await skuVersionView(t, skuCode, first.version) };
      }
    }
    const effective = effectiveAt ?? null; // null → SQL now()，立即生效
    const { rows: inserted } = await t.query(
      `INSERT INTO skus (id, sku_code, version, kind, model, channel, resolution, unit,
                          price_fen, cost_fen, durations, with_audio, audio_ref, status,
                          effective_at, created_by, idempotency_key)
       SELECT $1, $2, $3, k.kind, k.model, k.channel, k.resolution, k.unit,
              $4, $5, k.durations, k.with_audio, k.audio_ref, 'active',
              COALESCE($6::timestamptz, now()), $7, $8
         FROM skus k WHERE k.id = $9
       RETURNING version, effective_at`,
      [newId('sku'), skuCode, base.version + 1, priceFen,
        costFen === null ? base.cost_fen : costFen, effective, adminId, idempotencyKey, base.id],
    );
    const version = inserted[0].version;
    const immediatelyEffective = inserted[0].effective_at.getTime() <= Date.now();
    if (immediatelyEffective) {
      await t.query(`UPDATE skus SET status = 'inactive' WHERE sku_code = $1 AND version < $2 AND status = 'active'`,
        [skuCode, version]);
    }
    return { replayed: false, sku: await skuVersionView(t, skuCode, version) };
  });
}

// ───────────── 档位与映射（§8.4） ─────────────

const TIER_SKU_SELECT = `
  SELECT m.id AS mapping_id, m.version AS mapping_version, m.effective_at AS mapping_effective_at,
         m.video_sku_code, k.price_fen, k.status AS sku_status, k.effective_at AS sku_effective_at
    FROM tier_mappings m
    LEFT JOIN LATERAL (
      SELECT * FROM skus s WHERE s.sku_code = m.video_sku_code AND s.status = 'active' AND s.effective_at <= now()
      ORDER BY s.version DESC LIMIT 1
    ) k ON true
   WHERE m.tier_id = $1 AND m.effective_at <= now()
   ORDER BY m.version DESC LIMIT 1`;

export async function listTiers(db) {
  const { rows } = await db.query(`SELECT * FROM quality_tiers ORDER BY sort, id`);
  const items = [];
  for (const row of rows) {
    const { rows: mappingRows } = await db.query(TIER_SKU_SELECT, [row.id]);
    const m = mappingRows[0];
    items.push({
      id: row.id, name: row.name, note: row.note, sort: row.sort, status: row.status,
      currentMapping: m ? {
        id: m.mapping_id, videoSkuCode: m.video_sku_code, version: m.mapping_version,
        effectiveAt: m.mapping_effective_at.toISOString(),
        priceFen: m.price_fen === null ? null : Number(m.price_fen), // null = 指向的 SKU 暂无生效价格
      } : null,
    });
  }
  return { items };
}

export async function updateTier(db, { tierId, patch }) {
  return db.tx(async (t) => {
    const { rows } = await t.query(`SELECT * FROM quality_tiers WHERE id = $1 FOR UPDATE`, [tierId]);
    if (!rows.length) throw appError('NOT_FOUND', '档位不存在');
    const next = {
      name: patch.name ?? rows[0].name,
      note: patch.note ?? rows[0].note,
      sort: patch.sort ?? rows[0].sort,
      status: patch.status ?? rows[0].status,
    };
    const { rows: updated } = await t.query(
      `UPDATE quality_tiers SET name = $2, note = $3, sort = $4, status = $5 WHERE id = $1
       RETURNING id, name, note, sort, status`,
      [tierId, next.name, next.note, next.sort, next.status]);
    return { tier: updated[0] };
  });
}

/** 新增档位映射版本（不覆盖历史）：映射只影响新创建的作品与首页估算，既有作品仍用创建时锁定的映射。 */
export async function createTierMapping(db, { tierId, videoSkuCode }) {
  return db.tx(async (t) => {
    const { rows: tiers } = await t.query(`SELECT id FROM quality_tiers WHERE id = $1 FOR UPDATE`, [tierId]);
    if (!tiers.length) throw appError('NOT_FOUND', '档位不存在');
    const { rows: skus } = await t.query(
      `SELECT 1 FROM skus WHERE sku_code = $1 AND status = 'active' AND effective_at <= now() LIMIT 1`,
      [videoSkuCode]);
    if (!skus.length) throw appError('VALIDATION_FAILED', '该 SKU 暂无生效价格，不能设为档位映射');
    const { rows: latest } = await t.query(
      `SELECT max(version) AS version FROM tier_mappings WHERE tier_id = $1`, [tierId]);
    const version = Number(latest[0].version ?? 0) + 1;
    const { rows: inserted } = await t.query(
      `INSERT INTO tier_mappings (id, tier_id, version, video_sku_code) VALUES ($1, $2, $3, $4)
       RETURNING id, version, effective_at`,
      [newId('tm'), tierId, version, videoSkuCode]);
    const row = inserted[0];
    return { mapping: { id: row.id, tierId, version: row.version, videoSkuCode, effectiveAt: row.effective_at.toISOString() } };
  });
}

// ───────────── 风格 / 音色（§8.4） ─────────────

export const VOICE_CATEGORIES = ['girl', 'boy', 'child_f', 'child_m', 'young_f', 'young_m', 'middle_f', 'middle_m', 'elder_f', 'elder_m'];
export const VOICE_GENDERS = ['female', 'male'];
export const VOICE_AGE_GROUPS = ['child', 'teen', 'young', 'middle', 'elder'];

/** 上传引用：把管理端上传标记为已引用（避开 uploads.sweep），返回 storage key。 */
async function claimUpload(t, { uploadId, kinds, field }) {
  const { rows } = await t.query(`SELECT id, kind, storage_key FROM uploads WHERE id = $1 FOR UPDATE`, [uploadId]);
  if (!rows.length || !kinds.includes(rows[0].kind)) {
    throw appError('VALIDATION_FAILED', undefined, { fields: { [field]: '取值不正确' } });
  }
  await t.query(`UPDATE uploads SET referenced_at = now() WHERE id = $1 AND referenced_at IS NULL`, [uploadId]);
  return { id: rows[0].id, key: rows[0].storage_key };
}

export async function listStyles(db, { urlFor = () => undefined } = {}) {
  const { rows } = await db.query(
    `SELECT s.*, u.id AS cover_upload_id FROM styles s
       LEFT JOIN uploads u ON u.id = s.cover_upload_id
      ORDER BY s.sort, s.id`);
  return { items: rows.map((row) => ({
    id: row.id, name: row.name, description: row.description,
    coverUploadId: row.cover_upload_id ?? null,
    ...(row.cover_key ? { coverUrl: urlFor(row.cover_key) } : {}),
    promptHint: row.prompt_hint, sort: row.sort, status: row.status,
  })) };
}

export async function createStyle(db, { body: { name, description = '', coverUploadId = null, promptHint = '', sort = 0 } }) {
  return db.tx(async (t) => {
    let cover = null;
    if (coverUploadId) cover = await claimUpload(t, { uploadId: coverUploadId, kinds: ['image'], field: 'coverUploadId' });
    const id = newId('style');
    await t.query(
      `INSERT INTO styles (id, name, description, cover_key, cover_upload_id, prompt_hint, sort)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, name, description, cover?.key ?? null, cover?.id ?? null, promptHint, sort]);
    return { id };
  });
}

export async function updateStyle(db, { styleId, patch }) {
  return db.tx(async (t) => {
    const { rows } = await t.query(`SELECT * FROM styles WHERE id = $1 FOR UPDATE`, [styleId]);
    if (!rows.length) throw appError('NOT_FOUND', '风格不存在');
    const current = rows[0];
    let coverKey = current.cover_key;
    let coverUploadId = current.cover_upload_id;
    if (patch.coverUploadId !== undefined) {
      if (patch.coverUploadId === null) {
        coverKey = null;
        coverUploadId = null;
      } else {
        const cover = await claimUpload(t, { uploadId: patch.coverUploadId, kinds: ['image'], field: 'coverUploadId' });
        coverKey = cover.key;
        coverUploadId = cover.id;
      }
    }
    const next = {
      name: patch.name ?? current.name,
      description: patch.description ?? current.description,
      promptHint: patch.promptHint ?? current.prompt_hint,
      sort: patch.sort ?? current.sort,
      status: patch.status ?? current.status,
    };
    await t.query(
      `UPDATE styles SET name = $2, description = $3, cover_key = $4, cover_upload_id = $5,
                          prompt_hint = $6, sort = $7, status = $8
        WHERE id = $1`,
      [styleId, next.name, next.description, coverKey, coverUploadId, next.promptHint, next.sort, next.status]);
    return { ok: true };
  });
}

export async function listVoices(db, { urlFor = () => undefined } = {}) {
  const { rows } = await db.query(`SELECT * FROM voices ORDER BY sort, id`);
  return { items: rows.map((row) => ({
    id: row.id, name: row.name, category: row.category, gender: row.gender, ageGroup: row.age_group,
    description: row.description, sampleUploadId: row.sample_upload_id ?? null,
    refAudioUploadId: row.ref_audio_upload_id ?? null,
    ...(row.sample_key ? { sampleUrl: urlFor(row.sample_key) } : {}),
    sort: row.sort, status: row.status,
  })) };
}

async function voiceAudioRefs(t, body) {
  const sample = body.sampleUploadId
    ? await claimUpload(t, { uploadId: body.sampleUploadId, kinds: ['audio'], field: 'sampleUploadId' }) : null;
  const ref = body.refAudioUploadId
    ? await claimUpload(t, { uploadId: body.refAudioUploadId, kinds: ['audio'], field: 'refAudioUploadId' }) : null;
  return { sample, ref };
}

export async function createVoice(db, { body }) {
  return db.tx(async (t) => {
    const { sample, ref } = await voiceAudioRefs(t, body);
    const id = newId('vc');
    await t.query(
      `INSERT INTO voices (id, name, category, gender, age_group, description, sample_key, sample_upload_id,
                            ref_audio_key, ref_audio_upload_id, sort)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [id, body.name, body.category, body.gender, body.ageGroup, body.description ?? '',
        sample?.key ?? null, sample?.id ?? null, ref?.key ?? null, ref?.id ?? null, body.sort ?? 0]);
    return { id };
  });
}

export async function updateVoice(db, { voiceId, patch }) {
  return db.tx(async (t) => {
    const { rows } = await t.query(`SELECT * FROM voices WHERE id = $1 FOR UPDATE`, [voiceId]);
    if (!rows.length) throw appError('NOT_FOUND', '音色不存在');
    const current = rows[0];
    let { sample_key: sampleKey, sample_upload_id: sampleUploadId,
      ref_audio_key: refKey, ref_audio_upload_id: refUploadId } = current;
    if (patch.sampleUploadId !== undefined) {
      if (patch.sampleUploadId === null) {
        sampleKey = null;
        sampleUploadId = null;
      } else {
        const s = await claimUpload(t, { uploadId: patch.sampleUploadId, kinds: ['audio'], field: 'sampleUploadId' });
        sampleKey = s.key;
        sampleUploadId = s.id;
      }
    }
    if (patch.refAudioUploadId !== undefined) {
      if (patch.refAudioUploadId === null) {
        refKey = null;
        refUploadId = null;
      } else {
        const r = await claimUpload(t, { uploadId: patch.refAudioUploadId, kinds: ['audio'], field: 'refAudioUploadId' });
        refKey = r.key;
        refUploadId = r.id;
      }
    }
    await t.query(
      `UPDATE voices SET name = $2, category = $3, gender = $4, age_group = $5, description = $6,
                          sample_key = $7, sample_upload_id = $8, ref_audio_key = $9, ref_audio_upload_id = $10,
                          sort = $11, status = $12
        WHERE id = $1`,
      [voiceId,
        patch.name ?? current.name,
        patch.category ?? current.category,
        patch.gender ?? current.gender,
        patch.ageGroup ?? current.age_group,
        patch.description ?? current.description,
        sampleKey, sampleUploadId, refKey, refUploadId,
        patch.sort ?? current.sort,
        patch.status ?? current.status]);
    return { ok: true };
  });
}

// ───────────── 运营参数（§8.4，白名单） ─────────────

/** 白名单：键 → { label, type, min, max, 现状读取方 }。校验按类型与上下限（API.md §8.4）。 */
export const SETTING_DEFS = {
  daily_free_understanding: { label: '每天免费整理次数', type: 'int', min: 0, max: 1000 },
  max_story_chars: { label: '故事最长字数', type: 'int', min: 50, max: 20000 },
  min_story_chars: { label: '故事最短字数', type: 'int', min: 1, max: 1000 },
  max_character_photos: { label: '每个数字人照片上限', type: 'int', min: 1, max: 20 },
  max_duration_seconds: { label: '作品最长时长（秒）', type: 'int', min: 30, max: 300 },
  quote_ttl_seconds: { label: '报价有效期（秒）', type: 'int', min: 60, max: 86400 },
  expiry_remind_days: { label: '到期前提醒（天）', type: 'int', min: 0, max: 90 },
  retention_days: { label: '成片保存期（天）', type: 'int', min: 7, max: 365 },
};

async function readSettings(db) {
  const { rows } = await db.query(`SELECT key, value FROM settings`);
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

export async function getSettings(db) {
  const values = await readSettings(db);
  return { items: Object.entries(SETTING_DEFS).map(([key, def]) => ({
    key, label: def.label, type: def.type, min: def.min, max: def.max,
    value: typeof values[key] === 'number' ? values[key] : null,
  })) };
}

export async function updateSettings(db, { changes }) {
  return db.tx(async (t) => {
    // min ≤ max 跨键校验（两个字段都可能在本批修改）
    const values = await readSettings(db);
    const merged = { ...values, ...changes };
    if (merged.min_story_chars > merged.max_story_chars) {
      throw appError('VALIDATION_FAILED', '故事最短字数不能大于最长字数');
    }
    const applied = {};
    for (const [key, value] of Object.entries(changes)) {
      await t.query(
        `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2::jsonb, now())
         ON CONFLICT (key) DO UPDATE SET value = $2::jsonb, updated_at = now()`,
        [key, JSON.stringify(value)]);
      applied[key] = { from: typeof values[key] === 'number' ? values[key] : null, to: value };
    }
    return { applied };
  });
}

// ───────────── 审计（§8.5，只读） ─────────────

const LIKE_ESCAPE = (value) => value.replace(/[\\%_]/g, '\\$&');

export async function listAudit(db, { adminId, action, targetType, targetId, from, to, cursor, limit }) {
  const where = [];
  const params = [];
  const add = (sql, value) => {
    params.push(value);
    where.push(sql.replaceAll('?', `$${params.length}`));
  };
  if (adminId) add(`a.admin_id = ?`, adminId);
  if (action) add(`a.action LIKE ? ESCAPE '\\'`, `${LIKE_ESCAPE(action)}%`); // 前缀匹配：channel. → channel.*
  if (targetType) add(`a.target_type = ?`, targetType);
  if (targetId) add(`a.target_id = ?`, targetId);
  if (from) add(`a.created_at >= ?::timestamptz`, from);
  if (to) add(`a.created_at < ?::timestamptz + interval '1 day'`, to); // to 按自然日含当天
  if (cursor) add(`a.id < ?::bigint`, cursor);
  const limitIndex = params.push(limit);
  const { rows } = await db.query(
    `SELECT a.id, a.action, a.target_type, a.target_id, a.detail, a.ip, a.created_at,
            a.admin_id, a.actor, u.username AS admin_username
       FROM admin_audit_logs a
       LEFT JOIN admin_users u ON u.id = a.admin_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY a.id DESC
      LIMIT $${limitIndex}`,
    params);
  return {
    items: rows.map((row) => ({
      id: Number(row.id),
      adminUsername: row.admin_username ?? (row.admin_id ?? row.actor),
      action: row.action, targetType: row.target_type, targetId: row.target_id,
      detail: row.detail ?? {}, ip: row.ip ?? null, createdAt: row.created_at.toISOString(),
    })),
    nextCursor: rows.length === limit ? String(rows[rows.length - 1].id) : null,
  };
}
