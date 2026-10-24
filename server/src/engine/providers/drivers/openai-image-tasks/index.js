// openai-image-tasks 驱动——OpenAI 风格异步图片任务协议（POST /v1/images + GET /v1/images/{id}
// + GET /v1/images/{id}/content）。M2-BE-03 由 M2-BE-01 的喵呜图片适配器平移（备用渠道，用户 2026-10-24 决定保留）。
// 协议：提交 body 只认 model/prompt/ratio/resolution/image_urls（未知字段一律 400）；素材仅公网 http(s) URL。
// generate() 提交+轮询+下载一体：成功 { status:'succeeded', buffer, contentType }；明确拒绝 { status:'failed' }；
// 结果不确定 { status:'unknown' }（冻结待对账，不自动重提）；连接失败/429 → retryable 抛出（计费生成之前）。
// sku 入参（resolution 等）可覆盖构造默认；prompt 由 promptHint/description 组装。
import { ProviderError } from '../../contract.js';
import { createChannelHttp } from '../../transport.js';

const TERMINAL_SUCCESS = new Set(['completed', 'succeeded', 'success']);
const TERMINAL_FAILURE = new Set(['failed', 'failure', 'error', 'rejected', 'cancelled', 'canceled', 'expired']);
const short = (value) => (typeof value === 'string' ? value.slice(0, 200) : undefined);

export const DEFAULT_PARAMS = Object.freeze({
  model: 'GPT-image-2',
  ratio: '1:1',
  resolution: '1080p',
  pollIntervalMs: 5_000,
  pollTimeoutMs: 600_000,   // 图片生成实测约 100 秒，上限 10 分钟
  requestTimeoutMs: 180_000,
});

export default {
  id: 'openai-image-tasks',
  kinds: ['image'],
  configSchema: {
    baseUrl: 'url',
    credential: 'secret',
    modelMap: 'models', // { "image": "GPT-image-2" }
    params: {
      model: 'string（缺省 GPT-image-2）',
      ratio: 'string（缺省 1:1）',
      resolution: 'string（缺省 1080p）',
      pollIntervalMs: 'int（缺省 5000）',
      pollTimeoutMs: 'int（任务等待上限，缺省 600000）',
      requestTimeoutMs: 'int（缺省 180000）',
    },
  },

  /** @param ctx.deps { fetchImpl, downloadImage(url, headers?)→{buffer,contentType}, sleep } */
  create(channel, { logger, deps = {} } = {}) {
    const params = { ...DEFAULT_PARAMS, ...(channel.params ?? {}) };
    const model = channel.modelMap?.image ?? params.model;
    const http = createChannelHttp({
      baseUrl: channel.baseUrl, credential: channel.credential,
      timeoutMs: params.requestTimeoutMs, fetchImpl: deps.fetchImpl,
    });
    const root = http.root;
    const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    if (typeof deps.downloadImage !== 'function') {
      throw new ProviderError('图片安全下载器未配置。', { code: 'PROVIDER_CONFIG_INVALID', submitted: false });
    }

    return {
      id: `openai-image-tasks/${model}`,
      kind: 'image',

      capabilities() {
        return {
          model,
          resolutions: ['1080p', '2k', '4k'],
          ratios: ['1:1', '3:4', '4:3', '9:16', '16:9'],
          refImages: 1,          // 提交字段 image_urls 支持多图；产品缺省 1（用户 2026-10-17 决定）
          withAudio: false,
        };
      },

      /** generate()：提交 → 轮询 → 下载。sku 入参可覆盖默认分辨率/比例。 */
      async generate({ characterId, styleId, promptHint, description, referenceKeys, sku: skuOverride } = {}) {
        const effective = { ratio: params.ratio, resolution: params.resolution, ...skuOverride };
        const prompt = [promptHint, description].filter(Boolean).join('\n').trim();
        if (!prompt) return { status: 'failed', error: '图片生成提示词不能为空。' };
        const imageUrls = (referenceKeys ?? []).filter((key) => typeof key === 'string' && /^https?:\/\//.test(key));
        // 首次提交：任何失败都发生在计费生成之前 → 明确分类（retryable 抛出交队列重试）
        let taskId;
        try {
          const { status, ok, data, rawText } = await http.request('/v1/images', { method: 'POST', body: {
            model,
            prompt,
            ratio: effective.ratio,
            resolution: effective.resolution,
            ...(imageUrls.length ? { image_urls: imageUrls } : {}),
          } });
          if (status === 429) throw new ProviderError('生成渠道请求过于频繁，请稍后重试。', { code: 'PROVIDER_RATE_LIMITED', submitted: false, retryable: true });
          if ([401, 403].includes(status)) logger?.error?.('image_tasks_auth_rejected', { status });
          if (status >= 400 && status < 500 && status !== 408) {
            return { status: 'failed', error: '图片生成请求被渠道拒绝，请稍后重试。',
              ...(data ? { providerMessage: short(data.error?.message ?? data.message ?? data) } : { providerMessage: short(rawText) }) };
          }
          if (!ok) throw new ProviderError('生成渠道受理结果不确定。', { code: 'SUBMISSION_UNKNOWN', submitted: true, status });
          taskId = data?.id ?? data?.task_id ?? data?.data?.id;
          if (!taskId || typeof taskId !== 'string') {
            throw new ProviderError('生成渠道未返回任务编号。', { code: 'SUBMISSION_UNKNOWN', submitted: true });
          }
        } catch (error) {
          if (error instanceof ProviderError && error.retryable === true) throw error; // 明确未提交：交队列重试
          if (error instanceof ProviderError && error.submitted === false) {
            return { status: 'failed', error: '图片生成请求被渠道拒绝，请稍后重试。',
              ...(error.providerMessage ? { providerMessage: error.providerMessage } : {}) };
          }
          return { status: 'unknown' }; // 提交结果不确定：冻结待对账
        }

        // 轮询任务到终态
        const deadline = Date.now() + params.pollTimeoutMs;
        let finalData = null;
        for (;;) {
          if (Date.now() > deadline) {
            logger?.error?.('image_tasks_poll_timeout', { characterId, styleId, taskId });
            return { status: 'unknown' }; // 超时：任务可能仍在渠道侧，冻结待对账
          }
          await sleep(params.pollIntervalMs);
          let data;
          try {
            const poll = await http.request(`/v1/images/${encodeURIComponent(taskId)}`);
            if (!poll.ok || !poll.data || typeof poll.data !== 'object') {
              if ([404, 410].includes(poll.status)) {
                return { status: 'failed', error: '图片任务不存在或已过期。', providerMessage: short(poll.data) };
              }
              continue; // 单次轮询网络失败：继续轮询（任务已在渠道侧，不重提）
            }
            data = poll.data;
          } catch (error) {
            // 轮询阶段的任何网络异常（连接失败/超时/断连）都只是抖动：任务已在渠道侧，
            // 继续轮询直到等待上限，绝不因单次查询失败判 unknown 冻结
            void error;
            continue;
          }
          const taskStatus = String(data.status ?? data.task_status ?? '').toLowerCase();
          if (TERMINAL_FAILURE.has(taskStatus) || data.error) {
            return { status: 'failed', error: '图片生成失败，请修改内容后重试。',
              providerMessage: short(data.error?.message ?? data.error) };
          }
          const contentUrl = data.url ?? data.image_url ?? data.result?.[0];
          if (TERMINAL_SUCCESS.has(taskStatus) || contentUrl) {
            finalData = { contentUrl: /^https?:\/\//i.test(String(contentUrl))
              ? String(contentUrl)
              : `${root}/${String(contentUrl ?? `/v1/images/${encodeURIComponent(taskId)}/content`).replace(/^\/+/, '')}`,
            needsAuth: !/^https?:\/\//i.test(String(contentUrl)) };
            break;
          }
        }

        // 下载结果：站内 content 入口需要 Bearer；第三方签名直链不带鉴权头
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            const downloaded = await deps.downloadImage(finalData.contentUrl,
              finalData.needsAuth ? { Authorization: `Bearer ${channel.credential}` } : undefined);
            if (Buffer.isBuffer(downloaded?.buffer)) {
              return { status: 'succeeded', buffer: downloaded.buffer,
                contentType: downloaded.contentType ?? 'image/png' };
            }
          } catch (error) {
            logger?.warn?.('image_tasks_download_failed', { attempt: attempt + 1, taskId, message: error?.message });
          }
          if (attempt < 2) await sleep(1_500 * 2 ** attempt);
        }
        logger?.warn?.('image_tasks_download_unknown', { taskId });
        return { status: 'unknown' }; // URL 已知，下载重试不再提交付费生成
      },
    };
  },
};
