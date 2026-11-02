// 微信支付回调路由（M3-PAY-02，API §3.1）：**挂载在会话与 CSRF 中间件之前**、
// express.json 之前（本路由自带 express.raw 保留原始请求体用于验签——JSON 重新序列化
// 会改变字节序列导致验签失败）。成功（含重复通知）204；失败 4XX/5XX + {"code":"FAIL"}。
// 审计日志不含签名、密钥与解密后的 openid（PRD §6.4）。
import { Router, raw as rawBody } from 'express';
import { asyncHandler } from '../http/middleware.js';
import { handleWechatNotify, NotifyFailure } from '../payments/recharge.js';

export function wechatNotifyRoutes({ db, logger, payments }) {
  const router = Router();
  router.post('/payments/wechat/notify',
    rawBody({ type: () => true, limit: '64kb' }),
    asyncHandler(async (req, res) => {
      try {
        await handleWechatNotify(db, { headers: req.headers, rawBody: req.body.toString('utf8') },
          { payClient: payments.payClient, appid: payments.appid, config: payments.config, logger });
        res.status(204).end();
      } catch (err) {
        if (err instanceof NotifyFailure) {
          logger?.warn?.('wechat_notify_rejected', { status: err.httpStatus, message: err.message });
          res.status(err.httpStatus).json({ code: 'FAIL', message: err.message });
          return;
        }
        throw err;
      }
    }));
  return router;
}
