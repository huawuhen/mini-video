// 七牛真实桶联调脚本（M2-OPS-02）。手动运行，不参与 npm test；真实桶操作须用户授权
// （CODEX_HANDOFF §3 2026-10-21：桶 redith + CDN cdn.redith.cn，费用上限 20 元、
//   账本估算累计达 16 元停止并汇报；key 前缀 miv-test/，联调后清理全部测试对象；
//   AK/SK 只放本机 server/.env，禁止入库、禁止进日志与输出）。
// 清单（docs/TASKS.md M2-OPS-02）：表单上传（小对象）、分片上传 v2（>8MB 含失败 abort）、
//   签名下载链接（含中文与空格的 key、attname 是否生效、过期后 401）、删除（含对象不存在）。
// 用法（cwd=server）：
//   node --env-file=.env scripts/qiniu-smoke.js            # 全部清单，结束清理 miv-test/
//   node --env-file=.env scripts/qiniu-smoke.js --keep     # 结束后保留对象（排查用）
// 账本落 server/.data/qiniu-cost-ledger.json（.gitignore 已忽略；只记字节量与估算分值，无密钥）。
import { createHmac, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { createQiniuStorage } from '../src/engine/storage/qiniu.js';

// 费用按七牛华东公开牌价的保守上限估算：外网/CDN 流量 0.30 元/GB、写请求 0.01 元/万次、
// 存储按 1 分/GB·天。单次联调约几十 MB，估算结果为个位数「分」，远低于 16 元停止线。
const STOP_LIMIT_FEN = 1600; // 16 元 = 授权上限 20 元的 80%（用户指定达 16 元停止并汇报）
const TRAFFIC_FEN_PER_GB = 30;
const REQUEST_FEN_PER_10K = 1;
const PREFIX = 'miv-test/';
const GB = 1024 ** 3;

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const ledgerPath = path.join(repoRoot, 'server', '.data', 'qiniu-cost-ledger.json');
const keep = process.argv.includes('--keep');

const urlsafeBase64 = (value) => Buffer.from(value).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
const signQbox = (secret, input) => urlsafeBase64(createHmac('sha1', secret).update(input).digest());
const maskUrl = (url) => url.replace(/([?&])(e|token)=([^&]+)/g, '$1$2=***');
const fetchT = (url, options = {}) => fetch(url, { ...options, signal: AbortSignal.timeout(60_000) });

const results = [];
function record(step, ok, detail) {
  results.push({ step, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${step}${detail ? `\n   ${detail}` : ''}`);
}

async function readLedger() {
  try { return JSON.parse(await readFile(ledgerPath, 'utf8')); }
  catch { return { updatedAt: null, totalEstimatedFen: 0, entries: [] }; }
}
async function writeLedger(ledger) {
  ledger.updatedAt = new Date().toISOString();
  await mkdir(path.dirname(ledgerPath), { recursive: true });
  await writeFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
}
async function reserve(ledger, step, { bytes = 0, requests = 1 } = {}) {
  const estimatedFen = Math.max(1, Math.ceil((bytes / GB) * TRAFFIC_FEN_PER_GB + (requests / 10_000) * REQUEST_FEN_PER_10K));
  if (ledger.totalEstimatedFen + estimatedFen > STOP_LIMIT_FEN) {
    throw new Error(`账本累计估算 ${ledger.totalEstimatedFen} 分 + 本次 ${estimatedFen} 分超过停止线 ${STOP_LIMIT_FEN} 分（16 元），停止联调并汇报。`);
  }
  const entry = { at: new Date().toISOString(), step, bytes, requests, estimatedFen, status: 'running' };
  ledger.entries.push(entry);
  ledger.totalEstimatedFen += estimatedFen;
  await writeLedger(ledger);
  return entry;
}
async function finish(ledger, entry, patch) {
  Object.assign(entry, patch);
  await writeLedger(ledger);
}

// 官方区域查询（公开接口，无需签名）：https://developer.qiniu.com/kodo/1671/region-endpoint-fq
async function detectRegion({ accessKey, bucket }) {
  const response = await fetchT(`https://api.qiniu.com/v4/query?ak=${encodeURIComponent(accessKey)}&bucket=${encodeURIComponent(bucket)}`);
  if (!response.ok) throw new Error(`区域查询失败 HTTP ${response.status}`);
  const { hosts = [] } = await response.json();
  const host = hosts[0];
  if (!host) throw new Error('区域查询未返回 hosts');
  return {
    region: host.region,
    upDomain: host.up?.domains?.find((d) => d.includes('qiniup.com')) ?? host.up?.domains?.[0],
    rs: host.rs?.domains?.[0] ?? 'rs.qbox.me',
    rsf: host.rsf?.domains?.[0] ?? 'rsf.qbox.me',
  };
}

// 管理接口（QBox 旧版签名：path + query + '\n'；仅本脚本的对账/清理用，产品代码不依赖）
function createManagement({ accessKey, secretKey, bucket, rs, rsf }) {
  const auth = (signed) => `QBox ${accessKey}:${signQbox(secretKey, signed)}`;
  const entryUri = (key) => urlsafeBase64(`${bucket}:${key}`);
  async function stat(key) {
    const p = `/stat/${entryUri(key)}`;
    const response = await fetchT(`https://${rs}${p}`, { headers: { Authorization: auth(`${p}\n`) } });
    if (response.status === 612) return { exists: false };
    if (!response.ok) throw new Error(`stat 失败 HTTP ${response.status}`);
    const body = await response.json();
    return { exists: true, ...body };
  }
  async function listAll(prefix) {
    const items = [];
    let marker = '';
    for (;;) {
      const query = `bucket=${encodeURIComponent(bucket)}&limit=1000${prefix ? `&prefix=${encodeURIComponent(prefix)}` : ''}${marker ? `&marker=${marker}` : ''}`;
      const response = await fetchT(`https://${rsf}/list?${query}`, { headers: { Authorization: auth(`/list?${query}\n`) } });
      if (!response.ok) throw new Error(`list 失败 HTTP ${response.status}`);
      const body = await response.json();
      items.push(...(body.items ?? []));
      if (!body.marker) return items;
      marker = body.marker;
    }
  }
  return { stat, listAll };
}

const statusText = (response) => `HTTP ${response.status}${response.headers.get('content-disposition') ? ` content-disposition=${JSON.stringify(response.headers.get('content-disposition'))}` : ''}`;

async function main() {
  const config = loadConfig();
  const { accessKey, secretKey, bucket, domain } = config.storage.qiniu;
  if (!accessKey || !secretKey || !bucket || !domain) throw new Error('七牛配置不完整（QINIU_ACCESS_KEY / SECRET_KEY / BUCKET / DOMAIN）');
  const ledger = await readLedger();
  console.log(`授权：桶 ${bucket}，费用上限 20 元（停止线 16 元），账本已累计 ${ledger.totalEstimatedFen} 分；前缀 ${PREFIX}${keep ? '，结束后保留对象' : '，结束后清理'}`);

  // S0 区域与域名
  const regionInfo = await detectRegion({ accessKey, bucket });
  record('S0 区域查询', true, `region=${regionInfo.region}，up=${regionInfo.upDomain}，rs=${regionInfo.rs}，rsf=${regionInfo.rsf}（引擎按 up-<region>.qiniup.com 拼装，需与 up 域名同区域）`);
  const storage = createQiniuStorage({ accessKey, secretKey, bucket, domain, region: regionInfo.region });
  const mgmt = createManagement({ accessKey, secretKey, bucket, rs: regionInfo.rs, rsf: regionInfo.rsf });

  const keys = {
    small: `${PREFIX}form-small.txt`,
    cjk: `${PREFIX}中文 目录/文件 名 测试.txt`,
    big: `${PREFIX}multipart-10mib.bin`,
    abort: `${PREFIX}multipart-abort.bin`,
  };
  const smallBody = Buffer.from('你好，七牛！\nMini AI Video 联调小对象（M2-OPS-02）。\n'.repeat(40), 'utf8');
  const bigBody = randomBytes(10 * 1024 * 1024);

  try {
    // S1 表单上传（小对象，≤8MB 走表单上传）
    {
      const entry = await reserve(ledger, 'S1 表单上传', { bytes: smallBody.length });
      const startedAt = Date.now();
      const put = await storage.put(keys.small, smallBody, { contentType: 'text/plain; charset=utf-8' });
      const stat = await mgmt.stat(keys.small);
      const ok = put.key === keys.small && stat.exists && stat.fsize === smallBody.length
        && (stat.mimeType ?? '').startsWith('text/plain');
      await finish(ledger, entry, { status: ok ? 'succeeded' : `mimeType=${stat.mimeType}`, elapsedMs: Date.now() - startedAt });
      record('S1 表单上传（小对象）', ok, `size=${stat.fsize}，mimeType=${stat.mimeType}`);
    }

    // S2 签名下载（ASCII key）
    {
      const entry = await reserve(ledger, 'S2 签名下载', { bytes: smallBody.length });
      const url = storage.signedUrl(keys.small, { ttlSeconds: 600 });
      const response = await fetchT(url);
      const body = Buffer.from(await response.arrayBuffer());
      const ok = response.status === 200 && body.equals(smallBody);
      await finish(ledger, entry, { status: ok ? 'succeeded' : statusText(response) });
      record('S2 签名下载（ASCII key 内容一致）', ok, `status=${response.status}，bytes=${body.length}，url=${maskUrl(url)}`);
    }

    // S3 中文 + 空格 key：上传 + attname 签名下载（M1-ENG-03 留下的真实桶验证项）
    {
      const entry = await reserve(ledger, 'S3 中文空格key', { bytes: smallBody.length });
      const startedAt = Date.now();
      await storage.put(keys.cjk, smallBody, { contentType: 'text/plain; charset=utf-8' });
      const url = storage.signedUrl(keys.cjk, { ttlSeconds: 600, download: true });
      const response = await fetchT(url);
      const body = Buffer.from(await response.arrayBuffer());
      const disposition = response.headers.get('content-disposition') ?? '';
      const filename = keys.cjk.split('/').at(-1);
      const hasAttachment = /attachment/i.test(disposition);
      const hasName = disposition.includes(encodeURIComponent(filename)) || disposition.includes(filename);
      const ok = response.status === 200 && body.equals(smallBody) && hasAttachment && hasName;
      await finish(ledger, entry, { status: ok ? 'succeeded' : statusText(response), elapsedMs: Date.now() - startedAt });
      record('S3 中文/空格 key 上传与下载、attname 生效', ok,
        `status=${response.status}，bytes=${body.length}，attname=${hasAttachment && hasName ? '生效' : `未按预期：${disposition || '(无响应头)'}`}`);
    }

    // S4 分片上传 v2（10MiB → 3 个 4MB 分片）
    {
      const entry = await reserve(ledger, 'S4 分片上传', { bytes: bigBody.length });
      const startedAt = Date.now();
      const put = await storage.put(keys.big, bigBody, { contentType: 'application/octet-stream' });
      const stat = await mgmt.stat(keys.big);
      const head = await fetchT(storage.signedUrl(keys.big, { ttlSeconds: 600 }), { headers: { Range: 'bytes=0-1023' } });
      const prefixChunk = Buffer.from(await head.arrayBuffer());
      const total = Number((head.headers.get('content-range') ?? '').split('/')[1]);
      const ok = put.size === bigBody.length && stat.fsize === bigBody.length
        && prefixChunk.equals(bigBody.subarray(0, 1024)) && total === bigBody.length;
      await finish(ledger, entry, { status: ok ? 'succeeded' : `fsize=${stat.fsize}`, elapsedMs: Date.now() - startedAt });
      record('S4 分片上传 v2（10MiB，含范围读校验）', ok, `fsize=${stat.fsize}，range total=${total}`);
    }

    // S5 分片失败 → abort：注入第 2 片 500，断言抛错、DELETE abort 被调用、对象不存在
    {
      const entry = await reserve(ledger, 'S5 abort', { bytes: 4 * 1024 * 1024 });
      const calls = [];
      const failing = createQiniuStorage({ accessKey, secretKey, bucket, domain, region: regionInfo.region }, {
        fetchImpl: async (url, options = {}) => {
          calls.push(`${options.method ?? 'GET'} ${new URL(url).pathname.split('/uploads')[0]}…/${new URL(url).pathname.split('/').at(-1)}`);
          if ((options.method ?? '') === 'PUT' && url.endsWith('/2')) {
            return new Response('injected failure', { status: 500 });
          }
          return fetchT(url, options);
        },
      });
      let threw = null;
      try { await failing.put(keys.abort, bigBody, { contentType: 'application/octet-stream' }); }
      catch (error) { threw = error; }
      const stat = await mgmt.stat(keys.abort);
      const abortCalled = calls.some((line) => line.startsWith('DELETE'));
      const ok = threw instanceof Error && /第 2 片上传/.test(threw.message) && abortCalled && !stat.exists;
      await finish(ledger, entry, { status: ok ? 'succeeded（已 abort）' : `threw=${threw?.message}` });
      record('S5 分片失败 abort（对象不落桶）', ok,
        `抛错=${threw ? threw.message.slice(0, 60) : '未抛出'}，abort DELETE=${abortCalled ? '已调用' : '未调用'}，stat exists=${stat.exists}`);
    }

    // S6 过期签名 → 401
    {
      const entry = await reserve(ledger, 'S6 过期401', { requests: 1 });
      const expired = storage.signedUrl(keys.small, { ttlSeconds: 1 });
      await new Promise((resolve) => setTimeout(resolve, 2500));
      const response = await fetchT(expired);
      // 七牛文档口径：凭证非法/过期典型返回 401；开启 CDN 回源鉴权的域名边缘也可能以 403 拒绝，两者都算「过期被拒」
      const ok = [401, 403].includes(response.status);
      await finish(ledger, entry, { status: ok ? 'succeeded' : statusText(response) });
      record('S6 过期签名链接被拒', ok, `status=${response.status}（期望 401/403）`);
    }

    // S7 无 token 访问 → 拒绝（确认桶为私有）
    {
      const entry = await reserve(ledger, 'S7 私有桶', { requests: 1 });
      const base = `${domain.startsWith('http') ? domain.replace(/\/$/, '') : `https://${domain}`}/${keys.small.split('/').map(encodeURIComponent).join('/')}`;
      const response = await fetchT(base);
      const ok = [401, 403].includes(response.status);
      await finish(ledger, entry, { status: ok ? 'succeeded' : statusText(response) });
      record('S7 无 token 直链被拒（私有桶）', ok, `status=${response.status}（期望 401/403）`);
    }

    // S8 删除：存在 → 不存在（612 视为已删）；不存在的 key 删除不报错
    {
      const entry = await reserve(ledger, 'S8 删除', { requests: 3 });
      await storage.remove([keys.cjk]);
      const after = await mgmt.stat(keys.cjk);
      let missingOk = true;
      try { await storage.remove([`${PREFIX}never-existed.txt`]); }
      catch (error) { missingOk = false; console.log(`   删除不存在对象报错：${error.message.slice(0, 80)}`); }
      const ok = !after.exists && missingOk;
      await finish(ledger, entry, { status: ok ? 'succeeded' : `exists=${after.exists}` });
      record('S8 删除（存在与不存在）', ok, `删除后 exists=${after.exists}，612 不报错=${missingOk}`);
    }
  } finally {
    // S9 清理：按前缀列出并全部删除（--keep 跳过）
    if (!keep) {
      try {
        const leftovers = await mgmt.listAll(PREFIX);
        for (let i = 0; i < leftovers.length; i += 10) {
          await storage.remove(leftovers.slice(i, i + 10).map((item) => item.key));
        }
        const rest = await mgmt.listAll(PREFIX);
        record('S9 清理 miv-test/', rest.length === 0, `删除 ${leftovers.length} 个对象，剩余 ${rest.length}${leftovers.length ? `（${leftovers.map((item) => item.key).join('、')}）` : ''}`);
      } catch (error) {
        record('S9 清理 miv-test/', false, error.message.slice(0, 120));
      }
    }
  }

  const failed = results.filter((item) => !item.ok);
  console.log(`\n结论：${results.length - failed.length}/${results.length} 项通过；账本累计估算 ${ledger.totalEstimatedFen} 分（上限 1600 分）`);
  if (failed.length) {
    console.log('未通过：' + failed.map((item) => item.step).join('、'));
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`联调中止：${error.message}`);
  process.exitCode = 1;
});
