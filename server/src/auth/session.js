// 会话与 CSRF（docs/API.md §0、ARCHITECTURE §7）。
// Cookie miv_sid：HttpOnly、SameSite=Lax、生产 Secure；sessions 表只存 token 哈希。
// CSRF 策略：写请求一律校验 Origin 白名单；已登录会话再校验 X-CSRF-Token。
// /auth/sms 与 /auth/login 在登录前没有 token，由 Origin + SameSite=Lax 防护（无会话时不查 token）。
import { createHash } from 'node:crypto';
import { appError } from '../http/errors.js';
import { maskPhone } from './sms.js';

export const SESSION_COOKIE = 'miv_sid';

/** Cookie 里的会话令牌不入库，只存哈希。 */
export const sessionTokenHash = (token) => createHash('sha256').update(token).digest('hex');

export function serializeOnboarding(row) {
  return {
    tourCompletedAt: row.tour_completed_at ? row.tour_completed_at.toISOString() : null,
    tipsSeen: row.tips_seen ?? [],
  };
}

export function serializeUser(row, { urlFor }) {
  const user = {
    id: row.id,
    phoneMasked: maskPhone(row.phone),
    nickname: row.nickname,
    onboarding: serializeOnboarding(row),
  };
  const avatarUrl = row.avatar_key ? urlFor(row.avatar_key) : undefined;
  if (avatarUrl) user.avatarUrl = avatarUrl;
  return user;
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    try {
      out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      // 坏编码的 Cookie 直接忽略该字段
    }
  }
  return out;
}

/** 业务路由的登录守卫：挂在路由器上（auth 路由按需挂单个端点）。 */
export const requireAuth = (req, res, next) => {
  if (!req.user) return next(appError('UNAUTHENTICATED'));
  return next();
};

export function createSessionTools({ config, db }) {
  const cookieOptions = { httpOnly: true, sameSite: 'lax', secure: config.cookieSecure, path: '/' };

  const setSessionCookie = (res, token) =>
    res.cookie(SESSION_COOKIE, token, { ...cookieOptions, maxAge: config.sessionTtlDays * 86_400_000 });
  const clearSessionCookie = (res) => res.clearCookie(SESSION_COOKIE, cookieOptions);

  /** 从 Cookie 还原会话与用户；过期/停用账号的会话顺手删除。 */
  const sessionMiddleware = async (req, res, next) => {
    try {
      req.user = null;
      req.session = null;
      const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
      if (token) {
        const tokenHash = sessionTokenHash(token);
        const { rows } = await db.query(
          `SELECT s.csrf_token, s.expires_at, s.last_seen_at,
                  u.id, u.phone, u.nickname, u.avatar_key, u.status, u.tour_completed_at, u.tips_seen
           FROM sessions s JOIN users u ON u.id = s.user_id
           WHERE s.token_hash = $1`,
          [tokenHash],
        );
        const row = rows[0];
        if (row) {
          if (row.expires_at.getTime() <= Date.now() || row.status !== 'active') {
            await db.query(`DELETE FROM sessions WHERE token_hash = $1`, [tokenHash]);
          } else {
            req.session = { tokenHash, csrfToken: row.csrf_token, expiresAt: row.expires_at };
            req.user = row;
            // last_seen_at 每小时最多回写一次，避免每个请求都写库
            if (Date.now() - row.last_seen_at.getTime() > 3_600_000) {
              await db.query(`UPDATE sessions SET last_seen_at = now() WHERE token_hash = $1`, [tokenHash]);
            }
          }
        }
      }
      next();
    } catch (err) {
      next(err);
    }
  };

  const csrfGuard = (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    const origin = req.get('origin');
    if (origin) {
      let trusted = false;
      try {
        trusted = config.allowedOrigins.includes(new URL(origin).origin);
      } catch {
        trusted = false;
      }
      if (!trusted) return next(appError('CSRF_INVALID'));
    }
    if (req.session && req.get('x-csrf-token') !== req.session.csrfToken) return next(appError('CSRF_INVALID'));
    return next();
  };

  return { sessionMiddleware, csrfGuard, setSessionCookie, clearSessionCookie };
}
