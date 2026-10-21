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
    // 短信验证码：console provider 仅限开发/测试（把验证码打印到控制台，生产启动即报错）
    sms: {
      provider: env.SMS_PROVIDER || 'console',
      codeTtlSeconds: int(env.SMS_CODE_TTL_SECONDS, 300),
      sendCooldownSeconds: int(env.SMS_SEND_COOLDOWN_SECONDS, 60),
      maxPerPhonePerDay: int(env.SMS_MAX_PER_PHONE_PER_DAY, 10),
      maxVerifyAttempts: int(env.SMS_MAX_VERIFY_ATTEMPTS, 5),
      loginMaxPerHour: int(env.SMS_LOGIN_MAX_PER_HOUR, 20),
    },
    // 上传（M1-BE-04）：图片单张 10MB、故事文件 2MB（API.md §4 写死）；未引用图片按用户限量防刷存储
    uploads: {
      maxUnreferencedPerUser: int(env.UPLOADS_MAX_UNREFERENCED, 50),
    },
    worker: {
      id: env.WORKER_ID || `worker-${process.pid}`,
      concurrency: int(env.WORKER_CONCURRENCY, 2),
      pollIntervalMs: int(env.WORKER_POLL_INTERVAL_MS, 1000),
      leaseSeconds: int(env.WORKER_LEASE_SECONDS, 120),
      maxAttempts: int(env.WORKER_MAX_ATTEMPTS, 5),
    },
    // 作品（M1-BE-05）：免费故事理解次数按北京日切日；时长上限与想法判定阈值见
    // docs/skills/wan-3.0.md；交付后保存期 PRD 为 3 个月
    projects: {
      freeDailyQuota: int(env.PROJECTS_FREE_DAILY_QUOTA, 20),
      maxSeconds: int(env.PROJECTS_MAX_SECONDS, 90),
      ideaCharThreshold: int(env.PROJECTS_IDEA_CHAR_THRESHOLD, 60),
      retentionDays: int(env.PROJECTS_RETENTION_DAYS, 90),
      genPollIntervalSeconds: int(env.PROJECTS_GEN_POLL_INTERVAL_SECONDS, 5),
      genPollTimeoutSeconds: int(env.PROJECTS_GEN_POLL_TIMEOUT_SECONDS, 7200), // 轮询上限 120 分钟（用户 2026-10-20 指定）
      refUrlTtlSeconds: int(env.PROJECTS_REF_URL_TTL_SECONDS, 21_600),        // 参考素材签名链接 6 小时（覆盖轮询超时）
      maxVideoBytes: int(env.PROJECTS_MAX_VIDEO_BYTES, 536_870_912), // 上游成片下载上限 512MB
      // SSE（M1-BE-06 复审）：连接最长存活期（到期服务端主动关闭，客户端带 Last-Event-ID 重连）
      // 与每用户并发连接上限（M2 改 LISTEN/NOTIFY 前先挡住每连接每秒轮询的线性压力）
      sseMaxAgeMs: int(env.PROJECTS_SSE_MAX_AGE_MS, 1_800_000),
      sseMaxConnectionsPerUser: int(env.PROJECTS_SSE_MAX_CONNECTIONS, 5),
    },
    // 定时任务（M1-BE-03）：调度循环每 tickSeconds 秒用「cron:<任务>:<窗口起点>」去重键入队，
    // 多个 Worker 同时调度也只入队一次；清理任务分批（每批 sweepBatchSize 行、每批一个短事务）
    cron: {
      tickSeconds: int(env.CRON_TICK_SECONDS, 60),
      sweepEverySeconds: int(env.CRON_SWEEP_EVERY_SECONDS, 3600),
      expireSweepEverySeconds: int(env.CRON_EXPIRE_SWEEP_EVERY_SECONDS, 300),
      jobsCleanupEverySeconds: int(env.CRON_JOBS_CLEANUP_EVERY_SECONDS, 86_400),
      jobsDoneRetentionDays: int(env.JOBS_DONE_RETENTION_DAYS, 30),
      sweepBatchSize: int(env.CRON_SWEEP_BATCH_SIZE, 500),
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
    // 生成渠道（Modelhub，M0-02 接入）：密钥只从环境变量读取；真实调用须用户授权（AGENTS.md §6）。
    // worker 尚未接线（M2-BE-01 按 M0 结论接入），当前消费方为 scripts/modelhub-smoke.js。
    providers: {
      modelhubBaseUrl: env.MODELHUB_BASE_URL || 'https://api.modelhub.cc',
      modelhubApiKey: env.MODELHUB_API_KEY || '',
      requestTimeoutMs: int(env.PROVIDERS_REQUEST_TIMEOUT_MS, 30_000),
      // 用户 2026-10-21 指定：视频 seedance-2.5、图片 gpt-image-2.5-flare；档位为最小成本冒烟默认
      videoModel: env.GENERATION_VIDEO_MODEL || 'seedance-2.5',
      videoResolution: env.GENERATION_VIDEO_RESOLUTION || '720p',
      imageModel: env.GENERATION_IMAGE_MODEL || 'gpt-image-2.5-flare',
      imageResolution: env.GENERATION_IMAGE_RESOLUTION || '1k',
      imageDetailLevel: env.GENERATION_IMAGE_DETAIL_LEVEL || 'medium',
    },
  };
  if (production) {
    if (!env.DATABASE_URL) throw new Error('生产环境必须设置 DATABASE_URL');
    if (!config.allowedOrigins.length) throw new Error('生产环境必须设置 ALLOWED_ORIGINS');
    if (config.sms.provider === 'console') throw new Error('生产环境必须配置真实短信 provider（SMS_PROVIDER）');
  }
  return Object.freeze(config);
}
