// Worker 进程入口（AGENTS.md §2：同一时间只有一个写入者，默认 BE-Core）。
// 职责：注册 job 处理器 → 按并发数循环领取 → 执行 → 完成/失败退避；收到退出信号后等待在途任务结束。
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createLookGenerateHandler } from './characters/service.js';
import { loadConfig } from './config.js';
import { createDb } from './db/pool.js';
import { createStorageFromConfig } from './engine/storage/index.js';
import { createLogger } from './logger.js';
import { createDownloader, createLocalFetcher } from './projects/download.js';
import { createProjectHandlers } from './projects/handlers.js';
import { createDevStoryAgent } from './projects/dev-stub.js';
import { createDevVideoProvider } from './projects/dev-stub.js';
import { createRender } from './render/index.js';
import { createScheduler, runAuthSweep, runJobsCleanup, runProjectsExpireSweep, runUploadsSweep } from './queue/cron.js';
import { claim, complete, enqueue, extendLease, fail, PermanentJobError } from './queue/index.js';

// 开发/测试缺省图片模型：返回 1x1 PNG（生产必须注入真实 provider，见 buildHandlers 守卫）
const DEV_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
function createDevImageProvider() {
  return {
    id: 'dev-mock',
    async generate() { return { status: 'succeeded', buffer: DEV_PNG, contentType: 'image/png' }; },
  };
}

/**
 * 处理器签名：async (payload, ctx) => void
 * ctx = { db, logger, job, enqueue(q, spec), extendLease(seconds) }
 * - 处理器必须幂等：同一 job 可能因租约过期被执行多次。
 * - 不要在 db.tx 里等待上游网络调用（AGENTS.md §5）。
 * - 抛出 PermanentJobError 表示不再重试。
 *
 * job 类型与负责模块见 docs/ARCHITECTURE.md §4；各模块就绪后在 buildHandlers 中注册。
 * @param {{ config, db, logger, storage?, imageProvider? }} deps
 *   storage / imageProvider：engine 完成前测试注入模拟；生产环境缺省时启动报错（同 BE-03 做法）。
 */
export function buildHandlers({ config, db, logger, storage, imageProvider, storyAgent, videoProvider }) {
  // §6 审查 3（BE-03）：生产环境不允许缺省内存存储；未注入时按 config.storage.driver 解析
  const objectStorage = storage ?? createStorageFromConfig(config);
  let imageModel = imageProvider;
  if (!imageModel) {
    if (config.production) throw new Error('生产环境必须注入真实图片模型 provider（engine/providers）');
    imageModel = createDevImageProvider();
  }
  // M1-BE-05：storyAgent（engine.story，含真实 LLM）与视频 provider 生产必须注入；
  // 开发缺省确定性桩（视频桩永远返回失败，真实渠道属 M0/M2）
  let story = storyAgent;
  if (!story) {
    if (config.production) throw new Error('生产环境必须注入真实 storyAgent（engine/story + LLM 配置）');
    story = createDevStoryAgent();
  }
  let video = videoProvider;
  if (!video) {
    if (config.production) throw new Error('生产环境必须注入真实视频渠道 provider（engine/providers）');
    video = createDevVideoProvider();
  }
  const render = createRender({ logger });
  const downloadToTempFile = createDownloader({ maxBytes: config.projects.maxVideoBytes });
  const fetchLocal = createLocalFetcher({ storage: objectStorage, maxBytes: config.projects.maxVideoBytes });
  const cronOpts = { batchSize: config.cron.sweepBatchSize };
  const withLog = (name, run) => async (_payload, ctx) => {
    const result = await run(ctx.db, ctx);
    ctx.logger.info(name, result);
  };
  return {
    'auth.sweep': withLog('cron_auth_swept', (sdb) => runAuthSweep(sdb, cronOpts)),
    'uploads.sweep': withLog('cron_uploads_swept', (sdb, ctx) => runUploadsSweep(sdb, { ...cronOpts, storage: objectStorage, logger: ctx.logger })),
    'projects.expire_sweep': withLog('cron_projects_expired', (sdb, ctx) => runProjectsExpireSweep(sdb, { ...cronOpts, storage: objectStorage, logger: ctx.logger })),
    'jobs.cleanup': withLog('cron_jobs_cleaned', (sdb) => runJobsCleanup(sdb, { ...cronOpts, retentionDays: config.cron.jobsDoneRetentionDays })),
    'look.generate': createLookGenerateHandler({ db, logger, storage: objectStorage, imageProvider: imageModel }), // M1-BE-04
    ...createProjectHandlers({ db, logger, config, storyAgent: story, videoProvider: video, storage: objectStorage, render, downloadToTempFile, fetchLocal }), // M1-BE-05
  };
}

export function createWorker({ db, logger, handlers, workerId, concurrency = 2, pollIntervalMs = 1000, leaseSeconds = 120 }) {
  const types = Object.keys(handlers);
  let stopping = false;
  const loops = [];

  async function runOne() {
    const job = await claim(db, { workerId, types, leaseSeconds });
    if (!job) return false;
    const log = logger.child({ jobId: job.id, type: job.type, attempt: job.attempts });
    const ctx = { db, logger: log, job, enqueue, extendLease: (seconds) => extendLease(db, job, workerId, seconds ?? leaseSeconds) };
    const startedAt = Date.now();
    try {
      const handler = handlers[job.type];
      if (!handler) throw new PermanentJobError(`没有注册处理器：${job.type}`);
      await handler(job.payload, ctx);
      if (!(await complete(db, job, workerId))) log.warn('job_lease_lost_on_complete');
      log.info('job_done', { ms: Date.now() - startedAt });
    } catch (err) {
      const { retry, updated } = await fail(db, job, workerId, err);
      log[retry ? 'warn' : 'error']('job_failed', { retry, updated, ms: Date.now() - startedAt, err });
    }
    return true;
  }

  async function loop(slot) {
    while (!stopping) {
      let worked = false;
      try {
        worked = await runOne();
      } catch (err) {
        logger.error('worker_loop_error', { slot, err }); // 数据库暂时不可用等：稍后重试
      }
      if (!worked && !stopping) await sleep(pollIntervalMs);
    }
  }

  return {
    start() {
      if (!types.length) logger.warn('worker_no_handlers');
      for (let i = 0; i < concurrency; i++) loops.push(loop(i));
      logger.info('worker_started', { workerId, concurrency, types });
    },
    /** 停止领取新 job，等待在途 job 结束。 */
    async stop() {
      stopping = true;
      await Promise.all(loops);
    },
    runOne, // 测试用：同步执行一个 job
  };
}

// 直接运行：npm run start:worker -w server
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = loadConfig();
  const logger = createLogger({ level: config.logLevel, base: { proc: 'worker', workerId: config.worker.id } });
  const db = createDb({ url: config.databaseUrl, max: config.worker.concurrency + 2, logger });
  const storage = createStorageFromConfig(config); // M1-ENG-03：按 config.storage.driver 注入（生产 qiniu，开发 memory）
  const worker = createWorker({ db, logger, handlers: buildHandlers({ config, db, logger, storage }), workerId: config.worker.id, ...config.worker });
  const scheduler = createScheduler({ config, db, logger });
  worker.start();
  scheduler.start();
  const shutdown = async (signal) => {
    logger.info('worker_shutdown', { signal });
    setTimeout(() => process.exit(1), 60_000).unref();
    scheduler.stop();
    await worker.stop();
    await db.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
