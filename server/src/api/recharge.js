// 充值与公众号授权路由（M3-PAY-02，API §3.1）。全部要求登录；
// /wallet/recharge/options 必须先于 /wallet/recharge/:orderId 注册（API 实现提示）。
import { Router } from 'express';
import { requireAuth } from '../auth/session.js';
import { asyncHandler } from '../http/middleware.js';
import { Fields } from '../http/validate.js';
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

  // ── 公众号静默授权（snsapi_base）：浏览器整页跳转，任何失败一律 302（不给 JSON）──
  const webBase = () => payments.config.payments.webBaseUrl.replace(/\/+$/, '');
  const withFailed = (path) => `${path}${path.includes('?') ? '&' : '?'}wechatAuth=failed`;

  router.get('/wechat/oauth/start', (req, res) => {
    const returnTo = safeReturnTo(typeof req.query.returnTo === 'string' ? req.query.returnTo : undefined);
    if (!req.user) return res.redirect(`/login?redirect=${encodeURIComponent(returnTo)}`);
    if (!payments.oauth) {
      logger?.warn?.('oauth_start_unavailable', {});
      return res.redirect(webBase() + withFailed(returnTo));
    }
    const state = buildOauthState({ userId: req.user.id, returnTo }, payments);
    const redirectUri = `${webBase()}/api/v1/wechat/oauth/callback`;
    res.redirect(payments.oauth.authorizeUrl({ redirectUri, state }));
  });

  router.get('/wechat/oauth/callback', asyncHandler(async (req, res) => {
    // state 用登录用户 id 签名：未登录时无法验证，一律视为无效 → 目标回 /wallet（API §3.1 复审口径）
    const stateReturnTo = req.user
      ? verifyOauthState(req.query.state, { userId: req.user.id }, payments) : null;
    const returnTo = stateReturnTo ?? '/wallet';
    if (!req.user) {
      logger?.warn?.('oauth_callback_unauthenticated', {});
      return res.redirect(`/login?redirect=${encodeURIComponent(returnTo)}`);
    }
    if (!payments.oauth || !stateReturnTo || typeof req.query.code !== 'string' || !req.query.code) {
      logger?.warn?.('oauth_callback_rejected', { stateValid: Boolean(stateReturnTo),
        hasCode: Boolean(req.query.code) });
      return res.redirect(webBase() + withFailed(returnTo));
    }
    try {
      await bindWechatOpenid(db, { oauth: payments.oauth, code: req.query.code, userId: req.user.id });
    } catch (err) {
      // 换 code 失败等：原因只进日志，用户回到页面看到「授权失败，请重试」提示
      logger?.warn?.('oauth_callback_bind_failed', { code: err?.code,
        message: String(err?.message ?? err).slice(0, 200) });
      return res.redirect(webBase() + withFailed(returnTo));
    }
    res.redirect(webBase() + returnTo);
  }));

  return router;
}
