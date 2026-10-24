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

  /** 登录：校验口令、建会话、种 Cookie；连续失败不锁定（低频管理入口，靠强密码与审计）。 */
  async function login({ username, password, ip }) {
    const { rows } = await db.query(
      `SELECT id, username, display_name, password_hash, status FROM admin_users WHERE username = $1`,
      [String(username ?? '').trim()],
    );
    const admin = rows[0];
    const { verifyAdminPassword } = await import('./crypto.js');
    if (!admin || !verifyAdminPassword(admin.password_hash, String(password ?? '')) || admin.status !== 'active') {
      await audit({ actor: 'admin', action: 'auth.login_failed', targetType: 'admin_user', targetId: String(username ?? ''),
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
    setCookie: (res, token) => res.cookie(ADMIN_COOKIE, token, { ...cookieOptions, maxAge: config.sessionTtlDays * 86_400_000 }),
    clearCookie: (res) => res.clearCookie(ADMIN_COOKIE, cookieOptions),
    readCookie: (req) => parseCookies(req.headers.cookie)[ADMIN_COOKIE],
  };
}
