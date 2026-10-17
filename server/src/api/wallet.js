// 钱包路由（docs/API.md §3）：GET /wallet、GET /wallet/ledger、POST /wallet/redeem。只做校验与编排。
import { Router } from 'express';
import { requireAuth } from '../auth/session.js';
import { hitRateLimit } from '../auth/ratelimit.js';
import { asyncHandler } from '../http/middleware.js';
import { Fields } from '../http/validate.js';
import { getWallet, listLedger, redeem } from '../wallet/service.js';

// 兑换码尝试上限（§6 审查 7 建议）：短码可被暴力猜，按用户每小时最多 10 次。
// 在事务外预计数（BE-01 登录限流同款）：失败导致兑换事务回滚也不会丢计数，并发猜码同样被计入。
const REDEEM_ATTEMPTS_PER_HOUR = 10;

export function walletRoutes({ db }) {
  const router = Router();

  router.get('/wallet', requireAuth, asyncHandler(async (req, res) => {
    res.json(await getWallet(db, req.user.id));
  }));

  router.get('/wallet/ledger', requireAuth, asyncHandler(async (req, res) => {
    const f = new Fields(req.query);
    const limit = f.int('limit', { min: 1, max: 50 });
    const cursor = f.string('cursor', { max: 200 });
    f.done();
    res.json(await listLedger(db, { userId: req.user.id, cursor, limit: limit ?? 20 }));
  }));

  router.post('/wallet/redeem', requireAuth, asyncHandler(async (req, res) => {
    const f = new Fields(req.body);
    const code = f.string('code', { required: true, min: 4, max: 64 });
    const idempotencyKey = f.string('idempotencyKey', { required: true, min: 8, max: 64 });
    f.done();
    await hitRateLimit(db, {
      key: `redeem:attempt:${req.user.id}`,
      windowSeconds: 3_600,
      max: REDEEM_ATTEMPTS_PER_HOUR,
      message: '兑换码尝试次数太多，请一小时后再试',
    });
    const result = await db.tx((t) => redeem(t, { userId: req.user.id, code, idempotencyKey }));
    res.json({ amountFen: result.amountFen, wallet: await getWallet(db, req.user.id) });
  }));

  return router;
}
