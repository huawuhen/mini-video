// 计价与报价（docs/API.md §3；CODEX_HANDOFF §6 M1-BE-02 要点 b/c）。
// 四种 kind 各一个计价函数，输出 amountFen / breakdown（中文）/ paramsHash / priceSnapshot。
// 报价单存 params_hash 与 price_snapshot（含生成报价时的请求参数，供使用时重算）；
// 使用时原子占用 → 按当前状态与价格重算 → 比对，不一致 409 QUOTE_MISMATCH（占用随调用方事务回滚），
// 过期或已消费 409 QUOTE_EXPIRED。
// project_render / segment_take 按作品锁定的 tier_mapping_id 取价（不是当前映射）；形象单价取
// settings.look_image_sku_code 指向的当前生效 SKU。
import { createHash } from 'node:crypto';
import { newId } from '../db/ids.js';
import { appError } from '../http/errors.js';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

async function getSettingValue(t, key) {
  const { rows } = await t.query(`SELECT value FROM settings WHERE key = $1`, [key]);
  return rows[0]?.value;
}

function getSettingNumber(value, fallback) {
  return typeof value === 'number' ? value : fallback;
}

async function latestActiveSku(t, skuCode) {
  const { rows } = await t.query(
    `SELECT sku_code, version, price_fen FROM skus
      WHERE sku_code = $1 AND status = 'active' AND effective_at <= now()
      ORDER BY version DESC LIMIT 1`,
    [skuCode],
  );
  return rows[0] ?? null;
}

/** settings.look_image_sku_code 指向的当前生效形象 SKU；配置缺失属运营问题，按 500 暴露。 */
async function getImageSku(t) {
  const code = await getSettingValue(t, 'look_image_sku_code');
  const sku = typeof code === 'string' ? await latestActiveSku(t, code) : null;
  if (!sku) throw appError('INTERNAL', '形象定价配置不可用，请稍后再试');
  return sku;
}

/** 作品锁定的档位映射 → 该映射 sku_code 的当前生效版本与档位名。 */
async function getVideoSkuByMapping(t, tierMappingId) {
  const { rows } = await t.query(
    `SELECT m.id AS mapping_id, m.video_sku_code, ty.name AS tier_name
       FROM tier_mappings m JOIN quality_tiers ty ON ty.id = m.tier_id
      WHERE m.id = $1`,
    [tierMappingId],
  );
  const sku = rows.length ? await latestActiveSku(t, rows[0].video_sku_code) : null;
  if (!sku) throw appError('INTERNAL', '画质定价不可用，请稍后再试');
  return { ...rows[0], ...sku };
}

async function getProject(t, userId, projectId) {
  const { rows } = await t.query(
    `SELECT p.id, p.tier_mapping_id, ty.name AS tier_name, st.name AS style_name
       FROM projects p
       JOIN quality_tiers ty ON ty.id = p.quality_tier_id
       JOIN styles st ON st.id = p.style_id
      WHERE p.id = $1 AND p.user_id = $2 AND p.deleted_at IS NULL`,
    [projectId, userId],
  );
  if (!rows.length) throw appError('NOT_FOUND');
  return rows[0];
}

async function priceLookRegenerate(t, { userId, characterId, styleId }) {
  const chr = await t.query(
    `SELECT id FROM characters WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
    [characterId, userId],
  );
  if (!chr.rows.length) throw appError('NOT_FOUND');
  const { rows: styles } = await t.query(`SELECT name FROM styles WHERE id = $1 AND status = 'active'`, [styleId]);
  if (!styles.length) throw appError('VALIDATION_FAILED', undefined, { fields: { styleId: '取值不正确' } });
  const sku = await getImageSku(t);
  return {
    amountFen: sku.price_fen,
    breakdown: [{ label: `生成形象 · ${styles[0].name}`, amountFen: sku.price_fen }],
    paramsHash: sha256(JSON.stringify({ kind: 'look_regenerate', characterId, styleId })),
    priceSnapshot: { request: { characterId, styleId }, image: { skuCode: sku.sku_code, version: sku.version, unitFen: sku.price_fen } },
    refType: 'character',
    refId: characterId,
  };
}

/** 确认点 A：为作品里缺形象的角色生成形象（缺形象 = project_cast.look_version_id 为空）。 */
async function priceCastLooks(t, { userId, projectId }) {
  const project = await getProject(t, userId, projectId);
  const { rows: cast } = await t.query(
    `SELECT id FROM project_cast WHERE project_id = $1 AND look_version_id IS NULL ORDER BY idx`,
    [projectId],
  );
  const sku = await getImageSku(t);
  const amountFen = sku.price_fen * cast.length;
  return {
    amountFen,
    breakdown: cast.length ? [{ label: `生成形象 × ${cast.length} · ${project.style_name}`, amountFen }] : [],
    paramsHash: sha256(JSON.stringify({ kind: 'cast_looks', projectId, castIds: cast.map((c) => c.id) })),
    priceSnapshot: { request: { projectId }, image: { skuCode: sku.sku_code, version: sku.version, unitFen: sku.price_fen } },
    refType: 'project',
    refId: projectId,
  };
}

/** 确认点 B：本片全部片段的视频费；按作品锁定的 tier_mapping_id 取价。 */
async function priceProjectRender(t, { userId, projectId }) {
  const project = await getProject(t, userId, projectId);
  const { rows: segments } = await t.query(
    `SELECT id, idx, duration_seconds FROM segments WHERE project_id = $1 ORDER BY idx`,
    [projectId],
  );
  const sku = await getVideoSkuByMapping(t, project.tier_mapping_id);
  const amountFen = segments.reduce((sum, s) => sum + s.duration_seconds, 0) * sku.price_fen;
  return {
    amountFen,
    breakdown: segments.map((s) => ({
      label: `片段 ${s.idx + 1} · ${s.duration_seconds} 秒 · ${project.tier_name}`,
      amountFen: s.duration_seconds * sku.price_fen,
    })),
    paramsHash: sha256(JSON.stringify({ kind: 'project_render', projectId, segments: segments.map((s) => [s.id, s.duration_seconds]) })),
    priceSnapshot: { request: { projectId }, video: { skuCode: sku.sku_code, version: sku.version, unitFen: sku.price_fen } },
    refType: 'project',
    refId: projectId,
  };
}

/** 交付后重生成单个片段；同样按作品锁定的 tier_mapping_id 取价。§6 审查 5：校验 segment 属于传入的作品。 */
async function priceSegmentTake(t, { userId, projectId, segmentId }) {
  const { rows } = await t.query(
    `SELECT s.id, s.idx, s.duration_seconds, p.tier_mapping_id
       FROM segments s
       JOIN projects p ON p.id = s.project_id AND p.deleted_at IS NULL
      WHERE s.id = $1 AND p.id = $2 AND p.user_id = $3`,
    [segmentId, projectId, userId],
  );
  if (!rows.length) throw appError('NOT_FOUND');
  const segment = rows[0];
  const sku = await getVideoSkuByMapping(t, segment.tier_mapping_id);
  const amountFen = segment.duration_seconds * sku.price_fen;
  return {
    amountFen,
    breakdown: [{ label: `片段 ${segment.idx + 1} · ${segment.duration_seconds} 秒 · ${sku.tier_name}`, amountFen }],
    paramsHash: sha256(JSON.stringify({ kind: 'segment_take', projectId, segmentId, durationSeconds: segment.duration_seconds })),
    priceSnapshot: { request: { projectId, segmentId }, video: { skuCode: sku.sku_code, version: sku.version, unitFen: sku.price_fen } },
    refType: 'segment',
    refId: segmentId,
  };
}

/** kind → 计价函数与必填参数（路由层据此校验）。 */
export const QUOTE_KINDS = {
  cast_looks: { fn: priceCastLooks, fields: ['projectId'] },
  project_render: { fn: priceProjectRender, fields: ['projectId'] },
  look_regenerate: { fn: priceLookRegenerate, fields: ['characterId', 'styleId'] },
  segment_take: { fn: priceSegmentTake, fields: ['projectId', 'segmentId'] },
};

export async function createQuote(t, { userId, request }) {
  const priced = await QUOTE_KINDS[request.kind].fn(t, { userId, ...request });
  const ttlSeconds = getSettingNumber(await getSettingValue(t, 'quote_ttl_seconds'), 900);
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
  const { rows } = await t.query(
    `INSERT INTO quotes (id, user_id, kind, ref_type, ref_id, params_hash, amount_fen, breakdown, price_snapshot, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id, kind, amount_fen, breakdown, expires_at`,
    [newId('qt'), userId, request.kind, priced.refType, priced.refId, priced.paramsHash, priced.amountFen,
      JSON.stringify(priced.breakdown), priced.priceSnapshot, expiresAt],
  );
  const row = rows[0];
  return { quoteId: row.id, kind: row.kind, amountFen: row.amount_fen, breakdown: row.breakdown, expiresAt: row.expires_at.toISOString() };
}

/**
 * 原子占用报价并按当前状态与价格重算（要点 c）。
 * §6 审查 5：调用方必须声明正在确认的资源（kind/refType/refId），与报价不一致抛 QUOTE_MISMATCH，
 * 防止「拿 A 作品的便宜报价确认 B 作品」；MISMATCH/EXPIRED 抛错时占用随调用方事务回滚。
 */
export async function consumeQuote(t, { userId, quoteId, kind, refType, refId }) {
  if (!kind || !refType || !refId) throw appError('INTERNAL', 'consumeQuote 缺少 kind/refType/refId');
  const { rows } = await t.query(
    `UPDATE quotes SET consumed_at = now()
      WHERE id = $1 AND user_id = $2 AND consumed_at IS NULL AND expires_at > now()
      RETURNING id, kind, ref_type, ref_id, params_hash, amount_fen, price_snapshot`,
    [quoteId, userId],
  );
  if (!rows.length) {
    const { rowCount } = await t.query(`SELECT 1 FROM quotes WHERE id = $1 AND user_id = $2`, [quoteId, userId]);
    if (rowCount === 0) throw appError('NOT_FOUND');
    throw appError('QUOTE_EXPIRED');
  }
  const quote = rows[0];
  if (quote.kind !== kind || quote.ref_type !== refType || quote.ref_id !== refId) {
    throw appError('QUOTE_MISMATCH');
  }
  const priced = await QUOTE_KINDS[quote.kind].fn(t, { userId, ...quote.price_snapshot.request });
  if (priced.paramsHash !== quote.params_hash || priced.amountFen !== quote.amount_fen) {
    throw appError('QUOTE_MISMATCH');
  }
  return { quote, priced };
}

/** 档位当前生效的映射与 SKU（最新已生效版本），无则返回 null。 */
export async function getActiveTierSku(t, tierId) {
  const { rows } = await t.query(
    `SELECT m.id AS mapping_id, m.video_sku_code, ty.name AS tier_name, s.sku_code, s.version AS sku_version, s.price_fen, s.durations
       FROM tier_mappings m
       JOIN quality_tiers ty ON ty.id = m.tier_id
       JOIN LATERAL (
         SELECT k.sku_code, k.version, k.price_fen, k.durations FROM skus k
          WHERE k.sku_code = m.video_sku_code AND k.status = 'active' AND k.effective_at <= now()
          ORDER BY k.version DESC LIMIT 1
       ) s ON true
      WHERE m.tier_id = $1 AND m.effective_at <= now()
      ORDER BY m.version DESC LIMIT 1`,
    [tierId],
  );
  return rows[0] ?? null;
}

/**
 * 首页价格区间估算（不生成报价单）。PRD §6.3【默认口径，§6 审查 6 已对齐】：
 * 下限 = 1 个 30 秒片段的视频费（30 取 min(30, SKU 最长单段时长)）；
 * 上限 = 最长作品时长的视频费；
 * 形象费按「本风格缺形象的已勾选数字人数」计入上下限（缺形象 = 无该风格形象，或选中版本不是 succeeded）。
 */
export async function estimateQuote(t, { userId, qualityTierId, styleId, characterIds }) {
  const { rows: styles } = await t.query(`SELECT id FROM styles WHERE id = $1 AND status = 'active'`, [styleId]);
  if (!styles.length) throw appError('VALIDATION_FAILED', undefined, { fields: { styleId: '取值不正确' } });
  if (characterIds.length) {
    const { rows } = await t.query(
      `SELECT count(*)::int AS n FROM characters WHERE id = ANY($1) AND user_id = $2 AND deleted_at IS NULL`,
      [characterIds, userId],
    );
    if (rows[0].n !== characterIds.length) throw appError('NOT_FOUND');
  }
  const tier = await getActiveTierSku(t, qualityTierId);
  if (!tier) throw appError('VALIDATION_FAILED', undefined, { fields: { qualityTierId: '取值不正确' } });
  const imageSku = await getImageSku(t);
  const maxSeconds = getSettingNumber(await getSettingValue(t, 'max_duration_seconds'), 90);
  const durations = Array.isArray(tier.durations) && tier.durations.length ? tier.durations : [30];
  const baseSeconds = Math.min(30, Math.max(...durations));
  const { rows: missing } = await t.query(
    `SELECT count(*)::int AS n
       FROM characters c
      WHERE c.id = ANY($1) AND c.user_id = $2 AND c.deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1
            FROM character_looks cl
            JOIN look_versions lv ON lv.id = cl.selected_version_id
           WHERE cl.character_id = c.id AND cl.style_id = $3 AND lv.status = 'succeeded')`,
    [characterIds, userId, styleId],
  );
  const looksFen = missing[0].n * imageSku.price_fen;
  return {
    minFen: tier.price_fen * baseSeconds + looksFen,
    maxFen: tier.price_fen * maxSeconds + looksFen,
  };
}
