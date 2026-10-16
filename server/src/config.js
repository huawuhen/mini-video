// 环境变量解析：全项目唯一读取 process.env 的地方，其他模块只接收 config 对象。
// 新增变量时同步更新 server/.env.example。密钥只从环境变量读取，禁止打印 config 全量内容。

const int = (value, fallback) => {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n)) throw new Error(`配置项不是整数：${value}`);
  return n;
};
const bool = (value, fallback) => (value === undefined || value === '' ? fallback : value === 'true' || value === '1');
const list = (value) => (value ? value.split(',').map((s) => s.trim()).filter(Boolean) : []);

export function loadConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV || 'development';
  const production = nodeEnv === 'production';
  const config = {
    nodeEnv,
    production,
    host: env.HOST || '127.0.0.1',
    port: int(env.PORT, 3000),
    logLevel: env.LOG_LEVEL || (production ? 'info' : 'debug'),
    trustProxy: int(env.TRUST_PROXY_HOPS, production ? 1 : 0),
    databaseUrl: env.DATABASE_URL || 'postgres://miv:miv_test_only@127.0.0.1:56432/miv',
    dbPoolMax: int(env.DB_POOL_MAX, 10),
    // 写请求的 Origin 白名单（AGENTS.md §5 同源校验）；开发环境默认放行 Vite 本地地址
    allowedOrigins: list(env.ALLOWED_ORIGINS).length ? list(env.ALLOWED_ORIGINS) : production ? [] : ['http://localhost:5173', 'http://127.0.0.1:5173'],
    cookieSecure: bool(env.COOKIE_SECURE, production),
    sessionTtlDays: int(env.SESSION_TTL_DAYS, 30),
    worker: {
      id: env.WORKER_ID || `worker-${process.pid}`,
      concurrency: int(env.WORKER_CONCURRENCY, 2),
      pollIntervalMs: int(env.WORKER_POLL_INTERVAL_MS, 1000),
      leaseSeconds: int(env.WORKER_LEASE_SECONDS, 120),
    },
    // 对象存储（七牛 Kodo），由 Engine 角色在 engine/storage 中使用
    storage: {
      driver: env.STORAGE_DRIVER || (production ? 'qiniu' : 'memory'),
      qiniu: {
        accessKey: env.QINIU_ACCESS_KEY || '',
        secretKey: env.QINIU_SECRET_KEY || '',
        bucket: env.QINIU_BUCKET || '',
        domain: env.QINIU_DOMAIN || '',
        region: env.QINIU_REGION || '',
      },
      signedUrlTtlSeconds: int(env.SIGNED_URL_TTL_SECONDS, 3600),
    },
  };
  if (production) {
    if (!env.DATABASE_URL) throw new Error('生产环境必须设置 DATABASE_URL');
    if (!config.allowedOrigins.length) throw new Error('生产环境必须设置 ALLOWED_ORIGINS');
  }
  return Object.freeze(config);
}
