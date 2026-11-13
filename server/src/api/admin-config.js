// 管理端·价格与配置 / 审计路由（M3-ADM-04，docs/API.md §8.4~8.5）。
// 与渠道/用户管理同一套独立会话（miv_admin）+ 同源 + CSRF（writeGuard）；
// 全部写操作写 admin_audit_logs（含 IP）。限定 /admin 路径挂载，不影响非管理路径的 404 语义。
import { Router } from 'express';
import { asyncHandler } from '../http/middleware.js';
import { Fields } from '../http/validate.js';
import { appError } from '../http/errors.js';
import { newId } from '../db/ids.js';
import { createAdminAuth } from '../channels/admin-auth.js';
import { readSingleFile, detectImageMime, detectAudioMime } from './uploads.js';
import * as cfg from '../admin/pricing-config.js';

const UPLOAD_MAX_BYTES = 5 * 1024 * 1024; // API.md §8.4：图片 / 音频都 ≤5MB
const PAGE_DEFAULT = 20;
const PAGE_MAX = 50;

function pageLimit(req) {
  const raw = req.query.limit === undefined ? PAGE_DEFAULT : Number(req.query.limit);
  if (!Number.isInteger(raw) || raw < 1 || raw > PAGE_MAX) {
    throw appError('VALIDATION_FAILED', undefined, { fields: { limit: `需为 1~${PAGE_MAX} 的整数` } });
  }
  return raw;
}

/** ISO 8601 或 YYYY-MM-DD → Date；非法值抛校验错误。 */
function dateField(fields, name) {
  const raw = fields.string(name, { max: 40 });
  if (raw === undefined) return undefined;
  const time = Date.parse(raw);
  if (Number.isNaN(time)) {
    fields.errors[name] = '需为合法时间（如 2026-01-01 或 ISO 8601）';
    return undefined;
  }
  return new Date(time);
}

const AUDIO_EXT = { 'audio/mpeg': '.mp3', 'audio/wav': '.wav', 'audio/mp4': '.m4a' };
const IMAGE_EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };

export function adminConfigRoutes({ db, config, logger, storage, urlFor }) {
  const router = Router();
  const auth = createAdminAuth({ config, db });

  router.use('/admin', auth.sessionMiddleware);
  router.use('/admin', auth.requireAdmin);
  router.use('/admin', auth.writeGuard);

  const audit = (req, action, targetType, targetId, detail = {}) => auth.audit({
    adminId: req.admin?.id ?? null, actor: 'admin', action, targetType, targetId: String(targetId ?? ''), detail,
    ip: req.ip ?? null,
  });

  // ── 管理端上传（§8.4：风格封面 / 音色试听与参考音频） ──

  router.post('/admin/uploads', asyncHandler(async (req, res) => {
    const file = await readSingleFile(req, UPLOAD_MAX_BYTES);
    const mime = detectImageMime(file.buffer) ?? detectAudioMime(file.buffer);
    if (!mime) throw appError('UPLOAD_TYPE_INVALID', '只支持图片（jpg/png/webp）或音频（mp3/wav/m4a）');
    const kind = mime.startsWith('image/') ? 'image' : 'audio';
    const uploadId = newId('upl');
    const key = `admin/uploads/${uploadId}${(kind === 'image' ? IMAGE_EXT : AUDIO_EXT)[mime] ?? ''}`;
    await storage.put(key, file.buffer, { contentType: mime });
    // 管理端上传无用户归属（user_id 空）；被风格/音色引用时才置 referenced_at，否则 24h 后由 uploads.sweep 清理
    await db.query(
      `INSERT INTO uploads (id, user_id, kind, storage_key, mime, size_bytes) VALUES ($1, NULL, $2, $3, $4, $5)`,
      [uploadId, kind, key, mime, file.size],
    );
    logger.info('admin_upload', { uploadId, kind, size: file.size, mime });
    await audit(req, 'upload.create', 'upload', uploadId, { kind, sizeBytes: file.size, mime });
    const url = urlFor(key);
    res.json(url ? { uploadId, url } : { uploadId });
  }));

  // ── SKU 价格版本（§8.4） ──

  router.get('/admin/skus', asyncHandler(async (_req, res) => {
    res.json(await cfg.listSkus(db));
  }));

  router.post('/admin/skus/:skuCode/versions', asyncHandler(async (req, res) => {
    const fields = new Fields(req.body);
    const body = {
      // 上限 10000 分（¥100/单位）：现行最高价 200 分/秒，防误输入多敲一位数字（复审建议 c）
      priceFen: fields.int('priceFen', { required: true, min: 0, max: 10_000 }),
      costFen: fields.int('costFen', { min: 0 }),
      effectiveAt: dateField(fields, 'effectiveAt'),
      idempotencyKey: fields.string('idempotencyKey', { required: true, max: 100 }),
    };
    fields.done();
    const { replayed, sku } = await cfg.createSkuVersion(db, {
      skuCode: String(req.params.skuCode), ...body, adminId: req.admin.id,
      idempotencyKey: `admin:sku-version:${body.idempotencyKey}`,
    });
    if (!replayed) {
      await audit(req, 'sku.version.create', 'sku', req.params.skuCode,
        { priceFen: body.priceFen, costFen: body.costFen ?? undefined, effectiveAt: body.effectiveAt?.toISOString(),
          idempotencyKey: body.idempotencyKey, newVersion: sku?.version });
    }
    res.json(sku);
  }));

  // ── 档位与映射（§8.4） ──

  router.get('/admin/tiers', asyncHandler(async (_req, res) => {
    res.json(await cfg.listTiers(db));
  }));

  router.patch('/admin/tiers/:id', asyncHandler(async (req, res) => {
    const fields = new Fields(req.body);
    const patch = {
      name: fields.string('name', { max: 40 }),
      note: fields.string('note', { max: 200 }),
      sort: fields.int('sort', { min: 0, max: 10000 }),
      status: fields.oneOf('status', ['active', 'inactive']),
    };
    fields.done();
    const { tier } = await cfg.updateTier(db, { tierId: String(req.params.id), patch });
    await audit(req, 'tier.update', 'quality_tier', req.params.id, { patch });
    res.json(tier);
  }));

  router.post('/admin/tiers/:id/mappings', asyncHandler(async (req, res) => {
    const fields = new Fields(req.body);
    const body = { videoSkuCode: fields.string('videoSkuCode', { required: true, max: 60 }) };
    fields.done();
    const { mapping } = await cfg.createTierMapping(db, { tierId: String(req.params.id), ...body });
    await audit(req, 'tier.mapping.create', 'tier_mapping', mapping.id, { ...body, version: mapping.version });
    res.json(mapping);
  }));

  // ── 风格（§8.4） ──

  router.get('/admin/styles', asyncHandler(async (_req, res) => {
    res.json(await cfg.listStyles(db, { urlFor }));
  }));

  function styleFields(fields, { required = false } = {}) {
    return {
      name: fields.string('name', { required, max: 40 }),
      description: fields.string('description', { max: 200 }),
      promptHint: fields.string('promptHint', { max: 500 }),
      coverUploadId: fields.string('coverUploadId', { max: 40 }),
      sort: fields.int('sort', { min: 0, max: 10000 }),
      status: fields.oneOf('status', ['active', 'inactive']),
    };
  }

  router.post('/admin/styles', asyncHandler(async (req, res) => {
    const fields = new Fields(req.body);
    const body = styleFields(fields, { required: true });
    fields.done();
    if (!body.name) throw appError('VALIDATION_FAILED', undefined, { fields: { name: '必填' } });
    const { id } = await cfg.createStyle(db, { body });
    await audit(req, 'style.create', 'style', id, { name: body.name });
    res.json({ id });
  }));

  router.patch('/admin/styles/:id', asyncHandler(async (req, res) => {
    const fields = new Fields(req.body);
    const patch = styleFields(fields);
    fields.done();
    // coverUploadId 显式传 null = 清除封面（Fields 对 null 视为缺省，这里单独识别）
    if (req.body?.coverUploadId === null) patch.coverUploadId = null;
    const style = await cfg.updateStyle(db, { styleId: String(req.params.id), patch });
    await audit(req, 'style.update', 'style', req.params.id, { patch: { ...patch, coverUploadId: patch.coverUploadId ?? undefined } });
    res.json(style);
  }));

  // ── 音色（§8.4） ──

  router.get('/admin/voices', asyncHandler(async (_req, res) => {
    res.json(await cfg.listVoices(db, { urlFor }));
  }));

  function voiceFields(fields, { required = false } = {}) {
    return {
      name: fields.string('name', { required, max: 40 }),
      category: fields.oneOf('category', cfg.VOICE_CATEGORIES),
      gender: fields.oneOf('gender', cfg.VOICE_GENDERS),
      ageGroup: fields.oneOf('ageGroup', cfg.VOICE_AGE_GROUPS),
      description: fields.string('description', { max: 200 }),
      sampleUploadId: fields.string('sampleUploadId', { max: 40 }),
      refAudioUploadId: fields.string('refAudioUploadId', { max: 40 }),
      sort: fields.int('sort', { min: 0, max: 10000 }),
      status: fields.oneOf('status', ['active', 'inactive']),
    };
  }

  function requireVoiceCore(body, fields) {
    for (const key of ['name', 'category', 'gender', 'ageGroup']) {
      if (body[key] === undefined) fields.errors[key] = '必填';
    }
    fields.done();
  }

  router.post('/admin/voices', asyncHandler(async (req, res) => {
    const fields = new Fields(req.body);
    const body = voiceFields(fields, { required: true });
    requireVoiceCore(body, fields);
    const { id } = await cfg.createVoice(db, { body });
    await audit(req, 'voice.create', 'voice', id, { name: body.name });
    res.json({ id });
  }));

  router.patch('/admin/voices/:id', asyncHandler(async (req, res) => {
    const fields = new Fields(req.body);
    const patch = voiceFields(fields);
    if (req.body?.sampleUploadId === null) patch.sampleUploadId = null;
    if (req.body?.refAudioUploadId === null) patch.refAudioUploadId = null;
    fields.done();
    const voice = await cfg.updateVoice(db, { voiceId: String(req.params.id), patch });
    await audit(req, 'voice.update', 'voice', req.params.id,
      { patch: { ...patch, sampleUploadId: patch.sampleUploadId ?? undefined, refAudioUploadId: patch.refAudioUploadId ?? undefined } });
    res.json(voice);
  }));

  // ── 运营参数（§8.4，白名单） ──

  router.get('/admin/settings', asyncHandler(async (_req, res) => {
    res.json(await cfg.getSettings(db));
  }));

  router.patch('/admin/settings', asyncHandler(async (req, res) => {
    const changes = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : null;
    if (!changes || !Object.keys(changes).length) {
      throw appError('VALIDATION_FAILED', undefined, { fields: { body: '至少要修改一项' } });
    }
    const errors = {};
    const parsed = {};
    for (const [key, value] of Object.entries(changes)) {
      const def = cfg.SETTING_DEFS[key];
      if (!def) throw appError('SETTING_KEY_NOT_ALLOWED', `「${key}」不在可修改的运营参数里`);
      if (!Number.isInteger(value) || value < def.min || value > def.max) {
        errors[key] = `需为 ${def.min}~${def.max} 的整数`;
      } else {
        parsed[key] = value;
      }
    }
    if (Object.keys(errors).length) throw appError('VALIDATION_FAILED', undefined, { fields: errors });
    const { applied } = await cfg.updateSettings(db, { changes: parsed });
    await audit(req, 'settings.update', 'setting', Object.keys(parsed).join(','), { changes: applied });
    res.json(await cfg.getSettings(db));
  }));

  // ── 审计（§8.5，只读） ──

  router.get('/admin/audit', asyncHandler(async (req, res) => {
    res.json(await cfg.listAudit(db, {
      adminId: typeof req.query.adminId === 'string' && req.query.adminId ? req.query.adminId.trim() : undefined,
      action: typeof req.query.action === 'string' && req.query.action ? req.query.action.trim() : undefined,
      targetType: typeof req.query.targetType === 'string' && req.query.targetType ? req.query.targetType.trim() : undefined,
      targetId: typeof req.query.targetId === 'string' && req.query.targetId ? req.query.targetId.trim() : undefined,
      from: dateParam(req.query.from, 'from'),
      to: dateParam(req.query.to, 'to'),
      cursor: typeof req.query.cursor === 'string' && req.query.cursor ? req.query.cursor : undefined,
      limit: pageLimit(req),
    }));
  }));

  return router;
}

/** from/to 查询参数：YYYY-MM-DD 或 ISO；from 保留完整时间，to 截到日期（服务端含当天）。 */
function dateParam(raw, name) {
  if (typeof raw !== 'string' || !raw) return undefined;
  const time = Date.parse(raw);
  if (Number.isNaN(time)) throw appError('VALIDATION_FAILED', undefined, { fields: { [name]: '需为合法日期' } });
  return name === 'from' ? new Date(time).toISOString() : new Date(time).toISOString().slice(0, 10);
}
