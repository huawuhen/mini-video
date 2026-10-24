// openai-videos 驱动——OpenAI 风格异步视频任务协议（POST /v1/videos + GET /v1/videos/{id}）。
// M2-BE-03 由 M2-BE-01 的喵呜视频适配器平移（用户 2026-10-24 决定保留为备用渠道）。
// 协议（https://api.miaowuai.store/docs/openai-videos，2026-10-22 核对）：
//   提交 POST /v1/videos，body 只认 model/prompt/seconds/ratio/resolution/image_urls/video_urls/audio_urls
//   （未知字段一律 HTTP 400，严禁携带其他字段）；素材仅接受公网 http(s) URL 数组。
//   轮询 GET /v1/videos/{id}；完成态 url/video_url 可能是站内相对路径（补全后需 Bearer 拉取），
//   大多为第三方 CDN 公开签名直链。
// 错误口径与 aiide-ark 对齐（M2-BE-01 端到端复审口径）：上游**明确拒绝 4xx → 返回 { status:'failed' }**
//   （该段失败退回，不冻结——原喵呜适配器此处抛非 retryable 会被上层判 unknown 冻结，属历史遗留，平移时修正）；
//   连接失败/429 → retryable 抛出（明确未提交）；超时/5xx/受理后断连 → unknown（不重提，冻结待对账）。
import { ProviderError } from '../../contract.js';
import { createChannelHttp } from '../../transport.js';

const TERMINAL_SUCCESS = new Set(['completed', 'succeeded', 'success']);
const TERMINAL_FAILURE = new Set(['failed', 'failure', 'error', 'rejected', 'cancelled', 'canceled', 'expired']);

const short = (value) => (typeof value === 'string' ? value.slice(0, 200) : undefined);

export const DEFAULT_PARAMS = Object.freeze({
  model: 'seedance-2.5-deal',
  requestTimeoutMs: 180_000,
});

export default {
  id: 'openai-videos',
  kinds: ['video'],
  configSchema: {
    baseUrl: 'url',
    credential: 'secret',
    modelMap: 'models', // { "video": "seedance-2.5-deal" }
    params: { model: 'string（缺省 seedance-2.5-deal）', requestTimeoutMs: 'int（缺省 180000）' },
  },

  create(channel, { logger, deps = {} } = {}) {
    const params = { ...DEFAULT_PARAMS, ...(channel.params ?? {}) };
    const model = channel.modelMap?.video ?? params.model;
    const http = createChannelHttp({
      baseUrl: channel.baseUrl, credential: channel.credential,
      timeoutMs: params.requestTimeoutMs, fetchImpl: deps.fetchImpl,
    });
    const root = http.root;

    return {
      id: `openai-videos/${model}`,
      kind: 'video',

      capabilities() {
        return {
          model,
          durations: [5, 10, 15, 30],   // seedance 系 4~30 秒整数；产品 SKU 取 {5,10,15,30}
          resolutions: ['480p', '720p', '1080p'],
          ratios: ['16:9', '9:16', '1:1', '4:3', '3:4'],
          refImages: 30,
          refAudio: 10,
          withAudio: true,
        };
      },

      /** 组装请求体：只保留协议字段（未知字段上游 400）。 */
      prepare(input, sku = {}) {
        const prompt = String(input.prompt ?? '').trim();
        if (!prompt) throw new ProviderError('视频提示词不能为空。', { code: 'PROVIDER_INPUT_INVALID', submitted: false });
        const seconds = Number(input.durationSeconds);
        if (!Number.isInteger(seconds) || seconds <= 0) {
          throw new ProviderError('视频时长不合法。', { code: 'PROVIDER_INPUT_INVALID', submitted: false });
        }
        if (Array.isArray(sku.durations) && sku.durations.length && !sku.durations.includes(seconds)) {
          throw new ProviderError('片段时长不符合 SKU 允许值。', { code: 'PROVIDER_INPUT_INVALID', submitted: false });
        }
        const resolution = String(input.resolution ?? sku.resolution ?? '').toLowerCase();
        const ratio = String(input.ratio ?? '').trim();
        if (!resolution || !ratio) {
          throw new ProviderError('视频分辨率或画幅缺失。', { code: 'PROVIDER_INPUT_INVALID', submitted: false });
        }
        // 素材统一公网 http(s) URL 数组（上游按顺序引用）；产品侧提交的是签名链接
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

      /** 提交任务：成功返回 running + upstreamId；明确拒绝返回 failed；未提交可重试抛出；结果不确定按 unknown。 */
      async submit(prepared, { idempotencyKey } = {}) {
        void idempotencyKey; // 协议无幂等键头：重提防护靠 gen_tasks 状态守卫（产品层）
        const { status, ok, data, rawText } = await http.request('/v1/videos', { method: 'POST', body: prepared });
        if (status === 429) {
          throw new ProviderError('生成渠道请求过于频繁，请稍后重试。', {
            code: 'PROVIDER_RATE_LIMITED', submitted: false, retryable: true, status,
          });
        }
        if (status >= 300 && status < 400) {
          throw new ProviderError('生成渠道重定向结果不确定。', { code: 'SUBMISSION_UNKNOWN', submitted: true, status });
        }
        if (status >= 400 && status < 500 && status !== 408) {
          if ([401, 403].includes(status)) logger?.error?.('videos_auth_rejected', { status });
          return { status: 'failed', error: '视频生成请求被渠道拒绝，请稍后重试。', httpStatus: status,
            providerMessage: short(data?.error?.message ?? data?.message ?? rawText),
            providerCode: short(String(data?.error?.code ?? '')) };
        }
        if (!ok) throw new ProviderError('生成渠道受理结果不确定。', { code: 'SUBMISSION_UNKNOWN', submitted: true, status });
        const taskId = data?.id ?? data?.task_id ?? data?.data?.id;
        if (!taskId || typeof taskId !== 'string') {
          throw new ProviderError('生成渠道未返回任务编号。', { code: 'SUBMISSION_UNKNOWN', submitted: true });
        }
        return { status: 'running', upstreamId: String(taskId), raw: data };
      },

      /** 轮询：running（含排队）→ running；completed → succeeded + outputs；失败 → failed；网络失败抛可重试。 */
      async query(upstreamId) {
        let response;
        try {
          response = await http.request(`/v1/videos/${encodeURIComponent(upstreamId)}`);
        } catch (error) {
          // 任务已在渠道侧：任何查询失败都按可重试抛出，交 gen.poll 继续轮询，绝不因查询失败冻结
          throw new ProviderError('视频任务查询失败。', {
            code: 'PROVIDER_QUERY_FAILED', submitted: true, retryable: true, providerMessage: error?.providerMessage ?? error?.message,
          });
        }
        const { ok, status, data } = response;
        if (!ok || !data || typeof data !== 'object') {
          if ([404, 410].includes(status)) {
            return { status: 'failed', error: '视频任务不存在或已过期。', providerMessage: short(data) };
          }
          // 单次查询失败（网络/5xx）抛可重试异常，交 gen.poll 的队列退避继续轮询——
          // 任务已在渠道侧，绝不因一次查询失败就冻结
          throw new ProviderError('视频任务查询失败。', {
            code: 'PROVIDER_QUERY_FAILED', submitted: true, retryable: true, status, providerMessage: short(data),
          });
        }
        const taskStatus = String(data.status ?? data.task_status ?? '').toLowerCase();
        if (TERMINAL_FAILURE.has(taskStatus) || data.error) {
          return { status: 'failed', error: '视频生成失败，请稍后重试。', providerMessage: short(data.error?.message ?? data.error) };
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
  },
};
