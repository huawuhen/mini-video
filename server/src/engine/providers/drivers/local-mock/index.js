// local-mock 驱动（M2-WEB-01 零费用联调，TASKS/§3 2026-10-24）：进程内起一个仅绑定 127.0.0.1 的
// HTTP「模拟渠道」，提供 video（submit/query 异步）/ image / llm 三种能力，走标准驱动契约
// （Authorization 头、200/400/503 分类与真实渠道一致，因此共用契约测试套件原样可跑）。
// 产物：视频用 ffmpeg 生成与请求时长/分辨率一致的样片后经存储签名链接返回（gen.poll 的
// safeFetch 不允许回环地址，产物必须走存储）；图片生成 PNG buffer；LLM 返回固定合法的
// 剧本/扩写/镜头时间线 JSON（复用引擎契约示例，保证能通过 story 校验）。
// 故障注入（渠道 params）：delayMs、failRate（明确失败→演练 retry/退款）、unknownRate
// （结果未知→演练冻结/禁重试）。**devOnly：NODE_ENV=production 时 registry 拒绝注册、
// create 直接拒绝**（见 registry.js 与本文件 create 守卫），种子亦拒绝写入。
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProviderError } from '../../contract.js';

const DEFAULT_PARAMS = Object.freeze({
  delayMs: 800,        // 单次请求模拟耗时（图片/LLM 生成前等待；视频为提交受理耗时）
  failRate: 0,         // 0~1：明确失败概率（submit 阶段判定，演练 retry/退回）
  unknownRate: 0,      // 0~1：结果未知概率（submit 阶段判定，演练冻结/禁重试）
  minRunningMs: 4000,  // 视频提交后至少「排队」多久才出片（让前端能看到进行中状态）
  requestTimeoutMs: 60_000,
});

// ── 固定 LLM 输出（与引擎契约示例同源：能通过 parse/validate/normalize 的最小完整形态）──
const MOCK_PLAN = {
  title: '春天的野餐',
  synopsis: '妈妈带宝宝到公园野餐，宝宝发现风吹动树叶，两人分享食物并开心回家。',
  bible: {
    mood: 'warm, gentle, healing; soft golden light',
    characters: [
      { castIndex: 0, handle: 'the mother', brief: 'a woman in her thirties with long dark hair and a beige cardigan' },
      { castIndex: 1, handle: 'the girl', brief: 'a four-year-old girl with short black hair and a yellow dress' },
    ],
    scenes: [{ id: 's1', nameZh: '公园草地',
      description: 'a sunlit city-park lawn in late morning, soft shadows under old maple trees, calm breeze' }],
    props: [{ id: 'p1', nameZh: '野餐垫', description: 'a red and white checkered picnic blanket spread on the grass' }],
  },
  cast: [
    { name: '妈妈', description: '温柔耐心', gender: 'female', ageGroup: 'middle' },
    { name: '宝宝', description: '好奇活泼', gender: 'female', ageGroup: 'child' },
  ],
  segments: [
    { durationSeconds: 30, sceneId: 's1', propIds: ['p1'],
      endState: 'the girl stands on the blanket holding a fallen leaf up to the sun, the mother sits beside her smiling, medium-wide framing, soft golden light',
      plot: '公园里铺开野餐垫，宝宝追逐飘落的树叶。',
      cameraNotes: '广角建立场景后跟拍宝宝', dialogue: [{ castIndex: 0, line: '慢一点，看看树叶。' }],
      ambience: '风声和鸟鸣', transition: 'hard_cut', castIndexes: [0, 1] },
    { durationSeconds: 30, sceneId: 's1', propIds: ['p1'],
      endState: 'the two sit close together on the blanket sharing fruit, both smiling, medium shot, warm afternoon light',
      plot: '同一片草地上，两人分享水果并相视而笑。',
      cameraNotes: '从手部特写缓慢拉到双人中景', dialogue: [{ castIndex: 1, line: '这个苹果真甜！' }],
      ambience: '轻微风声', transition: 'prev_tail', castIndexes: [0, 1] },
  ],
};
const MOCK_TIMELINE = { // 4 镜头 × 30 秒；对白由引擎代码嵌入（镜头不必逐字携带），与项目测试夹具同构
  shots: [1, 2, 3, 4].map((i) => ({ start: (i - 1) * 7, end: i === 4 ? 30 : i * 7, size: 'Medium shot',
    transition: 'cut', action: `Shot ${i}: the characters continue naturally on the picnic lawn.`,
    dialogue: [], reaction: '', environment: 'Soft daylight.', camera: 'static' })),
  avoid: [],
};
const MOCK_EXPAND = { title: '公园的下午', script: '公园的下午，妈妈铺开野餐垫。宝宝追逐飘落的树叶，妈妈轻声提醒：「慢一点，看看树叶。」两人坐回垫子上分享水果，宝宝笑着说：「这个苹果真甜！」阳光正好，风把笑声吹得很远。' };

// ── 模拟渠道服务器（进程内单例，仅 127.0.0.1；unref 不阻塞进程退出）──
let serverState = null;

function roll(rate) { return rate > 0 && Math.random() < rate; }

function runFfmpeg(args) {
  return new Promise((resolve) => {
    const child = spawn('ffmpeg', ['-y', '-loglevel', 'error', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(0, 500); });
    child.on('error', () => resolve({ ok: false, stderr: 'ffmpeg 不可用' }));
    child.on('close', (code) => resolve({ ok: code === 0, stderr }));
  });
}

function videoSize(resolution, ratio) {
  const short = { '480p': 480, '720p': 720, '1080p': 1080 }[resolution] ?? 480;
  const [w, h] = String(ratio ?? '9:16').split(':').map(Number);
  if (!w || !h) return { width: short, height: Math.round(short * 16 / 9) };
  return w >= h ? { width: Math.round(short * w / h / 2) * 2, height: short }
    : { width: short, height: Math.round(short * h / w / 2) * 2 };
}

async function sampleVideoPath({ durationSeconds, resolution, ratio }) {
  const { width, height } = videoSize(resolution, ratio);
  const dir = join(tmpdir(), 'miv-local-mock');
  const file = join(dir, `sample-${width}x${height}-${durationSeconds}s.mp4`);
  if (existsSync(file)) return file;
  await mkdir(dir, { recursive: true });
  const result = await runFfmpeg([
    '-f', 'lavfi', '-i', `testsrc2=size=${width}x${height}:rate=24`,
    '-f', 'lavfi', '-i', 'sine=frequency=320:beep_factor=2',
    '-t', String(Math.max(1, Number(durationSeconds) || 5)),
    '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest', file,
  ]);
  if (!result.ok) throw new Error(`模拟样片生成失败：${result.stderr}`);
  return file;
}

const PALETTE = ['0xf6d365', '0x84fab0', '0xa1c4fd', '0xffd1ff', '0xfbc2eb'];
async function sampleImageBuffer({ seed }) {
  const index = createHash('sha1').update(String(seed ?? 'x')).digest()[0] % PALETTE.length;
  const dir = join(tmpdir(), 'miv-local-mock');
  await mkdir(dir, { recursive: true });
  const file = join(dir, `image-${index}.png`);
  if (!existsSync(file)) {
    const result = await runFfmpeg(['-f', 'lavfi',
      `-i`, `gradients=size=512x768:c0=${PALETTE[index]}:c1=0xffffff`,
      '-frames:v', '1', file]);
    if (!result.ok) throw new Error(`模拟图片生成失败：${result.stderr}`);
  }
  return readFile(file);
}

function llmAnswerFor(text) {
  if (text.includes('扩写')) return MOCK_EXPAND;
  if (text.includes('镜头时间线') || text.includes('"shots"')) return MOCK_TIMELINE;
  return MOCK_PLAN;
}

async function ensureServer() {
  if (serverState) return serverState;
  const tasks = new Map(); // 视频任务表：id → { readyAt }
  let seq = 0;
  const json = (res, status, body) => {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
    res.end(text);
  };
  const readBody = (req) => new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { resolve({}); } });
  });
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    void (async () => {
      try {
        if (req.method === 'GET' && url.pathname === '/v1/models') {
          return json(res, 200, { data: [{ id: 'local-mock/sample' }] });
        }
        if (req.method === 'POST' && url.pathname === '/v1/video/tasks') {
          const body = await readBody(req);
          const params = body.params ?? {};
          await new Promise((r) => setTimeout(r, Math.min(10_000, Number(params.delayMs) || 0)));
          if (roll(Number(params.failRate) || 0)) {
            return json(res, 400, { error: { message: '模拟：渠道拒绝了这次视频生成请求（local-mock failRate）' } });
          }
          if (roll(Number(params.unknownRate) || 0)) {
            return json(res, 503, { error: { message: '模拟：受理结果未知（local-mock unknownRate）' } });
          }
          seq += 1;
          const id = `mocktask_${Date.now().toString(36)}_${seq}`;
          tasks.set(id, { readyAt: Date.now() + Math.max(0, Number(params.minRunningMs) || 0),
            spec: { durationSeconds: body.durationSeconds, resolution: body.resolution, ratio: body.ratio } });
          return json(res, 200, { task_id: id });
        }
        const videoMatch = req.method === 'GET' && url.pathname.match(/^\/v1\/video\/tasks\/([^/]+)$/);
        if (videoMatch) {
          const task = tasks.get(videoMatch[1]);
          if (!task) return json(res, 404, { error: { message: '模拟：任务不存在或已过期（local-mock 重启后任务表清空）' } });
          if (Date.now() < task.readyAt) return json(res, 200, { status: 'running' });
          const file = await sampleVideoPath(task.spec);
          const buffer = await readFile(file);
          return json(res, 200, { status: 'succeeded',
            video_b64: buffer.toString('base64'),
            usage: { total_tokens: 1000 * (task.spec.durationSeconds ?? 5), completion_tokens: 1000 * (task.spec.durationSeconds ?? 5) } });
        }
        if (req.method === 'POST' && url.pathname === '/v1/images/generations') {
          const body = await readBody(req);
          const params = body.params ?? {};
          await new Promise((r) => setTimeout(r, Math.min(60_000, Number(params.delayMs) || 0)));
          if (roll(Number(params.failRate) || 0)) {
            return json(res, 400, { error: { message: '模拟：渠道拒绝了这次图片生成请求（local-mock failRate）' } });
          }
          if (roll(Number(params.unknownRate) || 0)) {
            return json(res, 503, { error: { message: '模拟：受理结果未知（local-mock unknownRate）' } });
          }
          const buffer = await sampleImageBuffer({ seed: body.characterId });
          return json(res, 200, { b64_png: buffer.toString('base64') });
        }
        if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
          const body = await readBody(req);
          const params = body.params ?? {};
          await new Promise((r) => setTimeout(r, Math.min(60_000, Number(params.delayMs) || 0)));
          if (roll(Number(params.failRate) || 0)) {
            return json(res, 500, { error: { message: '模拟：LLM 服务异常（local-mock failRate）' } });
          }
          const text = body.messages?.map((m) => String(m.content ?? '')).join('\n') ?? '';
          const answer = llmAnswerFor(`${body.system ?? ''}\n${text}`);
          return json(res, 200, { choices: [{ message: { content: JSON.stringify(answer) } }],
            usage: { prompt_tokens: 800, completion_tokens: 900 } });
        }
        return json(res, 404, { error: { message: '模拟：未知接口' } });
      } catch (error) {
        return json(res, 500, { error: { message: `模拟：样片生成失败（${String(error.message).slice(0, 120)}）` } });
      }
    })();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  server.unref();
  serverState = { port: server.address().port, server };
  return serverState;
}

const short = (value) => String(value ?? '').slice(0, 200);

export default {
  id: 'local-mock',
  kinds: ['video', 'image', 'llm'],
  devOnly: true, // registry 在 NODE_ENV=production 时拒绝注册（M2-WEB-01 联调专用）
  configSchema: {
    baseUrl: 'url（占位，驱动实际连接进程内 127.0.0.1 模拟服务，不使用该地址）',
    credential: 'secret（任意非空串）',
    modelMap: 'models（可缺省；模型名仅用于 Skill/价格审计显示）',
    params: {
      delayMs: 'int（单次请求模拟耗时，缺省 800）',
      failRate: 'float 0~1（明确失败概率，演练 retry/退回）',
      unknownRate: 'float 0~1（结果未知概率，演练冻结/禁重试）',
      minRunningMs: 'int（视频提交后最短排队时长，缺省 4000）',
      requestTimeoutMs: 'int（缺省 60000）',
    },
  },

  /**
   * @param ctx.deps { fetchImpl?（缺省全局 fetch；契约测试注入 scripted fetch）,
   *                   storage?（视频产物上传与签名链接；仅 video 需要）， logger? }
   */
  create(channel, { logger, deps = {} } = {}) {
    if (process.env.NODE_ENV === 'production') {
      throw new ProviderError('local-mock 驱动禁止在生产环境使用。', { code: 'PROVIDER_CONFIG_INVALID', submitted: false });
    }
    const params = { ...DEFAULT_PARAMS, ...(channel.params ?? {}) };
    const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
    const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

    async function call(path, { method = 'GET', body } = {}) {
      // 驱动实际连接进程内模拟服务；契约测试注入 scripted fetch（不真正发起网络）
      const { port } = await ensureServer();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), params.requestTimeoutMs);
      try {
        const response = await fetchImpl(`http://127.0.0.1:${port}${path}`, {
          method, signal: controller.signal,
          headers: { Authorization: `Bearer ${channel.credential}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const text = await response.text();
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch { data = null; }
        return { status: response.status, ok: response.ok, data, rawText: short(text) };
      } catch (error) {
        if (controller.signal.aborted) {
          throw new ProviderError('模拟渠道请求超时。', { code: 'SUBMISSION_UNKNOWN', submitted: method === 'POST' });
        }
        const code = error?.cause?.code ?? error?.code;
        if (['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'].includes(code)) {
          throw new ProviderError('无法连接模拟渠道。', { code: 'PROVIDER_NOT_SUBMITTED', submitted: false, retryable: true });
        }
        if (method === 'POST') {
          throw new ProviderError('模拟渠道请求失败，结果不确定。', { code: 'SUBMISSION_UNKNOWN', submitted: true });
        }
        // 查询类网络失败：任务仍在渠道侧，可安全重试（与 aiide-ark 的 PROVIDER_QUERY_FAILED 同口径）
        throw new ProviderError('模拟渠道查询失败。', { code: 'PROVIDER_QUERY_FAILED', submitted: true, retryable: true });
      } finally { clearTimeout(timer); }
    }

    const videoArtifactCache = new Map(); // upstreamId → 已上传的存储 key（每任务只上传一次）

    const kindImpl = {};

    if (channel.kind === 'video') {
      Object.assign(kindImpl, {
        id: 'local-mock/video',
        async prepare(input, sku = {}) {
          return { ...input, resolution: sku.resolution ?? input.resolution, ratio: input.ratio ?? '9:16' };
        },
        async submit(prepared) {
          const response = await call('/v1/video/tasks', { method: 'POST',
            body: { durationSeconds: prepared.durationSeconds, resolution: prepared.resolution,
              ratio: prepared.ratio, params } });
          if (response.status === 400) {
            return { status: 'failed', error: response.data?.error?.message ?? '模拟：视频生成请求被拒绝。' };
          }
          if (response.status === 503) return { status: 'unknown' };
          if (!response.ok || !response.data?.task_id) {
            throw new ProviderError('模拟渠道提交结果不确定。', { code: 'SUBMISSION_UNKNOWN', submitted: true });
          }
          return { status: 'running', upstreamId: response.data.task_id };
        },
        async query(upstreamId) {
          const response = await call(`/v1/video/tasks/${encodeURIComponent(upstreamId)}`);
          if (response.status === 404) {
            return { status: 'failed', error: response.data?.error?.message ?? '模拟：任务不存在。' };
          }
          if (response.status === 400) {
            return { status: 'failed', error: response.data?.error?.message ?? '模拟：视频生成失败。' };
          }
          if (!response.ok || !response.data) {
            throw new ProviderError('模拟渠道查询失败。', { code: 'PROVIDER_QUERY_FAILED', submitted: true, retryable: true });
          }
          if (response.data.status === 'running') return { status: 'running' };
          if (response.data.status === 'failed') {
            return { status: 'failed', error: response.data.error?.message ?? '模拟：视频生成失败。' };
          }
          if (response.data.status === 'succeeded') {
            const buffer = Buffer.from(response.data.video_b64 ?? '', 'base64');
            if (!buffer.length) return { status: 'unknown' }; // 成功状态拿不到产物：结果未知
            const storage = deps.storage;
            if (!storage?.put || typeof storage.signedUrl !== 'function') {
              throw new ProviderError('local-mock 视频渠道需要注入 storage（产物经存储签名链接返回）。',
                { code: 'PROVIDER_CONFIG_INVALID', submitted: false });
            }
            let key = videoArtifactCache.get(upstreamId);
            if (!key) {
              key = `mock/videos/${upstreamId}.mp4`;
              await storage.put(key, buffer, { contentType: 'video/mp4' });
              videoArtifactCache.set(upstreamId, key);
            }
            return { status: 'succeeded',
              outputs: [{ kind: 'video', url: await storage.signedUrl(key, { ttlSeconds: 6 * 3600 }) }],
              ...(response.data.usage ? { usage: response.data.usage } : {}) };
          }
          return { status: 'unknown' };
        },
        normalize: (raw) => raw,
        async catalog() {
          const response = await call('/v1/models');
          return { models: (response.data?.data ?? []).map((item) => ({ name: String(item.id ?? '') })) };
        },
      });
    }

    if (channel.kind === 'image') {
      Object.assign(kindImpl, {
        id: 'local-mock/image',
        async generate(input) {
          const response = await call('/v1/images/generations', { method: 'POST',
            body: { characterId: input.characterId, promptHint: input.promptHint, params } });
          if (response.status === 400) {
            return { status: 'failed', error: response.data?.error?.message ?? '模拟：图片生成请求被拒绝。' };
          }
          if (response.status === 503) return { status: 'unknown' };
          if (!response.ok || !response.data?.b64_png) {
            throw new ProviderError('模拟渠道生成结果不确定。', { code: 'SUBMISSION_UNKNOWN', submitted: true });
          }
          return { status: 'succeeded', buffer: Buffer.from(response.data.b64_png, 'base64'), contentType: 'image/png' };
        },
        async catalog() {
          const response = await call('/v1/models');
          return { models: (response.data?.data ?? []).map((item) => ({ name: String(item.id ?? '') })) };
        },
      });
    }

    if (channel.kind === 'llm') {
      Object.assign(kindImpl, {
        id: 'local-mock/llm',
        async complete({ system, messages, signal }) {
          if (signal?.aborted) {
            const error = new Error('LLM 调用已取消');
            error.name = 'AbortError';
            throw error;
          }
          const response = await call('/v1/chat/completions', { method: 'POST',
            body: { system, messages, params } });
          if (signal?.aborted) {
            const error = new Error('LLM 调用已取消');
            error.name = 'AbortError';
            throw error;
          }
          if (!response.ok) throw new Error(`LLM 渠道返回 ${response.status}`);
          const text = response.data?.choices?.[0]?.message?.content ?? '';
          if (!text) throw new Error('LLM 没有返回有效内容');
          return { text, usage: { inputTokens: response.data?.usage?.prompt_tokens ?? 0,
            outputTokens: response.data?.usage?.completion_tokens ?? 0 } };
        },
        async catalog() {
          const response = await call('/v1/models');
          return { models: (response.data?.data ?? []).map((item) => ({ name: String(item.id ?? '') })) };
        },
      });
    }

    const model = channel.modelMap?.[channel.kind] ?? 'local-mock/sample';
    return {
      ...kindImpl,
      kind: channel.kind,
      capabilities() {
        if (channel.kind === 'video') {
          return { model, resolutions: ['480p', '720p', '1080p'], durations: [5, 10, 15, 30],
            ratios: ['9:16', '16:9', '1:1'], withAudio: true, refImages: 9, refAudio: 10 };
        }
        if (channel.kind === 'image') {
          return { model, resolutions: ['1k'], ratios: ['1:1', '3:4', '9:16'], refImages: 1, withAudio: false };
        }
        return { model };
      },
    };
  },
};

export { MOCK_PLAN, MOCK_TIMELINE, MOCK_EXPAND }; // 供测试与文档引用
