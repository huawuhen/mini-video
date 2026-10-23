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
      // failed 作品超过 N 天自动取消并退回未结算冻结（M2-BE-01，TASKS M2-BE-02 并入项）
      failedCancelDays: int(env.PROJECTS_FAILED_CANCEL_DAYS, 7),
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
      // 渠道调价对账：拉实时目录与 skus.cost_fen 比对，漂移记 error 日志（real 模式才执行）
      priceAuditEverySeconds: int(env.CRON_PRICE_AUDIT_EVERY_SECONDS, 21_600),
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
    // 生成渠道（aiide，用户 2026-10-23 指定，替代喵呜；文档 https://aiide.apifox.cn/chinese）：
    //   视频走火山方舟协议 POST /v1/video/generations + GET /v1/video/generations/{task_id}（参考图先经素材库过审）；
    //   图片走 OpenAI Images POST /v1/images/generations | /v1/images/edits（同步，b64_json）。
    // GEN_UPSTREAMS=real 时 Worker 接入真实上游，缺省 mock 走确定性桩——测试与开发零真实费用。
    providers: {
      real: env.GEN_UPSTREAMS === 'real',
      channel: 'aiide', // skus.channel 过滤与装配口径；换渠道时随适配器一起改
      aiideBaseUrl: (env.AIIDE_BASE_URL || 'https://www.aiide.com').replace(/\/+$/, ''),
      aiideApiKey: env.AIIDE_API_KEY || '',
      // 素材库过审轮询（视频参考图：人脸/虚拟人必须过审）；超时按「未提交、可重试」交队列退避
      aiideMaterialsPollIntervalMs: int(env.AIIDE_ASSET_POLL_INTERVAL_MS, 2_000),
      aiideMaterialsPollTimeoutMs: int(env.AIIDE_ASSET_POLL_TIMEOUT_MS, 180_000),
      aiideMaterialsPurpose: env.AIIDE_ASSET_PURPOSE || 'Mini AI Video 参考素材',
      // 喵呜（2026-10-22 临时渠道）配置保留给仍在仓库里的适配器/脚本，不再装配、不再必填
      miaowuaiBaseUrl: (env.MIAOWU_BASE_URL || 'https://api.miaowuai.store').replace(/\/+$/, ''),
      miaowuaiApiKey: env.MIAOWU_API_KEY || '',
      // 图片同步生成实测 20~110 秒，默认 3 分钟留足余量
      requestTimeoutMs: int(env.PROVIDERS_REQUEST_TIMEOUT_MS, 180_000),
      // 视频 dreamina-seedance-2-5-hc、图片 gpt-image-2（用户 2026-10-23 指定）
      videoModel: env.GENERATION_VIDEO_MODEL || 'dreamina-seedance-2-5-hc',
      videoResolution: env.GENERATION_VIDEO_RESOLUTION || '480p',
      videoGenerateAudio: bool(env.GENERATION_VIDEO_GENERATE_AUDIO, true), // 原生音频（对白口型同步依赖）
      imageModel: env.GENERATION_IMAGE_MODEL || 'gpt-image-2',
      imageResolution: env.GENERATION_IMAGE_RESOLUTION || '1k', // 1k/2k/4k → OpenAI size（见 aiide-image.js）
      imageRatio: env.GENERATION_IMAGE_RATIO || '1:1',
      imageQuality: env.GENERATION_IMAGE_QUALITY || '', // 缺省不传，由渠道按模型默认
      imageMaxReferences: int(env.GENERATION_IMAGE_MAX_REFERENCES, 1), // 用户 2026-10-17：先只用第一张；edits 支持 1~4
      imagePollIntervalMs: int(env.PROVIDERS_IMAGE_POLL_INTERVAL_MS, 5_000), // （喵呜异步任务遗留）
      imagePollTimeoutMs: int(env.PROVIDERS_IMAGE_POLL_TIMEOUT_MS, 600_000),
      // 文本 LLM（用户 2026-10-21 选型：智谱中国区 Coding Plan，OpenAI Compatible）。
      // real 模式下三项都必填；密钥只在服务端 env，禁止写入仓库。
      llmBaseUrl: env.STORY_LLM_BASE_URL || '',
      llmApiKey: env.STORY_LLM_API_KEY || '',
      llmModel: env.STORY_LLM_MODEL || '',
    },
  };
  if (production) {
    if (!env.DATABASE_URL) throw new Error('生产环境必须设置 DATABASE_URL');
    if (!config.allowedOrigins.length) throw new Error('生产环境必须设置 ALLOWED_ORIGINS');
    if (config.sms.provider === 'console') throw new Error('生产环境必须配置真实短信 provider（SMS_PROVIDER）');
  }
  return Object.freeze(config);
}
