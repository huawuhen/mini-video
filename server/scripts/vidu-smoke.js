// vidu 真实渠道冒烟脚本（M3-ENG-01 渠道接入）。手动运行，不参与 npm test；真实调用须用户授权
// （CODEX_HANDOFF §4 第 11 条，2026-11-12：冒烟费用上限 10 元 ≈ 320 积分，达到即硬停）。
// 用法（cwd=server；VIDU_TOKEN 放环境变量，禁止写入任何入库文件）：
//   VIDU_TOKEN=<token> node scripts/vidu-smoke.js balance
//   VIDU_TOKEN=<token> node scripts/vidu-smoke.js video [--model viduq3-turbo] [--mode ref|text]
//       [--seconds 5] [--resolution 480p|720p|1080p] [--ratio 9:16] [--image <URL>] [--prompt <文本>]
//       [--no-wait] [--timeout <秒>]        # 分辨率用产品口径（480p 由驱动映射为 Vidu 540p）
//   VIDU_TOKEN=<token> node scripts/vidu-smoke.js query <taskId>
// 计费（定价页 2026-11-12 核对）：1 积分 = 0.03125 元（32 积分 = 1 元）；任务创建响应即返回
//   credits（预扣口径），失败不计费。账本 server/.data/vidu-cost-ledger.json（gitignore），
//   只记渠道/模型/参数/积分，不含密钥与上游临时链接。
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import viduDriver from '../src/engine/providers/drivers/vidu/index.js';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 每秒积分表（drivers/vidu/README.md 能力表，2026-11-12 定价页核对；仅用于预算估算，
// 实际以任务响应 credits 为准）
const CREDITS_PER_SECOND = {
  'viduq3-turbo': { ref: { '540p': 4, '720p': 10, '1080p': 13 }, text: { '540p': 7, '720p': 12, '1080p': 13 } },
  'viduq3': { ref: { '540p': 7, '720p': 12, '1080p': 15 }, text: {} },
  'viduq3-pro': { ref: {}, text: { '540p': 9, '720p': 20, '1080p': 24 } },
};
const FEN_PER_CREDIT = 3.125;
const STOP_LIMIT_CREDITS = 320; // 授权上限 10 元的积分口径

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const dataDir = path.join(repoRoot, 'server', '.data');
const ledgerPath = path.join(dataDir, 'vidu-cost-ledger.json');

// 官方文档示例参考图（公开可达；仅冒烟用，不进产品）
const DEFAULT_REF_IMAGE = 'https://prod-ss-images.s3.cn-northwest-1.amazonaws.com.cn/vidu-maas/template/reference2video-1.png';
const DEFAULT_PROMPT = [
  'A young woman in a light spring dress stands on a sunny city-park lawn, medium shot.',
  'She looks at the camera, smiles and says in Mandarin Chinese, gently: 「你好，欢迎来到剧优兔。」',
  'Then she waves at the camera. Lip sync. Natural daylight, stable camera.',
].join(' ');

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

// 注：api.vidu.cn 直连可达（2026-11-12 实测无 fake-IP 劫持），用默认 fetch 即可；
// 若日后本机代理恢复 fake-IP 劫持，参考 aiide-smoke.js 的 DoH 兜底写法。

async function readLedger() {
  try { return JSON.parse(await readFile(ledgerPath, 'utf8')); }
  catch { return { updatedAt: null, totalCredits: 0, entries: [] }; }
}
async function writeLedger(ledger) {
  ledger.updatedAt = new Date().toISOString();
  await mkdir(dataDir, { recursive: true });
  await writeFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
}
// 授权规则：调用前先按单价表估算并写入账本，累计达到停止线即拒绝执行（实际以 credits 回填）
async function reserve(model, mode, params, seconds) {
  const viduRes = params.resolution === '480p' ? '540p' : params.resolution; // 与驱动映射同款换算
  const rate = CREDITS_PER_SECOND[model]?.[mode]?.[viduRes];
  if (!rate) throw new Error(`单价表缺 ${model}/${mode}/${viduRes}，请先核对定价页更新脚本`);
  const estimated = rate * seconds;
  const ledger = await readLedger();
  if (ledger.totalCredits + estimated > STOP_LIMIT_CREDITS) {
    throw new Error(`账本累计 ${ledger.totalCredits} 积分 + 本次估算 ${estimated} 积分超过停止线 ${STOP_LIMIT_CREDITS} 积分（10 元），停止调用。`);
  }
  const entry = { at: new Date().toISOString(), channel: 'vidu', kind: 'video', model, mode,
    params, estimatedCredits: estimated, actualCredits: null, taskId: null, status: 'submitted' };
  ledger.entries.push(entry);
  ledger.totalCredits += estimated;
  await writeLedger(ledger);
  console.log(`账本：估算 +${estimated} 积分（≈${(estimated * FEN_PER_CREDIT / 100).toFixed(2)} 元，`
    + `累计 ${ledger.totalCredits} / 停止线 ${STOP_LIMIT_CREDITS} 积分）`);
  return { ledger, entry };
}
async function finish({ ledger, entry }, patch) {
  const delta = (patch.actualCredits ?? 0) - entry.estimatedCredits;
  ledger.totalCredits += delta;
  Object.assign(entry, patch);
  await writeLedger(ledger);
  console.log(`账本：实际 ${entry.actualCredits} 积分（校准 ${delta >= 0 ? '+' : ''}${delta}），`
    + `累计 ${ledger.totalCredits} 积分 ≈ ${(ledger.totalCredits * FEN_PER_CREDIT / 100).toFixed(2)} 元`);
}

function buildInstance({ model }) {
  const token = process.env.VIDU_TOKEN;
  if (!token) throw new Error('缺少 VIDU_TOKEN 环境变量（Vidu API Token；禁止写入任何文件）');
  return viduDriver.create(
    { id: 'pch_vidu_smoke', kind: 'video', name: 'vidu-smoke', driver: 'vidu',
      baseUrl: 'https://api.vidu.cn', credential: token, modelMap: { video: model }, params: {} },
    { logger: { warn: (event, fields) => console.warn(`[warn] ${event}`, fields ?? ''),
        error: (event, fields) => console.error(`[error] ${event}`, fields ?? '') },
      deps: {} },
  );
}

async function main() {
  if (!command || !['balance', 'video', 'query'].includes(command)) {
    console.error(`用法（分辨率用产品口径 480p|720p|1080p，480p 由驱动映射为 Vidu 540p）：
  VIDU_TOKEN=<token> node scripts/vidu-smoke.js balance
  VIDU_TOKEN=<token> node scripts/vidu-smoke.js video [--model viduq3-turbo] [--mode ref|text]
      [--seconds 5] [--resolution 540p] [--ratio 9:16] [--image <URL>] [--prompt <文本>]
      [--no-wait] [--timeout 900]
  VIDU_TOKEN=<token> node scripts/vidu-smoke.js query <taskId>`);
    process.exit(1);
  }
  const model = options.model ?? 'viduq3-turbo';
  const instance = buildInstance({ model });

  if (command === 'balance') {
    const catalog = await instance.catalog();
    console.log(`连通成功。模型配置：${catalog.models.map((m) => m.name).join(', ')}`);
    console.log(`余额：${catalog.balance.credits} 积分（≈${(catalog.balance.credits * FEN_PER_CREDIT / 100).toFixed(2)} 元），并发上限 ${catalog.balance.concurrency}`);
    return;
  }

  if (command === 'query') {
    const taskId = argv[1];
    if (!taskId) throw new Error('用法：node scripts/vidu-smoke.js query <taskId>');
    const result = await instance.query(taskId);
    console.log(JSON.stringify(result, (_k, v) => (v === undefined ? null : v), 2));
    return;
  }

  // video：提交（+可选轮询收割）
  const mode = options.mode === 'text' ? 'text' : 'ref';
  const seconds = Number(options.seconds ?? 5);
  const resolution = options.resolution ?? '540p';
  const ratio = options.ratio ?? '9:16';
  const budget = await reserve(model, mode, { resolution, ratio, seconds }, seconds);
  const prepared = instance.prepare({
    prompt: options.prompt ?? DEFAULT_PROMPT,
    imageRefs: mode === 'ref' ? [options.image ?? DEFAULT_REF_IMAGE] : [],
    audioRefs: [],
    durationSeconds: seconds, ratio, resolution,
  }, {});
  const submitted = await instance.submit(prepared, {});
  if (submitted.status !== 'running') {
    await finish(budget, { actualCredits: 0, status: `rejected:${submitted.error}` });
    throw new Error(`提交被拒绝：${submitted.error}${submitted.providerMessage ? `（${submitted.providerMessage}）` : ''}`);
  }
  console.log(`已提交：task ${submitted.upstreamId}，响应 credits=${submitted.raw?.credits ?? '未知'}`);
  await finish(budget, { actualCredits: Number(submitted.raw?.credits ?? budget.entry.estimatedCredits),
    taskId: submitted.upstreamId, status: 'queued' });
  if (options.no_wait) return;

  const timeoutMs = Number(options.timeout ?? 900) * 1000;
  const startedAt = Date.now();
  for (;;) {
    await delay(10_000);
    const result = await instance.query(submitted.upstreamId);
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    if (result.status === 'succeeded') {
      console.log(`[${elapsed}s] 成功：credits=${result.usage?.credits ?? '?'}，地址（临时，勿入库本）：${result.outputs[0].url}`);
      return;
    }
    if (result.status === 'failed') {
      console.error(`[${elapsed}s] 失败：${result.error}${result.providerCode ? `（${result.providerCode}）` : ''}`);
      process.exitCode = 2;
      return;
    }
    if (result.status === 'unknown') {
      console.error(`[${elapsed}s] 完成态未返回地址，人工核对渠道后台`);
      process.exitCode = 2;
      return;
    }
    console.log(`[${elapsed}s] ${result.status}…`);
    if (Date.now() - startedAt > timeoutMs) {
      console.error(`超过 ${timeoutMs / 1000} 秒未完成；稍后用 query ${submitted.upstreamId} 收割`);
      process.exitCode = 3;
      return;
    }
  }
}

main().catch((error) => { console.error(error.message ?? error); process.exit(1); });
