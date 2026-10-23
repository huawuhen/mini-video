// M2-BE-01 真实端到端（手动运行，需用户授权——AGENTS.md §6）：
//   node --env-file=.env scripts/e2e-real.js "一句话故事"          # 全程：剧本→形象→确认→视频→拼接
//   node --env-file=.env scripts/e2e-real.js --resume prj_xxxx     # 断点续跑（渠道排队可能超过单次终端会话时长；
//                                                                  # 视频任务在上游继续，续跑只接结果，不重复提交）
// 用最小成本走完 想法→剧本(LLM)→形象(图模型)→确认点B→提示词绑定(LLM)→2×5 秒 480p 视频(aiide)→拼接→交付。
// 连接 config.databaseUrl（本地隔离测试库 compose miv-test），不触碰生产；费用记入成本账本。
// 预估成本：形象 1×21 分 + 视频 2×5s×68 分 = 701 分 ≈ 7 元（LLM 为 Coding Plan 套餐内；渠道按 token 计费，实际以 usage 为准）。
// 开发机代理为 fake-IP DNS：渠道 API 直连可用；七牛 CDN 下载走 DoH 绕行（仅本脚本，产品代码不改）。
import { appendFile, mkdir } from 'node:fs/promises';
import dns from 'node:dns/promises';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLookGenerateHandler } from '../src/characters/service.js';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db/pool.js';
import { createStoryAgent } from '../src/engine/story/index.js';
import { createOpenAiCompatLlm } from '../src/engine/llm/openai.js';
import { createAiideMaterials, createAiideVideoAdapter, createAiideImageProvider } from '../src/engine/providers/index.js';
import { createStorageFromConfig } from '../src/engine/storage/index.js';
import { createSafeFetch } from '../src/engine/net/index.js';
import { createLogger } from '../src/logger.js';
import { createDownloader, createLocalFetcher } from '../src/projects/download.js';
import { createProjectHandlers } from '../src/projects/handlers.js';
import { createRender } from '../src/render/index.js';
import { newId } from '../src/db/ids.js';
import { confirmCast, confirmStory, createProject, retryProject } from '../src/projects/service.js';
import { createQuote } from '../src/wallet/pricing.js';
import { videoSkuForMapping } from '../src/projects/understand.js';
import { createSkillRegistry } from '../src/engine/skills/index.js';

const argv = process.argv.slice(2);
const resumeIndex = argv.indexOf('--resume');
const resumeProjectId = resumeIndex >= 0 ? argv[resumeIndex + 1] : null;
const storyText = resumeProjectId ? null : (argv[0] ?? '周末带宝宝去公园野餐，宝宝第一次放风筝，开心极了。');
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const ledgerPath = path.join(repoRoot, 'server/.data/e2e-cost-ledger.json');
const POLL_SECONDS = 20;
const POLL_MAX_MINUTES = 100;
// aiide 成本估算（迁移 007 注释口径，待真实 usage 校准）：图片 gpt-image-2 1k ≈ 21 分/张；视频 480p ≈ 68 分/秒
const IMAGE_COST_FEN = 21;
const COST = {
  imageFen: () => IMAGE_COST_FEN,
  videoPerSecond: 68, // 与 skus.cost_fen 同步（price_audit 调价对账会校验）
};

// 开发机代理 fake-IP DNS 绕行（与 modelhub-smoke.js 同款，仅本脚本使用）
const FAKE_IP_PREFIXES = ['198.18.', '198.19.'];
const DOH_ENDPOINTS = ['https://223.5.5.5/resolve', 'https://1.1.1.1/dns-query', 'https://8.8.8.8/resolve'];
async function resolveWithDoh(hostname, { signal } = {}) {
  for (const endpoint of DOH_ENDPOINTS) {
    try {
      const response = await fetch(`${endpoint}?name=${encodeURIComponent(hostname)}&type=A`,
        { signal, headers: { accept: 'application/dns-json' } });
      const data = await response.json();
      const records = (data.Answer ?? []).filter((item) => item.type === 1)
        .map((item) => ({ address: item.data, family: 4 }));
      if (records.length) return records;
    } catch { /* 换下一个 DoH */ }
  }
  return [];
}
const dohFallbackFetch = async (url, init = {}) => {
  try {
    return await fetch(url, init);
  } catch (error) {
    const text = String(error.message) + (error.cause?.code ?? '');
    if (!/ENOTFOUND|fetch failed/i.test(text)) throw error;
    const u = new URL(url);
    const ips = await resolveWithDoh(u.hostname).catch(() => []);
    if (!ips.length) throw error;
    console.warn(`fetch 失败，DoH 直连重试：${u.hostname} → ${ips.map((r) => r.address).join(',')}`);
    const https = await import('node:https');
    return new Promise((resolve, reject) => {
      const req = https.request({ hostname: ips[0].address, path: `${u.pathname}${u.search}`, port: 443,
        method: init.method ?? 'GET', headers: { ...init.headers, host: u.hostname },
        servername: u.hostname, agent: false }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: res.headers })));
      });
      req.on('error', reject);
      init.signal?.addEventListener('abort', () => req.destroy(new Error('已取消')), { once: true });
      if (init.body) req.write(init.body);
      req.end();
    });
  }
};
const devSafeFetch = createSafeFetch({ resolver: async (hostname, options) => {
  // 系统 DNS 解析失败（如国外域名）或解析到 fake-IP 时，都改走 DoH
  let records = [];
  try { records = await dns.lookup(hostname, { all: true, verbatim: true }); } catch { /* 走 DoH */ }
  const suspicious = !records.length
    || records.some((record) => FAKE_IP_PREFIXES.some((prefix) => record.address.startsWith(prefix)));
  if (suspicious) {
    const real = await resolveWithDoh(hostname, options).catch(() => []);
    if (real.length) return real;
  }
  if (!records.length) throw new Error(`无法解析 ${hostname}（系统 DNS 与 DoH 均失败）`);
  return records;
} });

async function recordCost(entry) {
  await mkdir(path.dirname(ledgerPath), { recursive: true });
  await appendFile(ledgerPath, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
}

const isTransient = (error) => error?.retryable === true
  || /fetch failed|network|timeout|ECONN|ETIMEDOUT|socket/i.test(String(error?.message));

async function main() {
  // 本机 DNS 对部分域名返回 ::ffff: 映射地址，undici（fetch）拿它连接会 ENOTFOUND
  // （node:https/curl 走 IPv4 正常）：进程内强制 IPv4 优先，仅本脚本生效
  dns.setDefaultResultOrder('ipv4first');
  const config = loadConfig({ ...process.env, GEN_UPSTREAMS: 'real' });
  const logger = createLogger({ level: 'info', base: { proc: 'e2e-real' } });
  if (!config.providers.real) throw new Error('本脚本只应以 GEN_UPSTREAMS=real 运行');
  if (config.storage.driver !== 'qiniu') throw new Error('STORAGE_DRIVER 必须为 qiniu（参考素材要上游可访问）');
  const cdnHost = new URL(config.storage.qiniu.domain).hostname;
  const addresses = await dns.resolve4(cdnHost).catch(() => []);
  if (addresses.some((ip) => ip.startsWith('198.18.') || ip.startsWith('198.19.'))) {
    const real = await resolveWithDoh(cdnHost).catch(() => []);
    if (!real.length) throw new Error(`${cdnHost} 为 fake-IP 解析且 DoH 不可用，请检查本机代理`);
    logger.info(`本机代理 fake-IP 生效，下载走 DoH：${cdnHost} → ${real.map((r) => r.address).join(', ')}`);
  }

  const db = createDb({ url: config.databaseUrl, max: 4, logger });
  // 历史失败运行可能残留 queued 的旧 job（会真实花钱）：启动时全部作废，本脚本只跑自己入队的
  {
    const { rowCount } = await db.query(
      `UPDATE jobs SET status = 'failed', updated_at = now()
        WHERE status = 'queued' AND type IN ('look.generate', 'project.bind_prompts', 'segment.generate')`);
    if (rowCount) logger.warn(`已作废 ${rowCount} 个历史残留 job`);
    // 上次会话（前台跑满被中断）遗留的 running：收回队列接着跑（处理器幂等，不会重复提交上游）
    const back = await db.query(
      `UPDATE jobs SET status = 'queued', locked_by = NULL, locked_until = NULL, updated_at = now()
        WHERE status = 'running' AND locked_by = 'e2e'
          AND type IN ('look.generate', 'project.bind_prompts', 'segment.generate') RETURNING id`);
    if (back.rowCount) logger.warn(`收回上次会话遗留的 running job ${back.rowCount} 个`);
  }
  // 本机 DNS 对部分域名间歇 ENOTFOUND（undici fetch 受影响，node:https 一直正常——见排障记录）：
  // 七牛上传通道改用 node:https 全新连接实现（同 directFetch 口径），失败自动重试 3 次
  const nodeHttpsFetch = (url, init = {}, attempt = 0) => new Promise((resolve, reject) => {
    const u = new URL(url);
    const headers = { ...init.headers };
    if (init.body && headers['Content-Length'] === undefined) headers['Content-Length'] = Buffer.byteLength(init.body);
    const req = https.request({ hostname: u.hostname, path: `${u.pathname}${u.search}`, port: 443,
      method: init.method ?? 'GET', headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        ok: res.statusCode >= 200 && res.statusCode < 300,
        status: res.statusCode,
        headers: res.headers,
        text: async () => Buffer.concat(chunks).toString('utf8'),
        json: async () => JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'),
      }));
    });
    req.on('error', (e) => {
      if (attempt < 3) setTimeout(() => nodeHttpsFetch(url, init, attempt + 1).then(resolve, reject), 1500);
      else reject(e);
    });
    req.setTimeout(120_000, () => req.destroy(new Error('上传请求超时')));
    if (init.body) req.write(init.body);
    req.end();
  });
  const { createQiniuStorage } = await import('../src/engine/storage/qiniu.js');
  const storage = createQiniuStorage(config.storage.qiniu,
    { defaultTtlSeconds: config.storage.signedUrlTtlSeconds, fetchImpl: nodeHttpsFetch });
  // 参考照片：存储 key → 签名链接 → 受控下载字节（图片 edits 以文件上传）
  const downloadBytes = async (url) => {
    const response = await devSafeFetch(url, { maxBytes: 20 * 1024 * 1024 });
    const chunks = [];
    for await (const chunk of response.stream) chunks.push(chunk);
    return { buffer: Buffer.concat(chunks), contentType: response.contentType };
  };
  const loadReference = async (key) => ({
    ...(await downloadBytes(await storage.signedUrl(key, { ttlSeconds: config.storage.signedUrlTtlSeconds }))),
    name: key.split('/').pop(),
  });
  const aiideArgs = { baseUrl: config.providers.aiideBaseUrl, apiKey: config.providers.aiideApiKey,
    fetchImpl: dohFallbackFetch, logger };
  const materials = createAiideMaterials({ ...aiideArgs, requestTimeoutMs: config.providers.requestTimeoutMs,
    pollIntervalMs: config.providers.aiideMaterialsPollIntervalMs, pollTimeoutMs: config.providers.aiideMaterialsPollTimeoutMs,
    purpose: config.providers.aiideMaterialsPurpose });
  const videoProvider = createAiideVideoAdapter({ ...aiideArgs, model: config.providers.videoModel, materials,
    timeoutMs: config.providers.requestTimeoutMs, generateAudio: config.providers.videoGenerateAudio });
  const imageProvider = createAiideImageProvider({ ...aiideArgs, model: config.providers.imageModel,
    resolution: config.providers.imageResolution, ratio: config.providers.imageRatio,
    quality: config.providers.imageQuality, maxReferences: config.providers.imageMaxReferences,
    requestTimeoutMs: config.providers.requestTimeoutMs, loadReference, downloadImage: downloadBytes });
  const llm = createOpenAiCompatLlm({ baseUrl: config.providers.llmBaseUrl, apiKey: config.providers.llmApiKey,
    model: config.providers.llmModel, logger });
  const storyAgent = createStoryAgent({ llm, logger });
  logger.info(`上游就绪：视频 ${config.providers.videoModel}/480p、图片 ${config.providers.imageModel}/${config.providers.imageResolution}、LLM ${config.providers.llmModel}、存储 ${config.storage.qiniu.bucket}`);

  const userId = 'usr_e2ereal000001';
  await db.tx(async (t) => {
    await t.query(`INSERT INTO users (id, phone, nickname) VALUES ($1, '15988880001', 'E2E 真实链路')
      ON CONFLICT (id) DO NOTHING`, [userId]);
    await t.query(`INSERT INTO wallets (user_id, available_fen) VALUES ($1, 100000)
      ON CONFLICT (user_id) DO UPDATE SET available_fen = 100000, frozen_fen = 0`, [userId]);
  });
  const project = async (id) => (await db.query(`SELECT status, progress FROM projects WHERE id = $1`, [id])).rows[0];
  const pendingJobs = [];
  const ctxOf = () => ({ db, logger, job: { attempts: 0 },
    enqueue: async (spec) => pendingJobs.push(spec), extendLease: async () => {} });
  const requeue = (id) => db.query(
    `UPDATE jobs SET status = 'queued', locked_by = NULL, run_at = now() + interval '20 seconds' WHERE id = $1`, [id]);
  /** 领取 jobs 表里 queued 的指定类型 job 并执行；瞬时失败回退重试，业务失败抛出终止。 */
  const jobRetries = new Map();
  async function pumpJobs(types, handlersByType) {
    const { rows: jobs } = await db.query(
      `SELECT id, type, payload FROM jobs WHERE status = 'queued' AND type = ANY($1::text[]) ORDER BY id LIMIT 5`,
      [types]);
    for (const job of jobs) {
      // 只执行本项目入队的 job：历史失败运行的残留一律作废（避免花冤枉钱）
      const owned = job.payload.projectId
        ? job.payload.projectId === projectId
        : await db.query(
          `SELECT 1 FROM look_versions lv JOIN project_cast pc ON pc.look_version_id = lv.id
            WHERE lv.id = $1 AND pc.project_id = $2`, [job.payload.versionId, projectId]).then((r) => !!r.rowCount);
      if (!owned) {
        await db.query(`UPDATE jobs SET status = 'failed', updated_at = now() WHERE id = $1`, [job.id]);
        continue;
      }
      logger.info(`执行 job ${job.type} ${JSON.stringify(job.payload)}`);
      await db.query(
        `UPDATE jobs SET status = 'running', locked_by = 'e2e', locked_until = now() + make_interval(mins => 30),
           attempts = attempts + 1 WHERE id = $1`, [job.id]);
      try {
        await handlersByType[job.type](job.payload, ctxOf());
        await db.query(`UPDATE jobs SET status = 'done', locked_by = NULL, updated_at = now() WHERE id = $1`, [job.id]);
      } catch (error) {
        const tries = (jobRetries.get(job.id) ?? 0) + 1;
        jobRetries.set(job.id, tries);
        if (tries <= 12 && isTransient(error)) {
          logger.warn(`job ${job.type} 瞬时失败，回退重试（${tries}/12）：${error.message}` +
            ` | code=${error.code ?? '-'} cause=${error.cause?.code ?? error.cause?.message ?? '-'}`);
          if (tries === 1) {
            logger.warn(`诊断栈：${String(error.stack).split('\n').slice(0, 14).join(' || ')}`);
            try {
              const t0 = Date.now();
              const probe = await fetch(`${config.providers.aiideBaseUrl.replace(/\/+$/, '')}/v1/models`,
                { headers: { Authorization: `Bearer ${config.providers.aiideApiKey}` } });
              logger.warn(`诊断：同进程裸 fetch GET /v1/models → ${probe.status}，${Date.now() - t0}ms（连通则属连接复用问题）`);
            } catch (e) {
              logger.warn(`诊断：同进程裸 fetch 也失败：${e.message} cause=${e.cause?.code ?? '-'}`);
            }
          }
          await requeue(job.id);
        } else {
          await db.query(`UPDATE jobs SET status = 'failed', locked_by = NULL, updated_at = now() WHERE id = $1`, [job.id]);
          throw error; // 渠道明确拒绝等业务失败：终止脚本，冻结金额待人工处理
        }
      }
    }
    return jobs.length;
  }

  let projectId;
  if (resumeProjectId) {
    const { rows } = await db.query(`SELECT id, status FROM projects WHERE id = $1 AND user_id = $2`,
      [resumeProjectId, userId]);
    if (!rows.length) throw new Error('resume：作品不存在或不属于 e2e 用户');
    projectId = rows[0].id;
    logger.info(`续跑 ${projectId}（当前状态 ${rows[0].status}）`);
  } else {
    const created = await createProject(db, { userId,
      input: { storyText, sourceType: 'text', styleId: 'picture_book', qualityTierId: 'standard',
        ratio: '9:16', characterIds: [], idempotencyKey: `e2e-${Date.now()}` }, config });
    projectId = created.projectId;
    logger.info(`作品已创建 ${projectId}，真实故事理解中（allowedDurations=[5]、maxSeconds=10，控制成本 2×5s）…`);

    // ── 故事理解：直接调 storyAgent（allowedDurations 4 秒档控成本），按 handler 同款口径持久化 ──
    const projectRow = (await db.query(`SELECT tier_mapping_id FROM projects WHERE id = $1`, [projectId])).rows[0];
    const sku = await videoSkuForMapping(db, projectRow.tier_mapping_id);
    const skillId = createSkillRegistry().forModel(sku.model).id;
    const understandStartedAt = Date.now();
    const plan = await storyAgent.understand({ storyText, inputKind: 'idea', expanded: false,
      style: { name: '绘本水彩', promptHint: 'children picture book, watercolor texture, gentle palette' },
      maxSeconds: 10, allowedDurations: [5], characters: [],
      voices: (await db.query(`SELECT id, name, gender, age_group AS "ageGroup", description FROM voices
        WHERE status = 'active' ORDER BY sort, id`)).rows, skillId });
    await recordCost({ kind: 'llm', model: config.providers.llmModel, phase: 'understand',
      estimatedFen: 0, note: 'Coding Plan 套餐内', usage: plan.usage, elapsedMs: Date.now() - understandStartedAt });
    logger.info(`剧本理解完成 degraded=${plan.degraded} segments=${plan.segmentCount}（预算 2×4s）`);
    if (plan.segmentCount !== 2 || plan.segments.some((s) => s.durationSeconds !== 4)) {
      logger.warn(`LLM 规划偏离预期（${JSON.stringify(plan.segments.map((s) => s.durationSeconds))}），继续执行，成本相应变化`);
    }
    await db.tx(async (t) => {
      const castIds = [];
      for (const [index, person] of plan.cast.entries()) {
        const castId = newId('cast');
        castIds.push(castId);
        await t.query(
          `INSERT INTO project_cast (id, project_id, idx, name, description, gender, age_group, character_id, match_source)
           VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, 'new')`,
          [castId, projectId, index, person.name, person.description ?? '', person.gender, person.ageGroup]);
      }
      // 为每个角色分配不重复音色（真实产品由 LLM 推荐/用户选择；e2e 直接分配以过确认 B）
      for (const [index, castId] of castIds.entries()) {
        await t.query(
          `UPDATE project_cast SET voice_id = (SELECT id FROM voices WHERE status = 'active'
              ORDER BY sort, id OFFSET $1 LIMIT 1), voice_source = 'ai'
            WHERE id = $2 AND voice_id IS NULL`,
          [index % 8, castId]);
      }

      for (const [index, segment] of plan.segments.entries()) {
        await t.query(
          `INSERT INTO segments (id, project_id, idx, duration_seconds, plot, camera_notes, dialogue, ambience, transition, cast_ids)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [newId('seg'), projectId, index, segment.durationSeconds, segment.plot, segment.cameraNotes ?? '',
            JSON.stringify(segment.dialogue.map((line) => ({ castId: castIds[line.castIndex], line: line.line }))),
            segment.ambience ?? '', segment.transition, segment.castIndexes.map((i) => castIds[i])]);
      }
      const story = { inputKind: plan.inputKind, expanded: plan.expanded, script: plan.script,
        synopsis: plan.synopsis, totalSeconds: plan.totalSeconds, segmentCount: plan.segmentCount,
        compressed: plan.compressed, usage: plan.usage, raw: plan };
      await t.query(`UPDATE projects SET story = $2, title = $3, updated_at = now() WHERE id = $1`,
        [projectId, JSON.stringify(story), plan.title || 'E2E 真实链路']);
      await t.query(`UPDATE projects SET status = 'story_review', progress = $2 WHERE id = $1 AND status = 'understanding'`,
        [projectId, JSON.stringify({ percent: 15, message: '故事已就绪，等待你确认' })]);
      await t.query(`INSERT INTO project_events (project_id, status, progress) VALUES ($1, 'story_review', $2)`,
        [projectId, JSON.stringify({ percent: 15, message: '故事已就绪' })]);
    });

    // ── 确认点 A：新角色自动建数字人 + 真实形象生成 ──
    const { quoteId: looksQuote } = await db.tx((t) => createQuote(t, { userId,
      request: { kind: 'cast_looks', projectId } }));
    await confirmStory(db, { userId, projectId, quoteId: looksQuote, idempotencyKey: `e2e-cs-${Date.now()}`, config });
    logger.info('已确认故事，进入形象生成（真实图片模型）…');
    const lookHandlers = { 'look.generate': createLookGenerateHandler({ db, logger, storage, imageProvider }) };
    for (;;) {
      const ran = await pumpJobs(['look.generate'], lookHandlers);
      const state = await project(projectId);
      if (state.status === 'cast_review') break;
      if (state.status === 'failed' || state.status === 'canceled') {
        throw new Error(`项目已进入 ${state.status}：${state.progress?.message ?? ''}（本次会话终止，冻结金额按协议待对账/退回）`);
      }
      if (!ran && state.status === 'casting') {
        const { rows: queued } = await db.query(
          `SELECT count(*)::int AS n FROM jobs WHERE status = 'queued' AND type = 'look.generate'`);
        if (!queued[0].n) {
          const { rows: versions } = await db.query(
            `SELECT lv.status, gt.status AS task_status FROM look_versions lv
               JOIN project_cast pc ON pc.look_version_id = lv.id
               LEFT JOIN gen_tasks gt ON gt.id = lv.gen_task_id
              WHERE pc.project_id = $1`, [projectId]);
          throw new Error(`形象任务已停但项目仍 casting：${JSON.stringify(versions)}`);
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
    logger.info('形象全部就绪，进入确认点 B');
    await recordCost({ kind: 'image', model: config.providers.imageModel, phase: 'cast_looks',
      estimatedFen: COST.imageFen(config), note: '1 张 1k' });
  }

  // ── 确认点 B（cast_review 时）：预占视频费（真实 SKU 480p = 80 分/秒）→ rendering ──
  if ((await project(projectId)).status === 'cast_review') {
    const { quoteId: renderQuote } = await db.tx((t) => createQuote(t, { userId,
      request: { kind: 'project_render', projectId } }));
    await confirmCast(db, { userId, projectId, quoteId: renderQuote, idempotencyKey: `e2e-cc-${Date.now()}`, config });
    logger.info('已确认角色，视频费按 480p 预占，进入制作');
  }

  // ── 制作：bind_prompts / segment.generate 走 jobs 表；gen.poll 由脚本按 next_poll_at 重排 ──
  const render = createRender({ logger });
  const downloadToTempFile = createDownloader({ maxBytes: config.projects.maxVideoBytes });
  const fetchLocal = createLocalFetcher({ storage, maxBytes: config.projects.maxVideoBytes });
  const handlers = createProjectHandlers({ db, logger, config, storyAgent, videoProvider, storage,
    render, downloadToTempFile, fetchLocal });
  let retriedOnce = false;
  const deadline = Date.now() + POLL_MAX_MINUTES * 60_000;
  let videoCostRecorded = false;
  for (;;) {
    await pumpJobs(['project.bind_prompts', 'segment.generate'], handlers);
    if (pendingJobs.length) {
      const spec = pendingJobs.shift();
      logger.info(`执行 job ${spec.type} ${JSON.stringify(spec.payload)}`);
      try {
        await handlers[spec.type](spec.payload, ctxOf());
      } catch (error) {
        logger.warn(`job ${spec.type} 失败（下次轮询再看）：${error.message}`);
      }
      continue;
    }
    const state = await project(projectId);
    if (state.status === 'delivered') break;
    if (state.status === 'failed' && !retriedOnce) {
      retriedOnce = true;
      logger.warn(`项目 failed（${state.progress?.message ?? ''}），按产品 retry 路径自动重试一次…`);
      await retryProject(db, { userId, projectId });
      continue;
    }
    if (state.status === 'failed' || state.status === 'canceled') break;
    if (Date.now() > deadline) {
      logger.info(`本次会话 ${POLL_MAX_MINUTES} 分钟到点，视频仍在渠道排队。用 --resume ${projectId} 续跑（不重复提交、不重复计费）。`);
      break;
    }
    const { rows: runningTakes } = await db.query(
      `SELECT t.id FROM segment_takes t JOIN segments s ON s.id = t.segment_id
        WHERE s.project_id = $1 AND t.status IN ('pending', 'running')`, [projectId]);
    if (runningTakes.length) {
      if (!videoCostRecorded) {
        const { rows: seg } = await db.query(
          `SELECT COALESCE(SUM(duration_seconds), 0)::int AS seconds FROM segments WHERE project_id = $1`, [projectId]);
        await recordCost({ kind: 'video', model: config.providers.videoModel, phase: 'project_render',
          estimatedFen: seg[0].seconds * COST.videoPerSecond, note: `${seg[0].seconds} 秒 @480p` });
        videoCostRecorded = true;
      }
      process.stdout.write(`\r排队生成中… 状态 ${state.status} · ${state.progress?.message ?? ''}   `);
      await new Promise((resolve) => setTimeout(resolve, POLL_SECONDS * 1000));
      const { rows: due } = await db.query(
        `SELECT gt.id FROM gen_tasks gt
          JOIN segment_takes t ON t.gen_task_id = gt.id
          JOIN segments s ON s.id = t.segment_id
         WHERE s.project_id = $1 AND gt.status = 'running'
           AND (gt.next_poll_at IS NULL OR gt.next_poll_at <= now())`, [projectId]);
      for (const row of due) pendingJobs.push({ type: 'gen.poll', payload: { takeId: row.id } });
      continue;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  const state = await project(projectId);
  const wallet = (await db.query(`SELECT available_fen, frozen_fen FROM wallets WHERE user_id = $1`, [userId])).rows[0];
  logger.info(`最终状态：${state.status}`);
  logger.info(`钱包对账：available=${wallet.available_fen} frozen=${wallet.frozen_fen}`);
  for (const row of (await db.query(
    `SELECT kind, amount_fen, frozen_delta_fen, title FROM ledger WHERE user_id = $1 ORDER BY created_at`, [userId])).rows) {
    logger.info(`流水：${row.kind} ${row.amount_fen}/${row.frozen_delta_fen} ${row.title}`);
  }
  const renderRow = (await db.query(
    `SELECT video_key, duration_seconds FROM renders WHERE project_id = $1 AND status = 'succeeded'
      ORDER BY created_at DESC LIMIT 1`, [projectId])).rows[0];
  logger.info(`成片：${renderRow?.video_key ?? '（尚未就绪）'} ${renderRow?.duration_seconds ?? '?'} 秒`);
  if (state.status === 'delivered') {
    await recordCost({ kind: 'summary', projectId, status: state.status,
      estimatedFen: COST.imageFen(config) + 10 * COST.videoPerSecond, note: '预估合计（1 形象 + 2×5s 480p）' });
    logger.info(`成本账本：${path.relative(repoRoot, ledgerPath)}`);
  } else {
    logger.info(`未完成（${state.status}）——稍后用 --resume ${projectId} 续跑`);
  }
  await db.close();
}

main().catch((error) => {
  console.error(`E2E 失败：${error.message}`);
  process.exit(1);
});
