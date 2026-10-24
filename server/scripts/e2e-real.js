// M2-BE-01 真实端到端（手动运行，需用户授权——AGENTS.md §6）：
//   node --env-file=.env scripts/e2e-real.js "一句话故事"          # 全程：剧本→形象→确认→视频→拼接
//   node --env-file=.env scripts/e2e-real.js --resume prj_xxxx     # 断点续跑（渠道排队可能超过单次终端会话时长；
//                                                                  # 视频任务在上游继续，续跑只接结果，不重复提交）
// 用最小成本走完 想法→剧本(LLM)→形象(图模型)→确认点B→提示词绑定(LLM)→2×5 秒 720p 视频→拼接→交付。
// 上游经渠道路由层（数据库渠道，先 npm run channel:seed 写库）；提交绑定 gen_tasks.channel_id，轮询回绑定渠道。
// 连接 config.databaseUrl（本地隔离测试库 compose miv-test），不触碰生产；费用记入成本账本（停止线 40 元）。
// 预估成本：形象 1×36 分 + 视频 2×5s×143 分 = 716+500 分 ≈ 12.2 元（LLM 为 Coding Plan 套餐内；渠道按 token 计费，实际以 usage 为准）。
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
import { loadDriverRegistry } from '../src/engine/providers/index.js';
import { createChannelService } from '../src/channels/service.js';
import { createChannelRouter } from '../src/channels/router.js';
import { createStorageFromConfig } from '../src/engine/storage/index.js';
import { createSafeFetch } from '../src/engine/net/index.js';
import { createLogger } from '../src/logger.js';
import { createDownloader, createLocalFetcher } from '../src/projects/download.js';
import { createProjectHandlers } from '../src/projects/handlers.js';
import { createRender } from '../src/render/index.js';
import { newId } from '../src/db/ids.js';
import { confirmCast, confirmStory, createProject, retryProject } from '../src/projects/service.js';
import { createQuote } from '../src/wallet/pricing.js';
import { videoModelForSkill } from '../src/projects/understand.js';
import { createSkillRegistry } from '../src/engine/skills/index.js';

const argv = process.argv.slice(2);
const resumeIndex = argv.indexOf('--resume');
const resumeProjectId = resumeIndex >= 0 ? argv[resumeIndex + 1] : null;
const storyText = resumeProjectId ? null : (argv[0] ?? '周末带宝宝去公园野餐，宝宝第一次放风筝，开心极了。');
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const ledgerPath = path.join(repoRoot, 'server/.data/e2e-cost-ledger.json');
const POLL_SECONDS = 20;
const POLL_MAX_MINUTES = 100;
// aiide 成本（迁移 008 口径，后台实扣校准）：图片 gpt-image-2 1k = 36 分/张（实扣 $0.05/张）；视频 480p ≈ 68 分/秒（实测 67.2）
const IMAGE_COST_FEN = 36;
const COST = {
  imageFen: () => IMAGE_COST_FEN,
  videoPerSecond: 143, // 720p 渠道成本（迁移 008 公式推算 142.8 取 143）——本轮端到端实测校准对象
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

// 用户授权（CODEX_HANDOFF §3 2026-10-24）：累计费用上限 50 元（5000 分），停止线 40 元（4000 分）；
// 每笔调用前对照账本累计估算（summary 行是汇总不计入），达线停止并汇报。
const LEDGER_STOP_FEN = 4000;
async function spentFen() {
  const { readFile } = await import('node:fs/promises');
  let text = '';
  try { text = await readFile(ledgerPath, 'utf8'); } catch { return 0; }
  return text.split('\n').filter(Boolean)
    .map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter((entry) => entry && entry.kind !== 'summary')
    .reduce((sum, entry) => sum + (entry.estimatedFen ?? 0), 0);
}
async function assertBudget(label, nextFen = 0) {
  const spent = await spentFen();
  if (spent + nextFen > LEDGER_STOP_FEN) {
    throw new Error(`成本账本已累计 ${spent} 分，加「${label}」${nextFen} 分将超过停止线 ${LEDGER_STOP_FEN} 分（40 元），停止并汇报。`);
  }
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
  // M2-BE-03：上游 = 数据库渠道 + 驱动（与生产 worker 同路径）。渠道先 `npm run channel:seed` 写库、
  // `channel:list` 核对；本脚本经渠道路由层装配：提交 pick 绑定 gen_tasks.channel_id，轮询 forTask
  // 回绑定渠道（channel:use 切换只影响新提交，在途任务仍回原渠道——本轮要验证的行为）。
  if (!config.channels.secretKey) throw new Error('需要 CHANNEL_SECRET_KEY（渠道凭证主密钥）');
  const registry = await loadDriverRegistry({ logger });
  const service = createChannelService({ db, secretKey: config.channels.secretKey, registry, logger });
  if (!(await service.listChannels({})).length) {
    throw new Error('渠道表为空：先 `npm run channel:seed` 写入种子渠道并 `npm run channel:list` 核对，再跑本脚本');
  }
  const router = createChannelRouter({ db, service, registry, logger,
    deps: { fetchImpl: dohFallbackFetch, loadReference, downloadImage: (url) => downloadBytes(url) } });
  const routeDriver = async (kind) => (await router.pick(kind)).channel.driver; // 日志只打驱动名（业务层不见渠道名）
  logger.info(`渠道路由就绪：video=${await routeDriver('video')}、image=${await routeDriver('image')}、llm=${await routeDriver('llm')}、存储 ${config.storage.qiniu.bucket}`);

  const userId = 'usr_e2ereal000001';
  await db.tx(async (t) => {
    await t.query(`INSERT INTO users (id, phone, nickname) VALUES ($1, '15988880001', 'E2E 真实链路')
      ON CONFLICT (id) DO NOTHING`, [userId]);
    // 只保证可用额；不清 frozen（断点续跑时冻结是账本事实，清零会导致结算「冻结金额不足」）
    await t.query(`INSERT INTO wallets (user_id, available_fen, frozen_fen) VALUES ($1, 100000, 0)
      ON CONFLICT (user_id) DO UPDATE SET available_fen = 100000`, [userId]);
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
      input: { storyText, sourceType: 'text', styleId: 'picture_book', qualityTierId: 'hd',
        ratio: '9:16', characterIds: [], idempotencyKey: `e2e-${Date.now()}` }, config, channelRouter: router });
    projectId = created.projectId;
    logger.info(`作品已创建 ${projectId}，真实故事理解中（allowedDurations=[5]、maxSeconds=10，控制成本 2×5s 720p）…`);

    // ── 故事理解：LLM 经渠道路由 pick('llm')（与 understand handler 同口径），按 handler 口径持久化 ──
    const llmPicked = await router.pick('llm');
    const storyAgent = createStoryAgent({ llm: llmPicked.instance, logger });
    const videoModel = await videoModelForSkill(db, router); // 生效视频渠道的模型决定 Skill
    const skillId = createSkillRegistry().forModel(videoModel).id;
    const understandStartedAt = Date.now();
    const plan = await storyAgent.understand({ storyText, inputKind: 'idea', expanded: false,
      style: { name: '绘本水彩', promptHint: 'children picture book, watercolor texture, gentle palette' },
      maxSeconds: 10, allowedDurations: [5], characters: [],
      voices: (await db.query(`SELECT id, name, gender, age_group AS "ageGroup", description FROM voices
        WHERE status = 'active' ORDER BY sort, id`)).rows, skillId });
    await recordCost({ kind: 'llm', model: config.providers.llmModel, phase: 'understand',
      estimatedFen: 0, note: 'Coding Plan 套餐内', usage: plan.usage, elapsedMs: Date.now() - understandStartedAt });
    logger.info(`剧本理解完成 degraded=${plan.degraded} segments=${plan.segmentCount}（预算 2×5s）`);
    if (plan.segmentCount !== 2 || plan.segments.some((s) => s.durationSeconds !== 5)) {
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
    await assertBudget('形象生成', IMAGE_COST_FEN);
    const { quoteId: looksQuote } = await db.tx((t) => createQuote(t, { userId,
      request: { kind: 'cast_looks', projectId } }));
    await confirmStory(db, { userId, projectId, quoteId: looksQuote, idempotencyKey: `e2e-cs-${Date.now()}`, config,
      channelRouter: router });
    logger.info('已确认故事，进入形象生成（真实图片模型，经渠道路由）…');
    const lookHandlers = { 'look.generate': createLookGenerateHandler({ db, logger, storage,
      imageProvider: null, channelRouter: router }) };
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

  // ── 确认点 B（cast_review 时）：预占视频费（720p 渠道成本 143 分/秒，售价 200 分/秒）→ rendering ──
  if ((await project(projectId)).status === 'cast_review') {
    await assertBudget('视频预占', 10 * COST.videoPerSecond);
    const { quoteId: renderQuote } = await db.tx((t) => createQuote(t, { userId,
      request: { kind: 'project_render', projectId } }));
    await confirmCast(db, { userId, projectId, quoteId: renderQuote, idempotencyKey: `e2e-cc-${Date.now()}`, config,
      channelRouter: router });
    logger.info('已确认角色，视频费按 720p 预占，进入制作');
  }

  // ── 制作：bind_prompts / segment.generate 走 jobs 表（全部经渠道路由）；gen.poll 回绑定渠道 ──
  // 成片下载走 DoH 版 safeFetch：本机代理 fake-IP 下，裸 safeFetch 会在结果 CDN 域名上挂满 300s 超时
  // （2026-10-24 实测：query 已 succeeded、下载卡死、轮询无限失败直到 120 分钟 unknown）。
  const render = createRender({ logger });
  // 实测结果 URL（火山 TOS 跨境）仅 ~9KB/s：720p 5s 片要 5~7 分钟，超时给足 20 分钟（租约 30 分钟内）
  const downloadToTempFile = createDownloader({ maxBytes: config.projects.maxVideoBytes, timeoutMs: 1_200_000, safeFetchImpl: devSafeFetch });
  const fetchLocal = createLocalFetcher({ storage, maxBytes: config.projects.maxVideoBytes, safeFetchImpl: devSafeFetch });
  const handlers = createProjectHandlers({ db, logger, config, storyAgent: null, videoProvider: null, storage,
    render, downloadToTempFile, fetchLocal, channelRouter: router });
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
          estimatedFen: seg[0].seconds * COST.videoPerSecond, note: `${seg[0].seconds} 秒 @720p` });
        videoCostRecorded = true;
      }
      process.stdout.write(`\r排队生成中… 状态 ${state.status} · ${state.progress?.message ?? ''}   `);
      await new Promise((resolve) => setTimeout(resolve, POLL_SECONDS * 1000));
      const { rows: due } = await db.query(
        `SELECT t.id AS take_id FROM gen_tasks gt
          JOIN segment_takes t ON t.gen_task_id = gt.id
          JOIN segments s ON s.id = t.segment_id
         WHERE s.project_id = $1 AND gt.status = 'running'
           AND (gt.next_poll_at IS NULL OR gt.next_poll_at <= now())`, [projectId]);
      // gen.poll 的 payload.takeId 是 take id（此前误填 gen_tasks.id，导致「片段任务不存在」空转）
      for (const row of due) pendingJobs.push({ type: 'gen.poll', payload: { takeId: row.take_id } });
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
      estimatedFen: COST.imageFen(config) + 10 * COST.videoPerSecond, note: '预估合计（1 形象 + 2×5s 720p）' });
    logger.info(`成本账本：${path.relative(repoRoot, ledgerPath)}，累计估算（不含汇总行）${await spentFen()} 分`);
  } else {
    logger.info(`未完成（${state.status}）——稍后用 --resume ${projectId} 续跑`);
  }
  await db.close();
}

main().catch((error) => {
  console.error(`E2E 失败：${error.message}`);
  process.exit(1);
});
