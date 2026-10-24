// aiide 真实渠道冒烟脚本（M2-BE-01 渠道切换）。手动运行，不参与 npm test；真实调用须用户授权
// （CODEX_HANDOFF §3 2026-10-20：累计上限 300 元，账本估算累计达到 270 元硬停，超出范围需另行授权）。
// 用法（cwd=server，密钥放 .env，禁止入库）：
//   node --env-file=.env scripts/aiide-smoke.js models
//   node --env-file=.env scripts/aiide-smoke.js image [--prompt <文本>] [--reference <图片文件>]
//        [--resolution 1k] [--ratio 1:1] [--quality <auto|standard|hd>]
//   node --env-file=.env scripts/aiide-smoke.js material --reference <图片文件|URL>   # 只验证素材库上传过审
//   node --env-file=.env scripts/aiide-smoke.js video [--seconds 5] [--resolution 480p] [--ratio 9:16]
//        [--prompt <文本>] [--image <本地文件|URL>]… [--audio <本地文件|URL>]…
//        [--no-materials] [--no-wait] [--timeout <秒>]
//   node --env-file=.env scripts/aiide-smoke.js video-query <taskId>                 # 收割 --no-wait 的任务
// 计费（定价页 2026-10-23，按 token）：视频 token ≈ 宽×高×24fps×秒 ÷ 1024，$9.63/M，按 7.2 汇率折分；
//   图片按张估算 21 分。任务完成后打印 usage.total_tokens——用它校准迁移 007 的 cost_fen。
// 本地参考素材先上传七牛（miv-test/m0/ 前缀，签名 TTL 6 小时）；产物落 server/.data/m0/（gitignore）；
// 账本 docs/m0/cost-ledger.json 只记渠道、模型、参数与估算费用，不含密钥与上游临时链接。
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import dns from 'node:dns';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import arkDriver from '../src/engine/providers/drivers/aiide-ark/index.js';
import imagesDriver from '../src/engine/providers/drivers/openai-images/index.js';
import { createQiniuStorage } from '../src/engine/storage/qiniu.js';
import { createSafeFetch } from '../src/engine/net/index.js';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const STOP_LIMIT_FEN = 27_000; // 270 元 = 授权上限 300 元的 90%
// Seedance 分辨率×画幅的像素规格（火山口径，用于 token 估算；480p 9:16=480×864 等）
const DIMENSIONS = {
  '480p': { '9:16': [480, 864], '16:9': [864, 480], '1:1': [640, 640], '4:3': [736, 544], '3:4': [544, 736] },
  '720p': { '9:16': [704, 1248], '16:9': [1248, 704], '1:1': [960, 960], '4:3': [960, 720], '3:4': [720, 960] },
  '1080p': { '9:16': [1080, 1920], '16:9': [1920, 1080], '1:1': [1440, 1440], '4:3': [1440, 1080], '3:4': [1080, 1440] },
};
const USD_PER_MTOKEN = 9.63; // dreamina-seedance-2-5-hc（定价页 2026-10-23，分组 9 折后仍按此值估算）
const FX_CNY_PER_USD = 7.2;
const IMAGE_ESTIMATE_FEN = 36; // gpt-image-2 1k（后台实扣 $0.05/张 × 7.2，迁移 008 口径）

/** 与 skus.cost_fen 同口径的估算；无法确定像素规格时退回每秒 68/143 分。 */
export function estimateVideoFen(resolution, ratio, seconds) {
  const [w, h] = DIMENSIONS[resolution]?.[ratio] ?? [];
  if (!w || !h) return (resolution === '720p' ? 143 : 68) * seconds;
  const tokens = Math.ceil((w * h * 24 * seconds) / 1024);
  return Math.ceil((tokens * USD_PER_MTOKEN / 1_000_000) * FX_CNY_PER_USD * 100);
}

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const m0Dir = path.join(repoRoot, 'docs', 'm0');
const artifactsDir = path.join(repoRoot, 'server', '.data', 'm0');
const ledgerPath = path.join(m0Dir, 'cost-ledger.json');

const argv = process.argv.slice(2);
const command = argv[0];
const options = {};
const REPEATABLE_KEYS = ['image', 'audio'];
for (let i = 1; i < argv.length; i += 1) {
  if (!argv[i].startsWith('--')) continue;
  const [key, value = 'true'] = argv[i].slice(2).split('=');
  if (value !== 'true') options[key] = value;
  else if (REPEATABLE_KEYS.includes(key)) (options[key] ??= []).push(argv[++i]);
  else if (argv[i + 1] && !argv[i + 1].startsWith('--')) options[key] = argv[++i];
  else options[key] = true;
}

const EXTENSIONS = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'video/mp4': 'mp4', 'video/quicktime': 'mov' };
const REFERENCE_CONTENT_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', mp3: 'audio/mpeg', wav: 'audio/wav' };
const FAKE_IP_PREFIXES = ['198.18.', '198.19.']; // 本机代理 TUN fake-IP 模式的保留网段（仅开发环境，产品代码不改）

async function resolveWithDoh(hostname, { signal } = {}) {
  for (const endpoint of ['https://223.5.5.5/resolve', 'https://1.1.1.1/dns-query']) {
    try {
      const response = await fetch(`${endpoint}?name=${encodeURIComponent(hostname)}&type=A`,
        { signal, headers: { accept: 'application/dns-json' } });
      const data = await response.json();
      const records = (data.Answer ?? []).filter((item) => item.type === 1).map((item) => ({ address: item.data, family: 4 }));
      if (records.length) return records;
    } catch { /* 换下一个 DoH */ }
  }
  return [];
}

const devSafeFetch = createSafeFetch({ resolver: async (hostname, opts = {}) => {
  let records = [];
  try { records = await dns.promises.lookup(hostname, { all: true, verbatim: true }); } catch { /* 走 DoH */ }
  if (!records.length || records.some((r) => FAKE_IP_PREFIXES.some((p) => r.address.startsWith(p)))) {
    const real = await resolveWithDoh(hostname, opts).catch(() => []);
    if (real.length) return real;
  }
  if (!records.length) throw new Error(`无法解析 ${hostname}（系统 DNS 与 DoH 均失败）`);
  return records;
} });

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
  const entry = { at: new Date().toISOString(), channel: 'aiide', kind, model, params,
    estimatedFen, actualFen: null, status: 'submitted' };
  ledger.entries.push(entry);
  ledger.totalEstimatedFen += estimatedFen;
  await writeLedger(ledger);
  console.log(`账本：+${estimatedFen} 分（累计估算 ${ledger.totalEstimatedFen} / 停止线 ${STOP_LIMIT_FEN} 分）`);
  return { ledger, entry };
}
async function finish(ledger, entry, patch) {
  Object.assign(entry, patch);
  await writeLedger(ledger);
}

async function download(url, maxBytes, timeoutMs = 120_000) {
  console.log(`下载结果主机：${new URL(url).hostname}`);
  const response = await devSafeFetch(url, { maxBytes, timeoutMs });
  const chunks = [];
  for await (const chunk of response.stream) chunks.push(chunk);
  return { buffer: Buffer.concat(chunks), contentType: response.contentType };
}

// 本地参考素材先上传七牛再以签名链接提交（与产品提交链路同款）；http(s) 地址直接透传。
// ⚠ aiide 素材库按 URL 扩展名校验类型：本地文件名必须带 jpg/jpeg/png/webp（图）、mp4/mov（视频）、wav/mp3（音频）。
let referenceStorage;
async function toReferenceUrl(value) {
  if (/^https?:\/\//i.test(value)) return value;
  const q = loadConfig().storage.qiniu;
  if (!q.accessKey || !q.secretKey || !q.bucket || !q.domain) {
    throw new Error('本地参考素材需上传七牛：缺少 QINIU_ACCESS_KEY / SECRET_KEY / BUCKET / DOMAIN。');
  }
  referenceStorage ??= createQiniuStorage({ ...q, region: q.region || 'z0' });
  const file = path.resolve(value);
  const buffer = await readFile(file);
  const key = `miv-test/m0/${Date.now()}-${path.basename(file)}`;
  await referenceStorage.put(key, buffer, { contentType: REFERENCE_CONTENT_TYPES[path.extname(file).slice(1).toLowerCase()] ?? 'application/octet-stream' });
  console.log(`参考素材已上传七牛：${key}（${buffer.length} 字节）`);
  return referenceStorage.signedUrl(key, { ttlSeconds: 6 * 3600 });
}

async function saveArtifact(ledger, entry, { buffer, contentType }) {
  await mkdir(artifactsDir, { recursive: true });
  const name = `${entry.kind}-${Date.now()}.${EXTENSIONS[contentType] ?? 'bin'}`;
  await writeFile(path.join(artifactsDir, name), buffer);
  await finish(ledger, entry, { status: 'succeeded', artifact: `server/.data/m0/${name}`, bytes: buffer.length });
  console.log(`已保存 ${entry.kind} 产物：server/.data/m0/${name}（${buffer.length} 字节，${contentType}）`);
}

async function main() {
  const config = loadConfig({ ...process.env, GEN_UPSTREAMS: 'real' });
  if (!config.providers.aiideApiKey) throw new Error('缺少 AIIDE_API_KEY（放 server/.env，不入库）');
  const logger = { info: (msg, meta) => console.log(msg, meta ?? ''), warn: (msg, meta) => console.warn('[warn]', msg, meta ?? ''),
    error: (msg, meta) => console.error('[error]', msg, meta ?? ''), child: () => logger };
  // API 调用（POST JSON / multipart）用原生 fetch；safeFetch 只用于结果下载（它是 GET 专用的受控下载器）。
  // 本机 DNS 偶发返回 ::ffff: 映射地址导致 undici ENOTFOUND：进程内 IPv4 优先（仅本脚本）。
  dns.setDefaultResultOrder('ipv4first');
  const fetchImpl = (url, init) => fetch(url, init);
  const downloadBytes = async (url) => {
    const response = await devSafeFetch(url, { maxBytes: 20 * 1024 * 1024 });
    const chunks = [];
    for await (const chunk of response.stream) chunks.push(chunk);
    return { buffer: Buffer.concat(chunks), contentType: response.contentType };
  };
  // M2-BE-03：改用驱动装配（与生产同路径；素材库过审由 aiide-ark 驱动内部处理）
  const channel = (kind, driver, modelMap, params = {}) => ({
    id: `pch_smoke${kind}0001`, kind, name: 'aiide-smoke', driver,
    base_url: config.providers.aiideBaseUrl, credential: config.providers.aiideApiKey,
    model_map: modelMap, params: { requestTimeoutMs: 180_000, ...params },
  });
  const videoProvider = arkDriver.create(
    channel('video', 'aiide-ark', { video: config.providers.videoModel },
      { generateAudio: config.providers.videoGenerateAudio }),
    { logger, deps: { fetchImpl } });
  const imageProvider = imagesDriver.create(
    channel('image', 'openai-images', { image: config.providers.imageModel },
      { resolution: config.providers.imageResolution, ratio: config.providers.imageRatio,
        quality: config.providers.imageQuality, maxReferences: config.providers.imageMaxReferences }),
    { logger, deps: { fetchImpl,
      loadReference: async (file) => ({ buffer: await readFile(path.resolve(file)) }),
      downloadImage: downloadBytes } });

  if (command === 'models') {
    const response = await fetchImpl(`${config.providers.aiideBaseUrl}/v1/models`,
      { headers: { Authorization: `Bearer ${config.providers.aiideApiKey}` } });
    const data = await response.json();
    const ids = (data.data ?? []).map((item) => item.id);
    console.log(`模型共 ${ids.length} 个；目标模型在售：视频 ${config.providers.videoModel}=${ids.includes(config.providers.videoModel)}、图片 ${config.providers.imageModel}=${ids.includes(config.providers.imageModel)}`);
    await mkdir(m0Dir, { recursive: true });
    await writeFile(path.join(m0Dir, 'aiide-catalog.json'), `${JSON.stringify({ at: new Date().toISOString(), ids }, null, 2)}\n`);
    console.log('目录快照已存 docs/m0/aiide-catalog.json');
    return;
  }

  if (command === 'material') {
    if (!options.reference) throw new Error('用法：material --reference <图片文件|URL>');
    const url = await toReferenceUrl(options.reference);
    const startedAt = Date.now();
    const assetRef = await materials.register(url, options.type === 'audio' ? 'audio' : options.type === 'video' ? 'video' : 'image');
    console.log(`素材过审完成：${assetRef}（${Date.now() - startedAt}ms）`);
    const { ledger, entry } = await reserve('material', config.providers.videoModel, { reference: path.basename(String(options.reference)) }, 0);
    await finish(ledger, entry, { status: 'succeeded', elapsedMs: Date.now() - startedAt, actualFen: 0 });
    return;
  }

  if (command === 'image') {
    const resolution = options.resolution ?? '1k';
    const ratio = options.ratio ?? '1:1';
    const prompt = options.prompt ?? '极简风格插画：一只有神的橘猫端坐，浅色背景';
    const { ledger, entry } = await reserve('image', config.providers.imageModel,
      { resolution, ratio, reference: options.reference ? path.basename(options.reference) : null }, IMAGE_ESTIMATE_FEN);
    const startedAt = Date.now();
    try {
      const result = await imageProvider.generate({ characterId: 'smoke', styleId: 'smoke', promptHint: prompt,
        description: '', referenceKeys: options.reference ? [options.reference] : [],
        sku: { resolution, ratio, ...(options.quality ? { quality: options.quality } : {}) } });
      if (result.status === 'succeeded') {
        await saveArtifact(ledger, entry, { buffer: result.buffer, contentType: result.contentType });
        await finish(ledger, entry, { elapsedMs: Date.now() - startedAt });
      } else {
        await finish(ledger, entry, { status: `${result.status}：${result.providerMessage ?? result.error ?? ''}`,
          providerMessage: result.providerMessage, elapsedMs: Date.now() - startedAt });
        console.log(`结果：${result.status}（${result.providerMessage ?? result.error ?? ''}）`);
      }
    } catch (error) {
      await finish(ledger, entry, { status: `failed：${String(error.message).slice(0, 200)}`,
        providerMessage: error.providerMessage, elapsedMs: Date.now() - startedAt });
      throw error;
    }
    return;
  }

  if (command === 'video' || command === 'video-query') {
    const resolution = options.resolution ?? '480p';
    const ratio = options.ratio ?? '9:16';
    let ledger;
    let entry;
    let upstreamId = command === 'video-query' ? argv[1] : null;
    let startedAt = Date.now();
    let prepared;
    if (!upstreamId) {
      const seconds = Number(options.seconds ?? 5);
      if (!Number.isInteger(seconds) || seconds <= 0) throw new Error('--seconds 必须是正整数');
      const estimatedFen = estimateVideoFen(resolution, ratio, seconds);
      ({ ledger, entry } = await reserve('video', config.providers.videoModel,
        { seconds, resolution, ratio, images: options.image?.length ?? 0, audios: options.audio?.length ?? 0,
          materials: options['no-materials'] ? false : true }, estimatedFen));
      const imageUrls = await Promise.all((options.image ?? []).map((value) => toReferenceUrl(value)));
      const audioUrls = await Promise.all((options.audio ?? []).map((value) => toReferenceUrl(value)));
      prepared = videoProvider.prepare({
        prompt: options.prompt ?? '夜晚的城市街头霓虹灯闪烁，行人渐少，镜头缓缓推近一家仍亮着灯的小书店，温馨安静。',
        durationSeconds: seconds, ratio, resolution,
        imageRefs: imageUrls, audioRefs: audioUrls,
      }, { durations: [seconds] });
    } else {
      ledger = await readLedger();
      // 收割 --no-wait 的任务：复用原提交的账本条目（找不到才建 0 元新条目）
      entry = ledger.entries.filter((item) => item.taskId === upstreamId).pop();
      if (!entry) {
        ({ ledger, entry } = await reserve('video-query', config.providers.videoModel, { upstreamId }, 0));
      }
    }
    try {
      let submitted = upstreamId ? { upstreamId } : null;
      if (!submitted) {
        submitted = await videoProvider.submit(prepared, { idempotencyKey: `smoke-${Date.now()}` });
        console.log(`提交成功 taskId=${submitted.upstreamId}${options['no-wait'] ? '（--no-wait，稍后 video-query 收割）' : ''}`);
        await finish(ledger, entry, { taskId: submitted.upstreamId });
        if (options['no-wait']) return;
      }
      const timeoutSeconds = Number(options.timeout ?? 2400);
      const deadline = Date.now() + timeoutSeconds * 1000;
      let state;
      for (;;) {
        state = await videoProvider.query(submitted.upstreamId);
        if (state.status !== 'running') break;
        if (Date.now() > deadline) {
          await finish(ledger, entry, { status: `timeout：轮询超过 ${timeoutSeconds} 秒，任务 ${submitted.upstreamId} 待人工对账（video-query 收割）` });
          console.log(`轮询超时：任务 ${submitted.upstreamId} 仍在渠道侧，未计失败未退款`);
          return;
        }
        await delay(10_000);
      }
      if (state.status === 'succeeded') {
        const tokens = Number(state.usage?.total_tokens);
        // 按 token 折算的费用只是口径估算（$9.63/M × 汇率），真实扣费以渠道后台为准
        const tokenFen = Number.isFinite(tokens) ? Math.ceil((tokens * USD_PER_MTOKEN / 1_000_000) * FX_CNY_PER_USD * 100) : null;
        console.log(`usage.total_tokens=${Number.isFinite(tokens) ? tokens : '未返回'}（按 token 折算 ≈ ${tokenFen ?? '-'} 分，用它校准 cost_fen）`);
        // 30 秒成片约 15MB 且在火山海外 TOS：跨境下行慢，下载超时放宽到 10 分钟
        await saveArtifact(ledger, entry, await download(state.outputs[0].url, 512 * 1024 * 1024, 600_000));
        await finish(ledger, entry, { elapsedMs: Date.now() - startedAt,
          ...(Number.isFinite(tokens) ? { usageTokens: tokens, tokenFen } : {}) });
      } else if (state.status === 'failed') {
        await finish(ledger, entry, { status: `failed：${state.providerMessage ?? state.error}`, elapsedMs: Date.now() - startedAt });
        console.log(`生成失败：${state.providerMessage ?? state.error}`);
      } else {
        await finish(ledger, entry, { status: `unknown：${state.providerMessage ?? ''}`, elapsedMs: Date.now() - startedAt });
      }
    } catch (error) {
      await finish(ledger, entry, { status: `failed：${String(error.message).slice(0, 200)}`,
        providerMessage: error.providerMessage, elapsedMs: Date.now() - startedAt });
      throw error;
    }
    return;
  }

  throw new Error(`未知子命令：${command}（可选 models / image / material / video / video-query）`);
}

main().then(() => process.exit(0), (error) => {
  console.error(`冒烟失败：${error.message}${error.providerMessage ? `（上游：${error.providerMessage}）` : ''}`);
  process.exit(1);
});
