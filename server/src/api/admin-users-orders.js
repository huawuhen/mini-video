// 管理端·用户与余额 / 订单与人工退款路由（M3-ADM-02，docs/API.md §8.1~8.2）。
// 与渠道管理同一套独立会话（miv_admin）+ 同源 + CSRF（writeGuard）；全部写操作写 admin_audit_logs。
// 手机号只支持完整号码精确搜索；搜索行为记审计（detail 只含掩码，不落明文手机号）。
import { Router } from 'express';
import { asyncHandler } from '../http/middleware.js';
import { Fields } from '../http/validate.js';
import { appError } from '../http/errors.js';
import { createAdminAuth } from '../channels/admin-auth.js';
import { maskPhone } from '../auth/sms.js';
import * as users from '../admin/users.js';
import * as orders from '../admin/orders.js';

const PAGE_DEFAULT = 20;
const PAGE_MAX = 50;

/** 分页 limit（API.md §0：默认 20，最大 50）。 */
function pageLimit(req) {
  const raw = req.query.limit === undefined ? PAGE_DEFAULT : Number(req.query.limit);
  if (!Number.isInteger(raw) || raw < 1 || raw > PAGE_MAX) {
    throw appError('VALIDATION_FAILED', undefined, { fields: { limit: `需为 1~${PAGE_MAX} 的整数` } });
  }
  return raw;
}

export function adminUsersOrdersRoutes({ db, config, logger, storage, payments = null }) {
  const router = Router();
  const auth = createAdminAuth({ config, db });
  const payClient = payments?.payClient ?? null;

  // 全部中间件与路由都限定在 /admin 路径内：本路由挂在 /api/v1 根上，
  // 非管理路径必须原样穿透到 404（不能像渠道管理路由那样拦截全部路径）
  router.use('/admin', auth.sessionMiddleware);
  router.use('/admin', auth.requireAdmin);
  // 写操作（非 GET/HEAD/OPTIONS）统一校验同源 + CSRF 头（admin-auth.writeGuard）
  router.use('/admin', auth.writeGuard);

  const audit = (req, action, targetType, targetId, detail = {}) => auth.audit({
    adminId: req.admin?.id ?? null, actor: 'admin', action, targetType, targetId: String(targetId ?? ''), detail,
  });

  // ── 用户（§8.1） ──

  router.get('/admin/users', asyncHandler(async (req, res) => {
    const phone = typeof req.query.phone === 'string' ? req.query.phone.trim() : '';
    if (phone && !/^1\d{10}$/.test(phone)) {
      throw appError('VALIDATION_FAILED', '请输入完整的 11 位手机号进行精确搜索');
    }
    const status = typeof req.query.status === 'string' && req.query.status
      ? req.query.status : undefined;
    if (status && !['active', 'disabled', 'deactivated'].includes(status)) {
      throw appError('VALIDATION_FAILED', undefined, { fields: { status: '取值不正确' } });
    }
    const result = await users.listUsers(db, {
      phone: phone || undefined,
      userId: typeof req.query.userId === 'string' && req.query.userId ? req.query.userId.trim() : undefined,
      status, cursor: typeof req.query.cursor === 'string' && req.query.cursor ? req.query.cursor : undefined,
      limit: pageLimit(req),
    });
    if (phone || req.query.userId) {
      // 搜索记审计：只记掩码/ID，不落明文手机号
      await audit(req, 'user.search', 'user', phone ? maskPhone(phone) : String(req.query.userId), { phone: phone ? maskPhone(phone) : undefined });
    }
    res.json(result);
  }));

  router.get('/admin/users/:id', asyncHandler(async (req, res) => {
    res.json(await users.getUserDetail(db, { userId: String(req.params.id) }));
  }));

  router.get('/admin/users/:id/ledger', asyncHandler(async (req, res) => {
    res.json(await users.listUserLedger(db, {
      userId: String(req.params.id),
      cursor: typeof req.query.cursor === 'string' && req.query.cursor ? req.query.cursor : undefined,
      limit: pageLimit(req),
    }));
  }));

  router.post('/admin/users/:id/adjust', asyncHandler(async (req, res) => {
    const fields = new Fields(req.body);
    const body = {
      amountFen: fields.int('amountFen', { required: true }),
      reason: fields.string('reason', { required: true, max: 200 }),
      idempotencyKey: fields.string('idempotencyKey', { required: true, max: 100 }),
    };
    fields.done();
    if (body.amountFen === 0) throw appError('VALIDATION_FAILED', '调整金额不能为 0');
    // 服务端加 admin: 前缀再进账本，避免与内部幂等键（recharge:<订单>/deactivate:<用户>）共用命名空间
    const result = await users.adjustBalance(db, { userId: String(req.params.id), ...body,
      idempotencyKey: `admin:adjust:${body.idempotencyKey}`, adminId: req.admin.id });
    await audit(req, 'wallet.adjust', 'user', req.params.id,
      { amountFen: body.amountFen, reason: body.reason, idempotencyKey: body.idempotencyKey });
    res.json({ wallet: result.wallet, entry: result.entry });
  }));

  router.post('/admin/users/:id/disable', asyncHandler(async (req, res) => {
    const fields = new Fields(req.body);
    const body = { reason: fields.string('reason', { required: true, max: 200 }) };
    fields.done();
    const user = await users.disableUser(db, { userId: String(req.params.id) });
    await audit(req, 'user.disable', 'user', req.params.id, { reason: body.reason });
    res.json(user);
  }));

  router.post('/admin/users/:id/enable', asyncHandler(async (req, res) => {
    const fields = new Fields(req.body);
    const body = { reason: fields.string('reason', { required: true, max: 200 }) };
    fields.done();
    const user = await users.enableUser(db, { userId: String(req.params.id) });
    await audit(req, 'user.enable', 'user', req.params.id, { reason: body.reason });
    res.json(user);
  }));

  router.post('/admin/users/:id/deactivate', asyncHandler(async (req, res) => {
    const fields = new Fields(req.body);
    const body = {
      reason: fields.string('reason', { required: true, max: 200 }),
      confirm: fields.bool('confirm', { required: true }),
    };
    fields.done();
    if (body.confirm !== true) {
      throw appError('VALIDATION_FAILED', '注销不可恢复，需要 confirm=true 二次确认');
    }
    const { user, filesFailed, balanceClearedFen } = await users.deactivateUser(db, {
      userId: String(req.params.id), reason: body.reason, adminId: req.admin.id, storage, logger,
    });
    await audit(req, 'user.deactivate', 'user', req.params.id,
      { reason: body.reason, balanceClearedFen, filesFailed });
    res.json(user);
  }));

  // ── 充值订单与人工退款（§8.2） ──

  router.get('/admin/orders', asyncHandler(async (req, res) => {
    const status = typeof req.query.status === 'string' && req.query.status ? req.query.status : undefined;
    if (status && !['created', 'paid', 'expired', 'failed'].includes(status)) {
      throw appError('VALIDATION_FAILED', undefined, { fields: { status: '取值不正确' } });
    }
    res.json(await orders.listOrders(db, {
      status,
      userId: typeof req.query.userId === 'string' && req.query.userId ? req.query.userId.trim() : undefined,
      outTradeNo: typeof req.query.outTradeNo === 'string' && req.query.outTradeNo ? req.query.outTradeNo.trim() : undefined,
      from: typeof req.query.from === 'string' && req.query.from ? req.query.from : undefined,
      to: typeof req.query.to === 'string' && req.query.to ? req.query.to : undefined,
      cursor: typeof req.query.cursor === 'string' && req.query.cursor ? req.query.cursor : undefined,
      limit: pageLimit(req),
    }));
  }));

  router.get('/admin/orders/:id', asyncHandler(async (req, res) => {
    res.json(await orders.getOrder(db, { orderId: String(req.params.id) }));
  }));

  router.post('/admin/orders/:id/reconcile', asyncHandler(async (req, res) => {
    const order = await orders.reconcileOrder(db, { orderId: String(req.params.id) }, { payClient, logger });
    await audit(req, 'order.reconcile', 'payment_order', req.params.id, { status: order.status });
    res.json(order);
  }));

  router.post('/admin/orders/:id/refund', asyncHandler(async (req, res) => {
    const fields = new Fields(req.body);
    const body = {
      amountFen: fields.int('amountFen', { required: true, min: 1 }),
      reason: fields.string('reason', { required: true, max: 200 }),
      idempotencyKey: fields.string('idempotencyKey', { required: true, max: 100 }),
    };
    fields.done();
    const result = await orders.refundOrder(db, { orderId: String(req.params.id), ...body,
      idempotencyKey: `admin:refund:${body.idempotencyKey}`, adminId: req.admin.id });
    await audit(req, 'order.refund', 'payment_order', req.params.id,
      { amountFen: body.amountFen, reason: body.reason, idempotencyKey: body.idempotencyKey });
    res.json(result);
  }));

  return router;
}
