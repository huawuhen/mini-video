// Modelhub 真实渠道冒烟脚本（M0-02）。手动运行，不参与 npm test；真实调用须用户授权
// （CODEX_HANDOFF §3 2026-10-20：累计上限 300 元，账本估算累计达到 270 元硬停，超出范围需另行授权）。
// 用法（cwd=server，密钥放 .env，禁止入库）：
//   node --env-file=.env scripts/modelhub-smoke.js models
//   node --env-file=.env scripts/modelhub-smoke.js image [--resolution 1k] [--detail low] [--ratio 1:1]
//        [--reference <图片文件>] [--prompt <文本>]
//   node --env-file=.env scripts/modelhub-smoke.js video [--seconds 4] [--resolution 480p] [--ratio 9:16]
//        [--prompt <文本>] [--timeout <秒>]
// 产物（图片/视频字节）落 server/.data/m0/（.gitignore 已忽略）；账本与目录快照落 docs/m0/
// （只记渠道、模型、参数、估算费用，不含密钥与上游临时链接）。
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import dns from 'node:dns';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { createModelhubTransport, createModelhubImageAdapter, createSeedance25Adapter } from '../src/engine/providers/index.js';
import { createSafeFetch } from '../src/engine/net/index.js';

const STOP_LIMIT_FEN = 27_000; // 270 元 = 授权上限 300 元的 90%
// 2026-10-21 实测目录单价（分）：图片按张（随分辨率与档位），视频按秒。目录若调价，先更新此处再冒烟。
const FLARE_PRICE = {
  '1k': { low: 10, medium: 23, high: 33, xhigh: 45, max: 80 },
  '2k': { low: 17, medium: 30, high: 44, xhigh: 60, max: 120 },
  '4k': { low: 22, medium: 37, high: 60, xhigh: 85, max: 150 },
};
const SEEDANCE_PRICE_PER_SECOND = { '480p': 39, '720p': 47, '1080p': 280 };

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const m0Dir = path.join(repoRoot, 'docs', 'm0');
const artifactsDir = path.join(repoRoot, 'server', '.data', 'm0');
const ledgerPath = path.join(m0Dir, 'cost-ledger.json');

const argv = process.argv.slice(2);
const command = argv[0];
const options = {};
for (let i = 1; i < argv.length; i += 1) {
  if (!argv[i].startsWith('--')) continue;
  const [key, value = 'true'] = argv[i].slice(2).split('=');
  if (value !== 'true') options[key] = value;
  else if (argv[i + 1] && !argv[i + 1].startsWith('--')) options[key] = argv[++i];
  else options[key] = true;
}

const EXTENSIONS = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'video/mp4': 'mp4', 'video/quicktime': 'mov' };
const CONTENT_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };
const FAKE_IP_PREFIXES = ['198.18.', '198.19.']; // 本机代理 TUN fake-IP 模式的保留网段（仅开发环境）

// 开发机代理常用 fake-IP DNS（一切域名解析成 198.18.x.x），会被 safeFetch 的 SSRF 防护正确拒绝。
// 脚本内改用阿里 DoH 解析真实地址直连；产品代码不改（生产 Linux 无此环境，防护保持默认）。
async function resolveWithDoh(hostname, { signal }) {
  const response = await fetch(`https://223.5.5.5/resolve?name=${encodeURIComponent(hostname)}&type=A`, { signal });
  const data = await response.json();
  return (data.Answer ?? []).filter((item) => item.type === 1).map((item) => ({ address: item.data, family: 4 }));
}

function createDevResolver() {
  return async (hostname, { signal } = {}) => {
    const records = await dns.promises.lookup(hostname, { all: true, verbatim: true });
    if (records.some((record) => FAKE_IP_PREFIXES.some((prefix) => record.address.startsWith(prefix)))) {
      try {
        const real = await resolveWithDoh(hostname, { signal });
        if (real.length) {
          console.log(`检测到本机代理 fake-IP（${records[0].address}），改用 DoH 解析 ${hostname} → ${real.map((r) => r.address).join(', ')}`);
          return real;
        }
      } catch { /* DoH 不可用时退回系统解析，由 safeFetch 按防护规则拒绝 */ }
    }
    return records;
  };
}

const devSafeFetch = createSafeFetch({ resolver: createDevResolver() });

async function readLedger() {
  try { return JSON.parse(await readFile(ledgerPath, 'utf8')); }
  catch { return { updatedAt: null, totalEstimatedFen: 0, entries: [] }; }
}

async function writeLedger(ledger) {
  ledger.updatedAt = new Date().toISOString();
  await mkdir(m0Dir, { recursive: true });
  await writeFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
}

// 授权规则③：调用前先按已知单价估算并写入账本，累计达到停止线即拒绝执行
async function reserve(kind, model, params, estimatedFen) {
  const ledger = await readLedger();
  if (ledger.totalEstimatedFen + estimatedFen > STOP_LIMIT_FEN) {
    throw new Error(`账本累计估算 ${ledger.totalEstimatedFen} 分 + 本次 ${estimatedFen} 分超过停止线 ${STOP_LIMIT_FEN} 分（270 元），停止调用。`);
  }
  const entry = { at: new Date().toISOString(), channel: 'modelhub', kind, model, params,
    estimatedFen, actualFen: null, status: 'submitted' };
  ledger.entries.push(entry);
  ledger.totalEstimatedFen += estimatedFen;
  await writeLedger(ledger);
  return { ledger, entry };
}

async function finish(ledger, entry, patch) {
  Object.assign(entry, patch);
  await writeLedger(ledger);
}

async function download(url, maxBytes) {
  // 只打印主机名（不含带签名的路径与查询串）；真实地址解析见 createDevResolver 的日志
  console.log(`下载结果主机：${new URL(url).hostname}`);
  const response = await devSafeFetch(url, { maxBytes, timeoutMs: 120_000 });
  const chunks = [];
  for await (const chunk of response.stream) chunks.push(chunk);
  return { buffer: Buffer.concat(chunks), contentType: response.contentType };
}

async function saveArtifact(ledger, entry, { buffer, contentType }) {
  await mkdir(artifactsDir, { recursive: true });
  const name = `${entry.kind}-${Date.now()}.${EXTENSIONS[contentType] ?? 'bin'}`;
  await writeFile(path.join(artifactsDir, name), buffer);
  await finish(ledger, entry, { status: 'succeeded', artifact: `server/.data/m0/${name}`, bytes: buffer.length });
  console.log(`已保存 ${entry.kind} 产物：server/.data/m0/${name}（${buffer.length} 字节，${contentType}）`);
}

async function main() {
  const config = loadConfig();
  const { modelhubBaseUrl, modelhubApiKey, requestTimeoutMs } = config.providers;
  if (!modelhubApiKey) {
    console.error('缺少 MODELHUB_API_KEY（server/.env）；真实调用需要用户授权（AGENTS.md §6）。');
    process.exit(1);
  }
  const transport = createModelhubTransport({ baseUrl: modelhubBaseUrl, apiKey: modelhubApiKey,
    timeoutMs: requestTimeoutMs, logger: console });

  if (command === 'models') {
    const raw = await transport.request('/v1/models?include_capabilities=1');
    await mkdir(m0Dir, { recursive: true });
    const target = path.join(m0Dir, 'modelhub-catalog.json');
    await writeFile(target, `${JSON.stringify(raw, null, 2)}\n`);
    console.log(`目录快照已写入 ${path.relative(repoRoot, target)}（${(raw.data ?? raw.models ?? []).length} 个模型）。`);
    return;
  }

  if (command === 'image') {
    const resolution = options.resolution ?? config.providers.imageResolution;
    const detail = options.detail ?? config.providers.imageDetailLevel;
    const ratio = options.ratio ?? '1:1';
    const prompt = options.prompt
      ?? '数字人形象照：年轻女性正面半身像，浅色清新背景，柔和自然光，写实风格';
    const estimatedFen = FLARE_PRICE[resolution]?.[detail];
    if (!Number.isInteger(estimatedFen)) {
      throw new Error(`未知价格（${resolution}/${detail}）：目录可能已调价，请先跑 models 更新单价表。`);
    }
    const referencePath = options.reference ? path.resolve(options.reference) : null;
    const loadReference = referencePath ? async () => ({
      buffer: await readFile(referencePath),
      contentType: CONTENT_TYPES[path.extname(referencePath).slice(1).toLowerCase()] ?? 'image/png',
      name: path.basename(referencePath),
    }) : undefined;
    const adapter = createModelhubImageAdapter({ transport, model: 'gpt-image-2.5-flare', loadReference, logger: console });
    const prepared = adapter.prepare({ promptHint: prompt, description: '', ratio, detailLevel: detail,
      referenceKeys: referencePath ? ['reference'] : [] }, { resolution });
    const { ledger, entry } = await reserve('image', 'gpt-image-2.5-flare',
      { resolution, detail, ratio, reference: referencePath ? path.basename(referencePath) : null }, estimatedFen);
    const startedAt = Date.now();
    try {
      const result = await adapter.submit(prepared);
      if (result.status !== 'succeeded') throw new Error(`提交结果异常：${result.status} ${result.error ?? ''}`);
      const url = result.outputs[0].url;
      console.log(`图片生成成功，开始下载（上游临时链接不入库）…`);
      await saveArtifact(ledger, entry, await download(url, 20 * 1024 * 1024));
      await finish(ledger, entry, { elapsedMs: Date.now() - startedAt });
    } catch (error) {
      await finish(ledger, entry, { status: `failed：${String(error.message).slice(0, 200)}`,
        elapsedMs: Date.now() - startedAt });
      throw error;
    }
    return;
  }

  if (command === 'video') {
    const resolution = options.resolution ?? '480p';
    const ratio = options.ratio ?? '9:16';
    const seconds = Number(options.seconds ?? 4);
    const timeoutSeconds = Number(options.timeout ?? 900);
    const prompt = options.prompt ?? '城市清晨，一位年轻女性沿着公园小径慢跑，镜头平稳跟随，画面明亮清新';
    const unit = SEEDANCE_PRICE_PER_SECOND[resolution];
    if (!Number.isInteger(unit)) {
      throw new Error(`未知单价（${resolution}）：目录可能已调价，请先跑 models 更新单价表。`);
    }
    const adapter = createSeedance25Adapter(transport);
    const prepared = adapter.prepare({ prompt, durationSeconds: seconds, ratio }, { resolution });
    const { ledger, entry } = await reserve('video', 'seedance-2.5', { resolution, ratio, seconds }, unit * seconds);
    const startedAt = Date.now();
    try {
      const submitted = await adapter.submit(prepared, { idempotencyKey: `m0-smoke-${startedAt}` });
      if (submitted.status === 'unknown') {
        // 授权口径：提交结果未知保持冻结待对账；本脚本无法退款，提示人工到渠道后台核对
        await finish(ledger, entry, { status: 'unknown：提交结果未确认，请到渠道后台对账该时间段任务',
          elapsedMs: Date.now() - startedAt });
        throw new Error('提交结果未知（上游受理不确定），未自动重提；请到渠道后台对账。');
      }
      entry.taskId = submitted.upstreamId;
      await writeLedger(ledger);
      console.log(`已提交任务 ${submitted.upstreamId}，每 ${config.projects.genPollIntervalSeconds} 秒轮询，上限 ${timeoutSeconds} 秒…`);
      const deadline = Date.now() + timeoutSeconds * 1000;
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, config.projects.genPollIntervalSeconds * 1000));
        const state = await adapter.query(submitted.upstreamId);
        if (state.status === 'succeeded') {
          console.log('视频生成成功，开始下载（上游临时链接不入库）…');
          await saveArtifact(ledger, entry, await download(state.outputs[0].url, config.projects.maxVideoBytes));
          await finish(ledger, entry, { elapsedMs: Date.now() - startedAt });
          return;
        }
        if (state.status === 'failed') {
          // 上游明确失败：渠道侧是否计费以后台为准，账本 actualFen 保留 null 待对账
          await finish(ledger, entry, { status: `failed：${state.providerMessage ?? state.error}`,
            elapsedMs: Date.now() - startedAt });
          throw new Error(`上游明确失败：${state.providerMessage ?? state.error}`);
        }
        if (Date.now() > deadline) {
          await finish(ledger, entry, { status: `timeout：轮询超过 ${timeoutSeconds} 秒，任务 ${submitted.upstreamId} 待人工对账` });
          throw new Error(`轮询超时，任务 ${submitted.upstreamId} 未到终态；请到渠道后台确认。`);
        }
        process.stdout.write(`.${state.status === 'running' ? '' : '?'}`);
      }
    } catch (error) {
      if (entry.status === 'submitted') {
        await finish(ledger, entry, { status: `failed：${String(error.message).slice(0, 200)}`,
          elapsedMs: Date.now() - startedAt });
      }
      throw error;
    }
  }

  if (command === 'video-query') {
    // 对账/续查：按 taskId 继续轮询已提交任务并回写账本（不产生新费用）
    const taskId = options.task;
    if (!taskId) throw new Error('用法：video-query --task <taskId> [--timeout 秒]');
    const timeoutSeconds = Number(options.timeout ?? 1800);
    const ledger = await readLedger();
    const entry = ledger.entries.find((item) => item.taskId === taskId);
    if (!entry) throw new Error(`账本中找不到任务 ${taskId}`);
    const adapter = createSeedance25Adapter(transport);
    console.log(`续查任务 ${taskId}，每 ${config.projects.genPollIntervalSeconds} 秒轮询，上限 ${timeoutSeconds} 秒…`);
    const deadline = Date.now() + timeoutSeconds * 1000;
    for (;;) {
      let state;
      try {
        state = await adapter.query(taskId);
      } catch (error) {
        // 瞬时网络错误（与 gen.poll 的队列退避同口径）：不放弃，继续轮询到截止时间
        if (error?.retryable !== true && Date.now() > deadline) throw error;
        process.stdout.write('?');
        await new Promise((resolve) => setTimeout(resolve, config.projects.genPollIntervalSeconds * 1000));
        continue;
      }
      if (state.status === 'succeeded') {
        console.log('视频生成成功，开始下载…');
        await saveArtifact(ledger, entry, await download(state.outputs[0].url, config.projects.maxVideoBytes));
        return;
      }
      if (state.status === 'failed') {
        await finish(ledger, entry, { status: `failed：${state.providerMessage ?? state.error}` });
        throw new Error(`上游明确失败：${state.providerMessage ?? state.error}`);
      }
      if (Date.now() > deadline) {
        await finish(ledger, entry, { status: `timeout：续查超过 ${timeoutSeconds} 秒仍未终态，待人工对账` });
        throw new Error(`续查超时，任务仍未到终态。`);
      }
      await new Promise((resolve) => setTimeout(resolve, config.projects.genPollIntervalSeconds * 1000));
      process.stdout.write('.');
    }
  }

  console.error('未知子命令；可用：models / image / video / video-query。');
  process.exit(1);
}

main().catch((error) => {
  console.error(`[modelhub-smoke] ${error.message}`);
  process.exit(1);
});
