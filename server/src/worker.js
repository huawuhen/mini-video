// Worker 进程入口（AGENTS.md §2：同一时间只有一个写入者，默认 BE-Core）。
// 职责：注册 job 处理器 → 按并发数循环领取 → 执行 → 完成/失败退避；收到退出信号后等待在途任务结束。
// M2-BE-03：上游全部经渠道路由层（数据库渠道 + 驱动）；GEN_UPSTREAMS=mock 时用确定性桩（零真实费用）。
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createLookGenerateHandler } from './characters/service.js';
import { loadConfig } from './config.js';
import { createDb } from './db/pool.js';
import { createStoryAgent } from './engine/story/index.js';
import { loadDriverRegistry } from './engine/providers/index.js';
import { safeFetch } from './engine/net/index.js';
import { createChannelService } from './channels/service.js';
import { createChannelRouter } from './channels/router.js';
import { createStorageFromConfig } from './engine/storage/index.js';
import { createLogger } from './logger.js';
import { createDownloader, createLocalFetcher } from './projects/download.js';
import { createProjectHandlers } from './projects/handlers.js';
import { createDevStoryAgent, createDevVideoProvider } from './projects/dev-stub.js';
import { createRender } from './render/index.js';
import { createScheduler, runAuthSweep, runJobsCleanup, runProjectsExpireSweep, runProjectsFailedSweep,
  runUploadsSweep } from './queue/cron.js';
import { createPriceAuditHandler } from './queue/price-audit.js';
import { claim, complete, enqueue, extendLease, fail, PermanentJobError } from './queue/index.js';

// 开发/测试缺省图片模型：返回 1x1 PNG（生产必须注入真实 provider，见 buildHandlers 守卫）
const DEV_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
function createDevImageProvider() {
  return {
    id: 'dev-mock',
    capabilities: () => ({ model: 'dev-mock', resolutions: ['1k'], ratios: ['1:1'], refImages: 1, refAudio: 0, withAudio: false }),
    async generate() { return { status: 'succeeded', buffer: DEV_PNG, contentType: 'image/png', attempts: 1 }; },
  };
}

/** 经 net.safeFetch 的受控下载（SSRF/大小/超时防护），给图片驱动参考图与结果下载用。 */
async function downloadViaNet(url, { maxBytes, timeoutMs = 120_000, headers } = {}) {
  const response = await safeFetch(url, { maxBytes, timeoutMs, headers });
  const chunks = [];
  for await (const chunk of response.stream) chunks.push(chunk);
  return { buffer: Buffer.concat(chunks), contentType: response.contentType };
}

/**
 * 装配渠道路由层（M2-BE-03）：渠道来自数据库（种子引导后以库为准），驱动实例按渠道创建。
 * 依赖 CHANNEL_SECRET_KEY（凭证解密）。GEN_UPSTREAMS=real 时必须成功装配；mock 时可缺省（桩）。
 */
export async function createChannelLayer({ config, db, logger, storage }) {
  const registry = await loadDriverRegistry({ logger });
  const service = createChannelService({
    db, secretKey: config.channels.secretKey, registry, logger,
  });
  const loadReference = async (key) => {
    const url = await storage.signedUrl(key, { ttlSeconds: config.storage.signedUrlTtlSeconds });
    const { buffer, contentType } = await downloadViaNet(url, { maxBytes: 20 * 1024 * 1024 });
    return { buffer, contentType, name: key.split('/').pop() };
  };
  const router = createChannelRouter({
    db, service, registry, logger,
    deps: {
      // 参考照片：存储 key → 签名链接 → 受控下载（图片 edits 以文件字节上传）
      loadReference,
      // 渠道改返回 url 时经 safeFetch 受控下载
      downloadImage: (url, headers) => downloadViaNet(url, { maxBytes: 20 * 1024 * 1024, headers }),
      // local-mock 视频产物经存储签名链接返回（M2-WEB-01 零费用联调；回环地址过不了 safeFetch）
      storage,
    },
  });
  return { registry, service, router };
}

/** 种子引导（ARCHITECTURE §5.5 启动引导）：首次部署把环境变量写成种子渠道；仅表为空时。 */
export async function seedChannels({ config, db, service, logger }) {
  const p = config.providers;
  const seeds = [];
  if (p.aiideApiKey) {
    seeds.push(
      {
        kind: 'video', name: 'aiide', driver: 'aiide-ark',
        baseUrl: p.aiideBaseUrl, credential: p.aiideApiKey,
        modelMap: { video: p.videoModel },
        params: { generateAudio: p.videoGenerateAudio },
        costFen: { 'video.480p': 68, 'video.720p': 151 }, // 720p 实测 21,780 tok/s（2026-10-24，迁移 010），非公式推算
        remark: '种子渠道（env 引导）：火山方舟视频协议 + 素材库过审', activate: true,
      },
      {
        kind: 'image', name: 'aiide', driver: 'openai-images',
        baseUrl: p.aiideBaseUrl, credential: p.aiideApiKey,
        modelMap: { image: p.imageModel },
        params: { resolution: p.imageResolution, ratio: p.imageRatio, quality: p.imageQuality,
          maxReferences: p.imageMaxReferences },
        costFen: { 'image.look': 36 },
        remark: '种子渠道（env 引导）：OpenAI Images 同步图片', activate: true,
      },
    );
  }
  if (p.miaowuaiApiKey) {
    seeds.push(
      {
        kind: 'video', name: 'miaowuai', driver: 'openai-videos',
        baseUrl: p.miaowuaiBaseUrl, credential: p.miaowuaiApiKey,
        modelMap: { video: p.miaowuaiVideoModel },
        costFen: { 'video.480p': 38, 'video.720p': 63 },
        remark: '种子渠道（env 引导）：OpenAI 风格异步视频（备用）', activate: false,
      },
      {
        kind: 'image', name: 'miaowuai', driver: 'openai-image-tasks',
        baseUrl: p.miaowuaiBaseUrl, credential: p.miaowuaiApiKey,
        modelMap: { image: p.miaowuaiImageModel },
        params: { pollIntervalMs: p.imagePollIntervalMs, pollTimeoutMs: p.imagePollTimeoutMs },
        costFen: { 'image.look': 5 },
        remark: '种子渠道（env 引导）：OpenAI 风格异步图片（备用）', activate: false,
      },
    );
  }
  if (p.llmBaseUrl && p.llmApiKey && p.llmModel) {
    seeds.push({
      kind: 'llm', name: 'zhipu', driver: 'openai-compatible',
      baseUrl: p.llmBaseUrl, credential: p.llmApiKey,
      modelMap: { llm: p.llmModel },
      remark: '种子渠道（env 引导）：智谱 OpenAI Compatible', activate: true,
    });
  }
  const audit = async ({ action, targetType, targetId, detail }) => {
    try {
      await db.query(
        `INSERT INTO admin_audit_logs (actor, action, target_type, target_id, detail)
         VALUES ('seed', $1, $2, $3, $4)`,
        [action, targetType, String(targetId), JSON.stringify(detail ?? {})]);
    } catch (err) { logger?.warn?.('seed_audit_failed', { message: err?.message }); }
  };
  const result = await service.seedFromEnv(seeds, audit);
  logger?.info?.('channels_seeded', { seeded: result.seeded, count: result.channels.length });
  return result;
}

/**
 * 处理器签名：async (payload, ctx) => void
 * ctx = { db, logger, job, enqueue(q, spec), extendLease(seconds) }
 * - 处理器必须幂等：同一 job 可能因租约过期被执行多次。
 * - 不要在 db.tx 里等待上游网络调用（AGENTS.md §5）。
 * - 抛出 PermanentJobError 表示不再重试。
 */
/**
 * M2-WEB-01 零费用联调：写入并激活 local-mock 渠道（video/image/llm 三条，driver: local-mock）。
 * 与 seedChannels 不同：不要求渠道表为空（可与真实渠道共存），幂等（已存在则更新 params 并重新激活路由）。
 * 切回真实渠道用 `npm run channel:use -- <kind> <渠道名>`。**生产环境拒绝**（local-mock 为 devOnly 驱动）。
 */
export async function seedMockChannels({ config, db, service, logger }) {
  if (config.production) throw new Error('生产环境禁止写入 local-mock 联调渠道（devOnly 驱动不注册）');
  const audit = async ({ action, targetType, targetId, detail }) => {
    await db.query(
      `INSERT INTO admin_audit_logs (actor, action, target_type, target_id, detail)
       VALUES ('seed-mock', $1, $2, $3, $4)`,
      [action, targetType, String(targetId), JSON.stringify(detail ?? {})]);
  };
  const spec = (kind) => ({
    kind, name: 'local-mock', driver: 'local-mock',
    baseUrl: 'http://local-mock.invalid', credential: 'local-mock-no-secret',
    modelMap: { [kind]: 'local-mock/sample' },
    params: {}, remark: 'M2-WEB-01 零费用联调模拟渠道（channel:seed -- --mock 写入）', activate: true,
  });
  const channels = [];
  for (const kind of ['video', 'image', 'llm']) {
    const existing = await service.getChannelByName(kind, 'local-mock');
    const row = existing
      ? await (async () => { await service.setChannelStatus(existing.id, 'active', audit); return existing; })()
      : await service.createChannel(spec(kind), audit);
    await service.setRoutes(kind, '*', [row.id], audit); // 激活为生效路由（真实渠道转为待命）
    channels.push(row);
  }
  logger?.info?.('mock_channels_seeded', { count: channels.length });
  return { channels };
}

export function buildHandlers({ config, db, logger, storage, imageProvider, storyAgent, videoProvider, channelLayer }) {
  // §6 审查 3（BE-03）：生产环境不允许缺省内存存储；未注入时按 config.storage.driver 解析
  const objectStorage = storage ?? createStorageFromConfig(config);
  const useChannels = config.providers.real && channelLayer;
  let upstreamSummary = { video: 'dev-stub', image: 'dev-mock', llm: 'dev-stub',
    storage: config.storage.driver, channels: useChannels ? 'db-routed' : 'off' };
  let imageModel = imageProvider;
  let story = storyAgent;
  let video = videoProvider;
  if (useChannels) {
    // M2-BE-03：视频/图片/LLM 全部经渠道路由层；处理器内 pick/forTask（见 handlers/service）
    upstreamSummary = { ...upstreamSummary, video: 'channel-router', image: 'channel-router', llm: 'channel-router' };
  } else if (config.providers.real && config.production) {
    throw new Error('生产环境 GEN_UPSTREAMS=real 必须装配渠道路由层（CHANNEL_SECRET_KEY + 种子引导）');
  }
  // M2-OPS-03 修复：渠道路由模式下视频/图片/LLM 全部由处理器经 channelRouter pick，
  // 注入式 provider 仅是 mock 回退——生产 + channels 模式不注入是正确状态（此前守卫会误拒，
  // 生产 worker 在渠道路由模式下从未启动过；e2e/联调都是自驱 handler 或 development 口径）
  if (!imageModel) {
    if (!useChannels) {
      if (config.production) throw new Error('生产环境必须注入真实图片模型 provider（engine/providers）');
      imageModel = createDevImageProvider();
    }
  }
  if (!story) {
    if (!useChannels) {
      if (config.production) throw new Error('生产环境必须注入真实 storyAgent（engine/story + LLM 配置）');
      story = createDevStoryAgent();
    }
  }
  if (!video) {
    if (!useChannels) {
      if (config.production) throw new Error('生产环境必须注入真实视频渠道 provider（engine/providers）');
      video = createDevVideoProvider();
    }
  }
  logger.info('worker_upstreams', upstreamSummary);
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
    'projects.failed_sweep': withLog('cron_projects_failed_canceled', (sdb, ctx) => runProjectsFailedSweep(sdb,
      { ...cronOpts, cancelDays: config.projects.failedCancelDays, logger: ctx.logger })),
    'jobs.cleanup': withLog('cron_jobs_cleaned', (sdb) => runJobsCleanup(sdb, { ...cronOpts, retentionDays: config.cron.jobsDoneRetentionDays })),
    'channels.retired_sweep': withLog('cron_retired_channels_swept', (sdb) =>
      channelLayer ? channelLayer.service.sweepRetiredCredentials() : { cleared: 0 }),
    'providers.price_audit': createPriceAuditHandler({ db, logger, config, channelLayer }),
    'look.generate': createLookGenerateHandler({ db, logger, storage: objectStorage,
      imageProvider: imageModel, channelRouter: channelLayer?.router ?? null }), // M1-BE-04 + M2-BE-03
    ...createProjectHandlers({ db, logger, config, storyAgent: story, videoProvider: video,
      storage: objectStorage, render, downloadToTempFile, fetchLocal,
      channelRouter: channelLayer?.router ?? null }), // M1-BE-05 + M2-BE-03
  };
}

// M2-BE-04①：作品流水线任务重试耗尽（终态 failed）时的兜底表。
// step 用任务对应的进行中状态；gen.poll/look.generate 的 payload 只有 takeId/versionId，需反查。
// M2-BE-04 复审必改 1：gen.poll / segment.generate / look.generate 耗尽时先收口在途的
// take / 形象版本（否则作品置 failed 可重试后，重试会被 running take / pending 版本卡死
// 或重复提交上游）；三个分支收口成功即返回，PIPELINE_FAILED 只兜「无在途对象」的场景。
const PIPELINE_FALLBACK = new Map([
  ['project.understand', { step: 'understanding', message: '故事理解遇到问题，可以重试或取消' }],
  ['project.bind_prompts', { step: 'rendering', message: '制作遇到问题，可以重试或取消' }],
  ['segment.generate', { step: 'rendering', message: '制作遇到问题，可以重试或取消' }],
  ['gen.poll', { step: 'rendering', message: '制作遇到问题，可以重试或取消' }],
  ['project.compose', { step: 'composing', message: '拼接遇到问题，可以重试或取消' }],
  ['look.generate', { step: 'casting', message: '角色形象生成遇到问题，可以重试或取消' }],
]);

async function failProjectOnExhausted(db, job, logger) {
  const spec = PIPELINE_FALLBACK.get(job.type);
  if (!spec) return;
  try {
    // ── 复审必改 1：在途 take / 形象版本收口（成功即返回，各分支自带作品终态）──
    if (job.type === 'gen.poll') {
      // 轮询任务耗尽 = 上游已提交、结果未知 → 与轮询超时同口径（unknown + TAKE_UNKNOWN）
      const { rows } = await db.query(
        `SELECT gt.request->>'projectId' AS pid, gt.user_id, gt.id AS gen_task_id
           FROM segment_takes t JOIN gen_tasks gt ON gt.id = t.gen_task_id
          WHERE t.id = $1 AND t.status = 'running'`, [job.payload?.takeId]);
      const row = rows[0];
      if (row) {
        const { markTakeUnknown } = await import('./projects/segment.js');
        await markTakeUnknown(db, null, { take: job.payload.takeId, projectId: row.pid,
          userId: row.user_id, genTaskId: row.gen_task_id, logger });
        return;
      }
      return; // take 不在 running（已被收口/已成功）：无需处理
    }
    if (job.type === 'segment.generate') {
      const { settleExhaustedSegmentGenerate } = await import('./projects/segment.js');
      if (await settleExhaustedSegmentGenerate(db, job.payload, logger)) return;
    }
    if (job.type === 'look.generate') {
      const { settleExhaustedLookGenerate } = await import('./characters/service.js');
      if (await settleExhaustedLookGenerate(db, { versionId: job.payload?.versionId }, logger)) return;
    }
    // ── 无在途对象（或 gen_task 已终态）→ 作品置 failed 兜底 ──
    let projectId = job.payload?.projectId ?? null;
    if (!projectId && job.type === 'look.generate') {
      const { rows } = await db.query(
        `SELECT pc.project_id FROM look_versions lv
           JOIN project_cast pc ON pc.look_version_id = lv.id WHERE lv.id = $1`,
        [job.payload?.versionId]);
      projectId = rows[0]?.project_id ?? null;
    }
    if (!projectId) return;
    const { markProjectPipelineFailed } = await import('./projects/state.js');
    await markProjectPipelineFailed(db, { projectId, step: spec.step, message: spec.message, logger });
  } catch (error) {
    // 兜底自身失败不阻塞 job 记账（下次 cron/人工可再处理）；记日志供排查
    logger?.error?.('pipeline_fail_fallback_error', { jobType: job.type, message: error?.message });
  }
}

export function createWorker({ db, logger, handlers, workerId, concurrency = 2, pollIntervalMs = 1000, leaseSeconds = 120 }) {
  const types = Object.keys(handlers);
  let stopping = false;
  const loops = [];

  async function runOne() {
    const job = await claim(db, { workerId, types, leaseSeconds });
    if (!job) return false;
    const log = logger.child({ jobId: job.id, type: job.type, attempt: job.attempts });
    // enqueue 对处理器收口为单参 spec（queue.enqueue 是 (q, spec) 两参——直接透传会让
    // ctx.enqueue(spec) 在运行时把 spec 当 q、undefined 当 spec 解构炸掉，M2-WEB-01 联调实测暴露）
    const ctx = { db, logger: log, job, enqueue: (spec) => enqueue(db, spec),
      extendLease: (seconds) => extendLease(db, job, workerId, seconds ?? leaseSeconds) };
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
      // M2-BE-04①：重试耗尽（终态 failed）且是作品流水线任务 → 作品置 failed（A 口径冻结保持，
      // 可 retry/取消），不再永远停在进行中。failed 时 updated=false（租约已失）也兜底：
      // job 已是终态 failed 即可（fail() 的条件更新输掉竞争不代表作品不该置 failed）。
      if (!retry) await failProjectOnExhausted(db, job, log);
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
  const boot = async () => {
    let channelLayer = null;
    if (config.providers.real) {
      // M2-BE-03：real 模式装配渠道路由层 + 种子引导（仅首次表空时写种子；此后以数据库为准）
      channelLayer = await createChannelLayer({ config, db, logger, storage });
      await seedChannels({ config, db, service: channelLayer.service, logger });
    }
    return createWorker({ db, logger, handlers: buildHandlers({ config, db, logger, storage, channelLayer }),
      workerId: config.worker.id, ...config.worker });
  };
  boot().then((worker) => {
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
  }).catch((err) => {
    logger.error('worker_boot_failed', { message: err?.message });
    process.exit(1);
  });
}
