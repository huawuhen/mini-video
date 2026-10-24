// 管理端路由（docs/API.md §8，仅运营后台与运维脚本使用，用户端不调用）。
// 独立管理员账号与会话（Cookie miv_admin，admin-auth.js）；写操作同源 + CSRF；全部写审计。
// 渠道凭证只写不读：创建/更新时传明文，之后接口只返回 credentialMask（后 4 位）。
// M2-BE-03：无自动转移参数（用户 2026-10-24 决定不做自动探活/自动故障转移/金丝雀）。
import { Router } from 'express';
import { asyncHandler } from '../http/middleware.js';
import { appError } from '../http/errors.js';
import { Fields } from '../http/validate.js';
import { createAdminAuth } from '../channels/admin-auth.js';
import { decryptCredential, credentialMask } from '../channels/crypto.js';

const adminFail = (status, code, message) => {
  const registered = ['ADMIN_AUTH_REQUIRED', 'CHANNEL_NOT_FOUND', 'DRIVER_NOT_FOUND', 'CHANNEL_TEST_FAILED'].includes(code);
  const error = registered ? appError(code, message) : appError(status === 404 ? 'NOT_FOUND' : 'VALIDATION_FAILED', message);
  if (!registered) { error.code = code; error.status = status; }
  return error;
};

/** 渠道行 → API.md §8 Channel（掩码由明文后 4 位生成；解密只为取掩码，不返回明文）。 */
function toChannelJson(row, extras = {}) {
  let mask = '****';
  try { if (row.credential_enc) mask = credentialMask(decryptCredential(row.__secretKey, row.credential_enc)); } catch { /* 无法解密（含已清除）只显示全遮 */ }
  return {
    id: row.id, kind: row.kind, name: row.name, driver: row.driver, baseUrl: row.base_url,
    credentialMask: mask, modelMap: row.model_map ?? {}, params: row.params ?? {},
    costFen: row.cost_fen ?? {}, status: row.status, remark: row.remark,
    createdAt: row.created_at?.toISOString?.(), updatedAt: row.updated_at?.toISOString?.(),
    ...extras,
  };
}

/**
 * @param deps { db, config, logger, service, registry, secretKey }
 *        service/registry 来自渠道层（app 装配时创建并注入）
 */
export function adminRoutes({ db, config, logger, service, registry, secretKey }) {
  const router = Router();
  const auth = createAdminAuth({ config, db });

  router.use(auth.sessionMiddleware);

  const audit = (req, action) => (detail) => auth.audit({
    adminId: req.admin?.id ?? null, actor: 'admin', action, ...detail,
  });

  // ── 登录 / 登出 ──
  router.post('/admin/auth/login', asyncHandler(async (req, res) => {
    const fields = new Fields(req.body);
    const body = { username: fields.string('username', { required: true }),
      password: fields.string('password', { required: true }) };
    fields.done();
    const session = await auth.login({ ...body, ip: req.ip });
    if (!session) throw adminFail(401, 'ADMIN_AUTH_REQUIRED', '用户名或密码不正确');
    auth.setCookie(res, session.token);
    res.json({ admin: session.admin, csrfToken: session.csrfToken });
  }));

  router.post('/admin/auth/logout', (req, res) => {
    void auth.logout(auth.readCookie(req));
    auth.clearCookie(res);
    res.json({ ok: true });
  });

  // ── 登录后的全部端点 ──
  router.use(auth.requireAdmin);

  // 代码里可用的协议驱动（新增渠道表单据此渲染）
  router.get('/admin/drivers', (_req, res) => {
    res.json({ items: registry.list() });
  });

  // 渠道列表（health/inFlight/成本标记随行附带）
  router.get('/admin/channels', asyncHandler(async (req, res) => {
    const kind = req.query.kind || undefined;
    const includeRetired = req.query.includeRetired === 'true';
    const rows = await service.listChannels({ kind, includeRetired });
    const health = await service.healthFor(rows.map((row) => row.id));
    const items = [];
    for (const row of rows) {
      items.push(toChannelJson({ ...row, __secretKey: secretKey }, {
        unavailable: registry.has(row.driver) ? undefined : true,
        inFlight: health.get(row.id)?.inFlight ?? 0,
        recent: health.get(row.id) ? {
          total: health.get(row.id).total, failed: health.get(row.id).failed,
          avgQueueSeconds: health.get(row.id).avgQueueSeconds,
        } : null,
        costVsPrice: await service.costVsPrice(row),
      }));
    }
    res.json({ items });
  }));

  router.post('/admin/channels', asyncHandler(async (req, res) => {
    const fields = new Fields(req.body);
    const body = {
      kind: fields.string('kind', { required: true }),
      name: fields.string('name', { required: true }),
      driver: fields.string('driver', { required: true }),
      baseUrl: fields.string('baseUrl', { required: true }),
      credential: fields.string('credential', { required: true, max: 4096 }),
      modelMap: fields.object('modelMap', { required: true }),
      params: fields.object('params'),
      costFen: fields.object('costFen'),
      remark: fields.string('remark'),
    };
    fields.done();
    const row = await service.createChannel(body, audit(req, 'channel.create'));
    res.status(201).json(toChannelJson({ ...row, __secretKey: secretKey }));
  }));

  router.patch('/admin/channels/:id', asyncHandler(async (req, res) => {
    const id = String(req.params.id);
    const patch = new Fields(req.body);
    const body = {
      name: patch.string('name'),
      baseUrl: patch.string('baseUrl'),
      credential: patch.string('credential', { max: 4096 }),
      modelMap: patch.object('modelMap'),
      params: patch.object('params'),
      costFen: patch.object('costFen'),
      remark: patch.string('remark'),
    };
    patch.done();
    const fields = Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined));
    const row = await service.updateChannel(id, fields, audit(req, 'channel.update'));
    res.json(toChannelJson({ ...row, __secretKey: secretKey }));
  }));

  router.post('/admin/channels/:id/test', asyncHandler(async (req, res) => {
    const id = String(req.params.id);
    const row = await service.getChannel(id);
    if (!row) throw adminFail(404, 'CHANNEL_NOT_FOUND', '渠道不存在');
    const started = Date.now();
    try {
      const instance = service.instanceForRow(row, {});
      const catalog = await instance.catalog();
      const modelMap = row.model_map ?? {};
      const mismatches = Object.entries(modelMap)
        .filter(([, model]) => model && !catalog.models.some((item) => item.name === model))
        .map(([capability, model]) => ({ capability, model, reason: 'MODEL_MISSING' }));
      res.json({ ok: true, latencyMs: Date.now() - started, models: catalog.models, mismatches });
    } catch (error) {
      throw adminFail(400, 'CHANNEL_TEST_FAILED', `连接测试失败：${error?.message ?? '未知错误'}`);
    }
  }));

  // 试生成（真实费用）：必须 confirm:true，写审计（actor=trial）；最小成本由驱动决定
  router.post('/admin/channels/:id/trial', asyncHandler(async (req, res) => {
    const id = String(req.params.id);
    const trial = new Fields(req.body);
    const body = { capability: trial.string('capability', { required: true }),
      confirm: trial.bool('confirm', { required: true }) };
    trial.done();
    if (body.confirm !== true) throw adminFail(400, 'VALIDATION_FAILED', '试生成会产生真实费用，需要 confirm=true 二次确认');
    const row = await service.getChannel(id);
    if (!row) throw adminFail(404, 'CHANNEL_NOT_FOUND', '渠道不存在');
    await auth.audit({ actor: 'trial', action: 'channel.trial', targetType: 'provider_channel',
      targetId: id, detail: { capability: body.capability, adminId: req.admin?.id ?? null } });
    // 试生成涉及真实计费，M3-ADM-01 后台上线前用渠道冒烟脚本执行；此处登记审计并返回操作指引
    res.json({ ok: false, message: '试生成请使用渠道冒烟脚本（真实计费），本次仅登记审计', capability: body.capability });
  }));

  router.put('/admin/routes/:kind/:capability', asyncHandler(async (req, res) => {
    const { kind, capability } = req.params;
    const route = new Fields(req.body);
    const body = { channelIds: route.array('channelIds', { required: true }) };
    route.done();
    await service.setRoutes(kind, capability === '*' ? '*' : capability, body.channelIds, audit(req, 'route.set'));
    const routes = await service.getRoutes(kind);
    res.json({ items: routes.filter((route) => route.capability === (capability === '*' ? '*' : capability)) });
  }));

  router.get('/admin/routes/:kind', asyncHandler(async (req, res) => {
    res.json({ items: await service.getRoutes(String(req.params.kind)) });
  }));

  const statusFlip = (status) => asyncHandler(async (req, res) => {
    const row = await service.setChannelStatus(String(req.params.id), status, audit(req, `channel.${status === 'active' ? 'enable' : 'disable'}`));
    res.json(toChannelJson({ ...row, __secretKey: secretKey }));
  });
  router.post('/admin/channels/:id/enable', statusFlip('active'));
  router.post('/admin/channels/:id/disable', statusFlip('disabled'));

  router.delete('/admin/channels/:id', asyncHandler(async (req, res) => {
    const row = await service.retireChannel(String(req.params.id), audit(req, 'channel.retire'));
    res.json(toChannelJson({ ...row, __secretKey: secretKey }));
  }));

  router.get('/admin/channels/health', asyncHandler(async (_req, res) => {
    const rows = await service.listChannels({ includeRetired: true });
    const health = await service.healthFor(rows.map((row) => row.id));
    res.json({ items: rows.map((row) => ({ channelId: row.id, kind: row.kind, name: row.name,
      status: row.status, ...(health.get(row.id) ?? { total: 0, failed: 0 }) })) });
  }));

  return router;
}
