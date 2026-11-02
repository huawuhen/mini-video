// 充值与公众号授权路由（M3-PAY-02，API §3.1）。全部要求登录；
// /wallet/recharge/options 必须先于 /wallet/recharge/:orderId 注册（API 实现提示）。
import { Router } from 'express';
import { requireAuth } from '../auth/session.js';
import { asyncHandler } from '../http/middleware.js';
import { Fields } from '../http/validate.js';
import { appError } from '../http/errors.js';
import {
  buildOauthState, bindWechatOpenid, createRechargeOrder, getRechargeOptions,
  getRechargeOrder, listRechargeOrders, safeReturnTo, serializeOrder, verifyOauthState,
} from '../payments/recharge.js';

export function rechargeRoutes({ db, logger, payments }) {
  const router = Router();
  const deps = { payClient: payments.payClient, scenes: payments.scenes, appid: payments.appid,
    config: payments.config, logger };
  const amounts = payments.config.payments.amountsFen;

  router.get('/wallet/recharge/options', requireAuth, asyncHandler(async (req, res) => {
    res.json(await getRechargeOptions(db, { userId: req.user.id, scenes: payments.scenes,
      mpAppid: payments.appid }, { amountsFen: amounts, maxAmountFen: Math.max(...amounts, 0) }));
  }));

  router.post('/wallet/recharge', requireAuth, asyncHandler(async (req, res) => {
    const f = new Fields(req.body);
    const amountFen = f.int('amountFen', { required: true });
    const scene = f.string('scene', { required: true, min: 4, max: 8 });
    const idempotencyKey = f.string('idempotencyKey', { required: true, min: 8, max: 64 });
    f.done();
    const result = await createRechargeOrder(db, { userId: req.user.id, amountFen, scene,
      idempotencyKey, clientIp: req.ip }, deps);
    res.status(result.replayed ? 200 : 201).json(serializeOrder(result.order, payments));
  }));

  router.get('/wallet/recharge/:orderId', requireAuth, asyncHandler(async (req, res) => {
    res.json(await getRechargeOrder(db, { userId: req.user.id, orderId: req.params.orderId }, payments));
  }));

  router.get('/wallet/recharge', requireAuth, asyncHandler(async (req, res) => {
    const f = new Fields(req.query);
    const limit = f.int('limit', { min: 1, max: 50 });
    const cursor = f.string('cursor', { max: 200 });
    f.done();
    res.json(await listRechargeOrders(db, { userId: req.user.id, cursor, limit: limit ?? 20 }));
  }));

  // ── 公众号静默授权（snsapi_base）：仅在微信内置浏览器走（前端判断）──
  router.get('/wechat/oauth/start', requireAuth, (req, res, next) => {
    try {
      if (!payments.oauth) throw appError('PAYMENT_UNAVAILABLE', '在线充值暂不可用，可使用兑换码');
      const returnTo = safeReturnTo(typeof req.query.returnTo === 'string' ? req.query.returnTo : undefined);
      const state = buildOauthState({ userId: req.user.id, returnTo }, payments);
      const base = payments.config.payments.webBaseUrl.replace(/\/+$/, '');
      const redirectUri = `${base}/api/v1/wechat/oauth/callback`;
      res.redirect(payments.oauth.authorizeUrl({ redirectUri, state }));
    } catch (err) { next(err); }
  });

  router.get('/wechat/oauth/callback', requireAuth, asyncHandler(async (req, res) => {
    const returnTo = verifyOauthState(req.query.state, { userId: req.user.id }, payments);
    if (!returnTo) throw appError('VALIDATION_FAILED', '授权状态无效或已过期，请重新发起');
    if (typeof req.query.code !== 'string' || !req.query.code) {
      throw appError('VALIDATION_FAILED', '微信未返回授权码');
    }
    await bindWechatOpenid(db, { oauth: payments.oauth, code: req.query.code, userId: req.user.id, logger });
    const base = payments.config.payments.webBaseUrl.replace(/\/+$/, '');
    res.redirect(base + returnTo);
  }));

  return router;
}
