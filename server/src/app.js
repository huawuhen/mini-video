// API 进程组装入口（AGENTS.md §2：同一时间只有一个写入者，默认 BE-Core）。
// createApp(deps) 只组装、不监听端口，测试直接注入 db / logger / 模拟依赖。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { catalogRoutes } from './api/catalog.js';
import { loadConfig } from './config.js';
import { createDb } from './db/pool.js';
import { errorHandler, notFound, requestId } from './http/middleware.js';
import { createLogger } from './logger.js';

/**
 * @param {object} deps
 * @param {ReturnType<typeof loadConfig>} deps.config
 * @param {ReturnType<typeof createDb>} deps.db
 * @param {ReturnType<typeof createLogger>} deps.logger
 * @param {(key: string) => string | undefined} [deps.urlFor]  媒体签名链接；engine/storage 就绪前返回 undefined
 */
export function createApp({ config, db, logger, urlFor = () => undefined }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);

  const api = express.Router();
  api.use(requestId());
  api.use(express.json({ limit: '200kb' }));
  api.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  api.get('/health', async (req, res, next) => {
    try {
      await db.query('SELECT 1');
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });
  api.use(catalogRoutes({ db, urlFor }));

  // ── 以下由 BE-Core 按 docs/TASKS.md 接入（顺序固定：会话 → CSRF/Origin → 业务路由）──
  // M1-BE-01  api.use(sessionMiddleware(...)); api.use(csrfGuard(...)); api.use(authRoutes(...));
  // M1-BE-02  api.use(walletRoutes(...)); api.use(quoteRoutes(...));
  // M1-BE-04  api.use(uploadRoutes(...)); api.use(characterRoutes(...));
  // M1-BE-06  api.use(projectRoutes(...));

  api.use(notFound());
  api.use(errorHandler(logger));
  app.use('/api/v1', api);
  return app;
}

// 直接运行：npm run start:api -w server
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = loadConfig();
  const logger = createLogger({ level: config.logLevel, base: { proc: 'api' } });
  const db = createDb({ url: config.databaseUrl, max: config.dbPoolMax, logger });
  const server = createApp({ config, db, logger }).listen(config.port, config.host, () => {
    logger.info('api_listening', { host: config.host, port: config.port });
  });
  const shutdown = (signal) => {
    logger.info('api_shutdown', { signal });
    server.close(() => db.close().finally(() => process.exit(0)));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
