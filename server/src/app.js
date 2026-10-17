// API 进程组装入口（AGENTS.md §2：同一时间只有一个写入者，默认 BE-Core）。
// createApp(deps) 只组装、不监听端口，测试直接注入 db / logger / 模拟依赖。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createAuth } from './auth/index.js';
import { catalogRoutes } from './api/catalog.js';
import { characterRoutes } from './api/characters.js';
import { quoteRoutes } from './api/quotes.js';
import { uploadRoutes } from './api/uploads.js';
import { walletRoutes } from './api/wallet.js';
import { extractText } from './engine/extract/index.js';
import { createStorageFromConfig } from './engine/storage/index.js';
import { loadConfig } from './config.js';
import { createDb } from './db/pool.js';
import { errorHandler, notFound, requestId } from './http/middleware.js';
import { createLogger } from './logger.js';
import { createMemoryStorage } from './engine/storage/memory.js';

/**
 * @param {object} deps
 * @param {ReturnType<typeof loadConfig>} deps.config
 * @param {ReturnType<typeof createDb>} deps.db
 * @param {ReturnType<typeof createLogger>} deps.logger
 * @param {(key: string) => string | undefined} [deps.urlFor]  媒体签名链接；engine/storage 就绪前返回 undefined
 * @param {{ id: string, send(input: { phone: string, code: string }): Promise<void> }} [deps.smsProvider]  短信发送，测试注入模拟；缺省 console（仅开发/测试）
 * @param {{ put(key, buffer, opts): Promise<void>, remove(keys): Promise<void> }} [deps.storage]  对象存储；缺省内存实现（生产必须注入真实实现）
 * @param {(buffer: Buffer, mime: string) => Promise<string>} [deps.extractText]  docx 文本提取（M1-ENG-03）；未注入时 docx 上传返回 UPLOAD_TYPE_INVALID
 */
export function createApp({ config, db, logger, urlFor = () => undefined, smsProvider, storage, extractText }) {
  if (config.production && !storage) throw new Error('生产环境必须注入真实对象存储（engine/storage）');
  const objectStorage = storage ?? createMemoryStorage();
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

  // 认证（M1-BE-01）：顺序固定，会话 → CSRF/Origin → 认证路由；后续业务路由接在其后
  const auth = createAuth({ config, db, logger, smsProvider, urlFor });
  api.use(auth.sessionMiddleware);
  api.use(auth.csrfGuard);
  api.use(auth.routes);

  // 钱包与报价（M1-BE-02），挂载在认证中间件之后，全部要求登录
  api.use(walletRoutes({ db }));
  api.use(quoteRoutes({ db }));

  // 上传与数字资产库（M1-BE-04）
  api.use(uploadRoutes({ config, db, logger, storage: objectStorage, urlFor, extractText }));
  api.use(characterRoutes({ db, urlFor }));

  // ── 以下由 BE-Core 按 docs/TASKS.md 接入 ──
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
  const storage = createStorageFromConfig(config); // M1-ENG-03：按 config.storage.driver 注入（生产 qiniu，开发 memory）
  const server = createApp({ config, db, logger, storage, extractText }).listen(config.port, config.host, () => {
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
