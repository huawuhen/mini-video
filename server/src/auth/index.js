// 认证模块组装：由 app.js 按「会话 → CSRF/Origin → 认证路由」顺序挂载（app.js 中注释的插入点）。
import { buildAuthRoutes } from './routes.js';
import { consoleSmsProvider } from './sms.js';
import { createSessionTools, requireAuth } from './session.js';

/**
 * @param {object} deps
 * @param {ReturnType<typeof import('../config.js').loadConfig>} deps.config
 * @param {import('../db/pool.js').createDb} deps.db
 * @param {ReturnType<typeof import('../logger.js').createLogger>} deps.logger
 * @param {{ id: string, send(input: { phone: string, code: string }): Promise<void> }} [deps.smsProvider]
 *   短信发送实现，测试注入模拟；缺省用 console provider（仅开发/测试，生产启动即报错）。
 */
export function createAuth({ config, db, logger, smsProvider, urlFor = () => undefined }) {
  const provider = smsProvider ?? consoleSmsProvider(config);
  if (config.production && provider.id === 'console') {
    throw new Error('生产环境必须注入真实短信 provider');
  }
  const { sessionMiddleware, csrfGuard, setSessionCookie, clearSessionCookie } = createSessionTools({ config, db });
  return {
    sessionMiddleware,
    csrfGuard,
    requireAuth,
    routes: buildAuthRoutes({ config, db, logger, provider, requireAuth, setSessionCookie, clearSessionCookie, urlFor }),
  };
}
