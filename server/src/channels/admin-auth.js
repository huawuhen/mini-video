// 管理员账号与会话（API.md §8）：独立于 C 端（admin_users / admin_sessions，Cookie miv_admin）。
// 用户名 + 强密码（scrypt 哈希，crypto.js）；写操作同样校验同源 + CSRF；首个管理员由
// npm run admin:create 创建，不开放注册。
import { createHash, randomBytes } from 'node:crypto';
import { newAdminSessionToken } from './crypto.js';
import { appError } from '../http/errors.js';

export const ADMIN_COOKIE = 'miv_admin';

const parseCookies = (header) => {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* 忽略坏编码 */ }
  }
  return out;
};

export const adminSessionTokenHash = (token) => createHash('sha256').update(token).digest('hex');

export function createAdminAuth({ config, db }) {
  const cookieOptions = { httpOnly: true, sameSite: 'lax', secure: config.cookieSecure, path: '/' };

  /** 管理员会话中间件：识别 Cookie、校验过期与账号状态。API 进程挂 /api/v1/admin 之前。 */
  const sessionMiddleware = async (req, res, next) => {
    try {
      req.admin = null;
      const token = parseCookies(req.headers.cookie)[ADMIN_COOKIE];
      if (token) {
        const tokenHash = adminSessionTokenHash(token);
        const { rows } = await db.query(
          `SELECT s.csrf_token, s.expires_at, a.id, a.username, a.display_name, a.status
             FROM admin_sessions s JOIN admin_users a ON a.id = s.admin_id
            WHERE s.token_hash = $1`,
          [tokenHash],
        );
        const row = rows[0];
        if (row) {
          if (row.expires_at.getTime() <= Date.now() || row.status !== 'active') {
            await db.query(`DELETE FROM admin_sessions WHERE token_hash = $1`, [tokenHash]);
          } else {
            req.admin = { id: row.id, username: row.username, displayName: row.display_name };
            req.adminCsrfToken = row.csrf_token;
          }
        }
      }
      next();
    } catch (err) { next(err); }
  };

  /** 登录守卫。 */
  const requireAdmin = (req, res, next) => {
    if (!req.admin) return next(appError('ADMIN_AUTH_REQUIRED'));
    return next();
  };

  /** 写操作守卫：同源（Origin 白名单）+ CSRF 头（登录后必须带）。挂在路由内部按需使用。 */
  const writeGuard = (req, res, next) => {
    const origin = req.get('origin');
    if (origin && !config.allowedOrigins.includes(origin)) {
      return next(appError('CSRF_INVALID'));
    }
    if (req.admin && req.get('x-csrf-token') !== req.adminCsrfToken) {
      return next(appError('CSRF_INVALID'));
    }
    return next();
  };

  /**
   * 登录限流（M2-BE-03 审查必改，用户 2026-10-24 裁决）：按 IP——失败计数窗口内满
   * loginMaxFailures 次即封禁 loginBanSeconds；封禁期间正确密码也拒绝。
   * 复用 PG rate_counters 固定窗口口径（不引入 Redis）：
   *   失败计数 admin:login:fail:<ip>（窗口起点对齐整窗，窗口外失败不累计）；
   *   封禁行 admin:login:ban:<ip>（window_start=封禁时刻，按 window_start+banSeconds 判定在押；
   *   行由 auth.sweep 的 48h 兜底清理，不影响封禁语义）。
   */
  async function assertLoginAllowed(ip) {
    if (!ip) return;
    const { rows } = await db.query(
      `SELECT 1 FROM rate_counters
        WHERE key = $1 AND window_start + make_interval(secs => $2) > now()`,
      [`admin:login:ban:${ip}`, config.admin.loginBanSeconds],
    );
    if (rows.length) {
      throw appError('RATE_LIMITED', '尝试次数过多，请稍后再试', { retryAfterSeconds: config.admin.loginBanSeconds });
    }
  }

  async function recordLoginFailure(ip) {
    if (!ip) return false;
    const windowSeconds = config.admin.loginFailWindowSeconds;
    const now = Date.now();
    const windowStart = new Date(Math.floor(now / (windowSeconds * 1000)) * windowSeconds * 1000);
    const { rows } = await db.query(
      `INSERT INTO rate_counters (key, window_start, count) VALUES ($1, $2, 1)
       ON CONFLICT (key, window_start) DO UPDATE SET count = rate_counters.count + 1
       RETURNING count`,
      [`admin:login:fail:${ip}`, windowStart],
    );
    if (rows[0].count >= config.admin.loginMaxFailures) {
      // 写封禁（从当前时刻起算；已存在未过期封禁行则不重复/不延长）
      await db.query(
        `INSERT INTO rate_counters (key, window_start, count)
         SELECT $1, now(), 1
          WHERE NOT EXISTS (
            SELECT 1 FROM rate_counters
             WHERE key = $1 AND window_start + make_interval(secs => $2) > now())`,
        [`admin:login:ban:${ip}`, config.admin.loginBanSeconds],
      );
      return true;
    }
    return false;
  }

  /** 登录：先过 IP 限流（封禁期间正确密码也拒），失败计数，满阈值封禁。 */
  async function login({ username, password, ip }) {
    await assertLoginAllowed(ip);
    const { rows } = await db.query(
      `SELECT id, username, display_name, password_hash, status FROM admin_users WHERE username = $1`,
      [String(username ?? '').trim()],
    );
    const admin = rows[0];
    const { verifyAdminPassword } = await import('./crypto.js');
    if (!admin || !verifyAdminPassword(admin.password_hash, String(password ?? '')) || admin.status !== 'active') {
      const banned = await recordLoginFailure(ip);
      await audit({ actor: 'admin', action: banned ? 'auth.login_banned' : 'auth.login_failed',
        targetType: 'admin_user', targetId: String(username ?? ''),
        detail: { ip: ip ?? null } });
      return null;
    }
    const { token, tokenHash } = newAdminSessionToken();
    const csrfToken = randomBytes(16).toString('hex');
    await db.query(
      `INSERT INTO admin_sessions (token_hash, admin_id, csrf_token, expires_at)
       VALUES ($1, $2, $3, now() + make_interval(secs => $4))`,
      [tokenHash, admin.id, csrfToken, config.sessionTtlDays * 86_400],
    );
    await db.query(`UPDATE admin_users SET last_login_at = now(), updated_at = now() WHERE id = $1`, [admin.id]);
    await audit({ adminId: admin.id, actor: 'admin', action: 'auth.login', targetType: 'admin_user', targetId: admin.id, detail: {} });
    return { token, csrfToken, admin: { id: admin.id, username: admin.username, displayName: admin.display_name } };
  }

  async function logout(token) {
    if (!token) return;
    const tokenHash = adminSessionTokenHash(token);
    const { rowCount } = await db.query(`DELETE FROM admin_sessions WHERE token_hash = $1`, [tokenHash]);
    return rowCount > 0;
  }

  /** 审计（后台 / CLI / 种子 / 试生成全部留痕；detail 里禁止放明文凭证）。 */
  async function audit({ adminId = null, actor, action, targetType, targetId, detail = {} }) {
    await db.query(
      `INSERT INTO admin_audit_logs (admin_id, actor, action, target_type, target_id, detail)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [adminId, actor, action, targetType, String(targetId ?? ''), JSON.stringify(detail)],
    );
  }

  return {
    sessionMiddleware, requireAdmin, writeGuard, login, logout, audit,
    assertLoginAllowed, recordLoginFailure, // 测试与诊断用
    setCookie: (res, token) => res.cookie(ADMIN_COOKIE, token, { ...cookieOptions, maxAge: config.sessionTtlDays * 86_400_000 }),
    clearCookie: (res) => res.clearCookie(ADMIN_COOKIE, cookieOptions),
    readCookie: (req) => parseCookies(req.headers.cookie)[ADMIN_COOKIE],
  };
}
