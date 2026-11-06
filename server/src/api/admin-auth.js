// 管理端·登录/登出路由（docs/API.md §8；M3-ADM-03 走查发现：登录原先只在渠道路由里、
// 仅 GEN_UPSTREAMS=real 才挂载，mock 开发模式下管理端无法登录）。无条件挂载；
// 其余管理路由各自用 createAdminAuth 校验会话（同一 admin_sessions 表）。
import { Router } from 'express';
import { asyncHandler } from '../http/middleware.js';
import { Fields } from '../http/validate.js';
import { appError } from '../http/errors.js';
import { createAdminAuth } from '../channels/admin-auth.js';

export function adminAuthRoutes({ db, config }) {
  const router = Router();
  const auth = createAdminAuth({ config, db });

  router.post('/admin/auth/login', asyncHandler(async (req, res) => {
    const fields = new Fields(req.body);
    const body = {
      username: fields.string('username', { required: true }),
      password: fields.string('password', { required: true }),
    };
    fields.done();
    const session = await auth.login({ ...body, ip: req.ip });
    if (!session) throw appError('ADMIN_AUTH_REQUIRED', '用户名或密码不正确');
    auth.setCookie(res, session.token);
    res.json({ admin: session.admin, csrfToken: session.csrfToken });
  }));

  router.post('/admin/auth/logout', (req, res) => {
    void auth.logout(auth.readCookie(req));
    auth.clearCookie(res);
    res.json({ ok: true });
  });

  return router;
}
