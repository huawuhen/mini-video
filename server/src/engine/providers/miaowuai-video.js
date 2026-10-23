// 喵呜（miaowuai）视频适配器——OpenAI 风格异步任务（M2-BE-01，替代 modelhub 渠道）。
// 协议（https://api.miaowuai.store/docs/openai-videos，2026-10-22 核对）：
//   提交 POST /v1/videos，body 只认 model/prompt/seconds/ratio/resolution/image_urls/video_urls/audio_urls
//   （未知字段一律 HTTP 400，严禁携带其他字段）；素材仅接受公网 http(s) URL 数组。
//   轮询 GET /v1/videos/{id}；完成态 url/video_url 可能是站内相对路径（补全后需 Bearer 拉取），
//   大多为第三方 CDN 公开签名直链。
// 错误分类与 modelhub 同口径：连接失败/429 → retryable 抛出（明确未提交）；
//   4xx 拒绝 → failed；超时/5xx/受理后断连 → unknown（不重提，冻结待对账）。
import { ProviderError } from './transport.js';

const TERMINAL_SUCCESS = new Set(['completed', 'succeeded', 'success']);
const TERMINAL_FAILURE = new Set(['failed', 'failure', 'error', 'rejected', 'cancelled', 'canceled', 'expired']);

const short = (value) => (typeof value === 'string' ? value.slice(0, 200) : undefined);

export function createMiaowuaiVideoAdapter({ baseUrl, apiKey, model = 'seedance-2.5-deal', fetchImpl = globalThis.fetch,
  timeoutMs = 180_000, logger } = {}) {
  if (!baseUrl || !apiKey) throw new ProviderError('喵呜渠道地址或凭证未配置。', { code: 'PROVIDER_CONFIG_INVALID', submitted: false });
  const root = String(baseUrl).replace(/\/+$/, '');

  async function request(path, { method = 'GET', body } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${root}${path}`, {
        method, signal: controller.signal,
        headers: { Authorization: `Bearer ${apiKey}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = null; }
      return { status: response.status, ok: response.ok, data, rawText: short(text) };
    } catch (error) {
      if (controller.signal.aborted) throw new ProviderError('喵呜渠道请求超时。', { code: 'SUBMISSION_UNKNOWN', submitted: true });
      const code = error?.cause?.code ?? error?.code;
      if (['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT', 'UND_ERR_CONNECT_TIMEOUT'].includes(code)) {
        throw new ProviderError('无法连接喵呜渠道。', { code: 'PROVIDER_NOT_SUBMITTED', submitted: false, retryable: true });
      }
      throw new ProviderError('喵呜渠道受理结果不确定。', { code: 'SUBMISSION_UNKNOWN', submitted: method === 'POST' });
    } finally { clearTimeout(timer); }
  }

  return {
    id: `miaowuai-${model}`,
    kind: 'video',
    /** 组装 OpenAI 风格请求体：只保留渠道文档字段（未知字段上游 400）。 */
    prepare(input, _sku = {}) {
      const prompt = String(input.prompt ?? '').trim();
      if (!prompt) throw new ProviderError('视频提示词不能为空。', { code: 'PROVIDER_INPUT_INVALID', submitted: false });
      const seconds = Number(input.durationSeconds);
      if (!Number.isInteger(seconds) || seconds <= 0) {
        throw new ProviderError('视频时长不合法。', { code: 'PROVIDER_INPUT_INVALID', submitted: false });
      }
      const resolution = String(input.resolution ?? '').toLowerCase();
      const ratio = String(input.ratio ?? '').trim();
      if (!resolution || !ratio) {
        throw new ProviderError('视频分辨率或画幅缺失。', { code: 'PROVIDER_INPUT_INVALID', submitted: false });
      }
      // 素材统一公网 http(s) URL 数组（上游按顺序引用）；product 侧提交的是签名链接
      const urlListOf = (keys) => (keys ?? []).filter((key) => typeof key === 'string' && /^https?:\/\//.test(key));
      const imageUrls = urlListOf(input.imageRefs);
      const videoUrls = urlListOf(input.videoRefs);
      const audioUrls = urlListOf(input.audioRefs);
      return {
        model,
        prompt,
        seconds,
        ratio,
        resolution,
        ...(imageUrls.length ? { image_urls: imageUrls } : {}),
        ...(videoUrls.length ? { video_urls: videoUrls } : {}),
        ...(audioUrls.length ? { audio_urls: audioUrls } : {}),
      };
    },

    /** 提交任务：成功返回 running + upstreamId；失败按是否已提交分类（绝不盲目重提）。 */
    async submit(prepared, { idempotencyKey } = {}) {
      void idempotencyKey; // 喵呜无幂等键头：重提交防护靠 gen_tasks 状态守卫（产品层）
      const { status, ok, data } = await request('/v1/videos', { method: 'POST', body: prepared });
      if (status === 429) throw new ProviderError('喵呜渠道请求过于频繁，请稍后重试。', {
        code: 'PROVIDER_RATE_LIMITED', submitted: false, retryable: true, status,
      });
      if (status >= 300 && status < 400) {
        throw new ProviderError('喵呜渠道重定向结果不确定。', { code: 'SUBMISSION_UNKNOWN', submitted: true, status });
      }
      if (status >= 400 && status < 500 && status !== 408) {
        const message = data?.error?.message ?? data?.message ?? null;
        if ([401, 403].includes(status)) {
          logger?.error?.('miaowuai_auth_rejected', { status });
        }
        throw new ProviderError('喵呜渠道明确拒绝了请求。', {
          code: 'PROVIDER_REJECTED', submitted: false, status,
          providerMessage: short(message ?? data), providerCode: short(String(data?.error?.code ?? '')),
        });
      }
      if (!ok) throw new ProviderError('喵呜渠道受理结果不确定。', { code: 'SUBMISSION_UNKNOWN', submitted: true, status });
      const taskId = data?.id ?? data?.task_id ?? data?.data?.id;
      if (!taskId || typeof taskId !== 'string') {
        throw new ProviderError('喵呜渠道未返回任务编号。', { code: 'SUBMISSION_UNKNOWN', submitted: true });
      }
      return { status: 'running', upstreamId: String(taskId), raw: data };
    },

    /** 轮询任务：running（含排队）→ {status:'running'}；completed → succeeded + outputs；
     * 失败/拒绝 → failed；无法判定 → unknown（冻结待对账）。 */
    async query(upstreamId) {
      const { ok, status, data } = await request(`/v1/videos/${encodeURIComponent(upstreamId)}`, { method: 'GET' });
      if (!ok || !data || typeof data !== 'object') {
        if ([404, 410].includes(status)) {
          return { status: 'failed', error: '喵呜视频任务不存在或已过期。', providerMessage: short(data) };
        }
        // 单次查询失败（网络/5xx）抛可重试异常，交 gen.poll 的队列退避继续轮询——
        // 任务已在渠道侧，绝不因一次查询失败就冻结
        throw new ProviderError('喵呜视频任务查询失败。', {
          code: 'PROVIDER_QUERY_FAILED', submitted: true, retryable: true, status,
          providerMessage: short(data),
        });
      }
      const taskStatus = String(data.status ?? data.task_status ?? '').toLowerCase();
      if (TERMINAL_FAILURE.has(taskStatus) || data.error) {
        return { status: 'failed', error: '喵呜视频生成失败。', providerMessage: short(data.error?.message ?? data.error) };
      }
      const videoUrl = data.video_url ?? data.url ?? data.result?.[0];
      if (TERMINAL_SUCCESS.has(taskStatus) && !videoUrl) {
        return { status: 'unknown', providerMessage: '完成态未返回结果地址' };
      }
      if (!videoUrl) return { status: 'running' };
      // 完成态：站内相对路径补全为绝对地址（下载层按 host 判断是否附 Bearer）
      const absolute = /^https?:\/\//i.test(String(videoUrl))
        ? String(videoUrl)
        : `${root}/${String(videoUrl).replace(/^\/+/, '')}`;
      return {
        status: 'succeeded',
        outputs: [{ kind: 'video', url: absolute }],
        ...(data.thumb_url ? { thumbUrl: String(data.thumb_url) } : {}),
      };
    },

    normalize(raw) { return raw; },
  };
}
