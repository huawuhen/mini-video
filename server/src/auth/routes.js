// 认证与用户路由（docs/API.md §1）。路由只做参数校验与编排，业务在 sms.js / session.js。
import { Router } from 'express';
import { appError } from '../http/errors.js';
import { asyncHandler } from '../http/middleware.js';
import { Fields } from '../http/validate.js';
import { hitRateLimit } from './ratelimit.js';
import { loginWithSmsCode, maskPhone, sendSmsCode } from './sms.js';
import { serializeOnboarding, serializeUser } from './session.js';

const PHONE_RE = /^1[3-9]\d{9}$/;
const TIP_KEYS = ['story_review', 'cast_review', 'delivery'];

function validPhone(f) {
  const phone = f.string('phone', { required: true, min: 11, max: 11 });
  if (phone !== undefined && !PHONE_RE.test(phone)) f.errors.phone = '格式不正确';
  return phone;
}

export function buildAuthRoutes({ config, db, logger, provider, requireAuth, setSessionCookie, clearSessionCookie, urlFor }) {
  const routes = Router();

  routes.post('/auth/sms', asyncHandler(async (req, res) => {
    const f = new Fields(req.body);
    const phone = validPhone(f);
    f.done();
    const result = await sendSmsCode({ db, config, logger, provider, phone });
    res.json(result);
  }));

  routes.post('/auth/login', asyncHandler(async (req, res) => {
    const f = new Fields(req.body);
    const phone = validPhone(f);
    const code = f.string('code', { required: true, min: 4, max: 8, trim: false });
    if (f.source.agreeTerms !== true) f.errors.agreeTerms = '需要先同意用户协议与隐私政策';
    f.done();
    await hitRateLimit(db, {
      key: `login:phone:${phone}`,
      windowSeconds: 3_600,
      max: config.sms.loginMaxPerHour,
      message: '尝试次数太多，请一小时后再试',
    });
    const { user, isNewUser, token, csrfToken } = await loginWithSmsCode({ db, config, phone, code });
    setSessionCookie(res, token);
    logger.info('user_login', { userId: user.id, isNewUser, phone: maskPhone(phone) });
    res.json({ user: serializeUser(user, { urlFor }), csrfToken, isNewUser });
  }));

  // 审查意见 4：logout 不要求登录态（API.md §1 未要求）——有会话则删除并记日志，无会话（含已过期）也清 Cookie，统一返回 ok
  routes.post('/auth/logout', asyncHandler(async (req, res) => {
    if (req.session) {
      await db.query(`DELETE FROM sessions WHERE token_hash = $1`, [req.session.tokenHash]);
      logger.info('user_logout', { userId: req.user.id });
    }
    clearSessionCookie(res);
    res.json({ ok: true });
  }));

  routes.get('/auth/me', requireAuth, (req, res) => {
    res.json({ user: serializeUser(req.user, { urlFor }), csrfToken: req.session.csrfToken });
  });

  routes.patch('/me/onboarding', requireAuth, asyncHandler(async (req, res) => {
    const f = new Fields(req.body);
    const tourCompleted = f.oneOf('tourCompleted', [true]);
    const tipSeen = f.oneOf('tipSeen', TIP_KEYS);
    f.done();
    if (tourCompleted === undefined && tipSeen === undefined) {
      throw appError('VALIDATION_FAILED', undefined, { fields: { body: 'tourCompleted 与 tipSeen 至少提供一项' } });
    }
    // tourCompletedAt 只记首次完成时间（完成和跳过都传 true，重播引导不改服务端状态）；tipSeen 追加去重
    const { rows } = await db.query(
      `UPDATE users SET
         tour_completed_at = CASE WHEN $2 THEN COALESCE(tour_completed_at, now()) ELSE tour_completed_at END,
         tips_seen = CASE WHEN $3::text IS NOT NULL AND NOT tips_seen @> ARRAY[$3::text]
                          THEN tips_seen || ARRAY[$3::text] ELSE tips_seen END,
         updated_at = now()
       WHERE id = $1
       RETURNING tour_completed_at, tips_seen`,
      [req.user.id, tourCompleted === true, tipSeen ?? null],
    );
    res.json({ onboarding: serializeOnboarding(rows[0]) });
  }));

  return routes;
}
