// 喵呜（miaowuai）图片生成 provider——OpenAI 风格异步任务（M2-BE-01）。
// 协议：POST /v1/images 提交（model/prompt/ratio/resolution/image_urls，未知字段一律 400），
// GET /v1/images/{id} 轮询，GET /v1/images/{id}/content 拉取结果（需 Bearer）。
// 面向 BE-04 的 generate() 契约：提交+轮询+下载一体，成功返回 { status:'succeeded', buffer, contentType }；
// 失败 { status:'failed', error }；结果不确定 { status:'unknown' }（金额冻结待对账，不自动重提）。
// sku 入参（resolution 等）可覆盖构造默认；prompt 由 promptHint/description 组装。
import { ProviderError } from './transport.js';

const TERMINAL_SUCCESS = new Set(['completed', 'succeeded', 'success']);
const TERMINAL_FAILURE = new Set(['failed', 'failure', 'error', 'rejected', 'cancelled', 'canceled', 'expired']);
const short = (value) => (typeof value === 'string' ? value.slice(0, 200) : undefined);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createMiaowuaiImageProvider({ baseUrl, apiKey, model = 'GPT-image-2', ratio = '1:1',
  resolution = '1080p', pollIntervalMs = 5_000, pollTimeoutMs = 600_000, fetchImpl = globalThis.fetch,
  requestTimeoutMs = 180_000, downloadImage, logger } = {}) {
  if (!baseUrl || !apiKey) throw new ProviderError('喵呜渠道地址或凭证未配置。', { code: 'PROVIDER_CONFIG_INVALID', submitted: false });
  if (typeof downloadImage !== 'function') throw new ProviderError('图片安全下载器未配置。', { code: 'PROVIDER_CONFIG_INVALID', submitted: false });
  const root = String(baseUrl).replace(/\/+$/, '');

  async function request(path, { method = 'GET', body } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
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
    /** generate()：提交 → 轮询 → 下载。sku 入参可覆盖默认分辨率/比例。 */
    async generate({ characterId, styleId, promptHint, description, referenceKeys, sku: skuOverride } = {}) {
      const effective = { ratio, resolution, ...skuOverride };
      const prompt = [promptHint, description].filter(Boolean).join('\n').trim();
      if (!prompt) return { status: 'failed', error: '图片生成提示词不能为空。' };
      const imageUrls = (referenceKeys ?? []).filter((key) => typeof key === 'string' && /^https?:\/\//.test(key));
      // 首次提交：任何失败都发生在扣费生成之前 → 明确分类（retryable 抛出交队列重试）
      let taskId;
      try {
        const { status, ok, data } = await request('/v1/images', { method: 'POST', body: {
          model,
          prompt,
          ratio: effective.ratio,
          resolution: effective.resolution,
          ...(imageUrls.length ? { image_urls: imageUrls } : {}),
        } });
        if (status === 429) throw new ProviderError('喵呜渠道请求过于频繁。', { code: 'PROVIDER_RATE_LIMITED', submitted: false, retryable: true });
        if ([401, 403].includes(status)) logger?.error?.('miaowuai_image_auth_rejected', { status });
        if (status >= 400 && status < 500 && status !== 408) {
          return { status: 'failed', error: '图片生成请求被渠道拒绝，请稍后重试。',
            ...(data ? { providerMessage: short(data.error?.message ?? data.message ?? data) } : {}) };
        }
        if (!ok) throw new ProviderError('喵呜渠道受理结果不确定。', { code: 'SUBMISSION_UNKNOWN', submitted: true, status });
        taskId = data?.id ?? data?.task_id ?? data?.data?.id;
        if (!taskId || typeof taskId !== 'string') {
          throw new ProviderError('喵呜渠道未返回任务编号。', { code: 'SUBMISSION_UNKNOWN', submitted: true });
        }
      } catch (error) {
        if (error instanceof ProviderError && error.retryable === true) throw error; // 明确未提交：交队列重试
        if (error instanceof ProviderError && error.submitted === false) {
          return { status: 'failed', error: '图片生成请求被渠道拒绝，请稍后重试。',
            ...(error.providerMessage ? { providerMessage: error.providerMessage } : {}) };
        }
        return { status: 'unknown' }; // 提交结果不确定：冻结待对账
      }

      // 轮询任务到终态（图片生成实测约 100 秒，上限 10 分钟）
      const deadline = Date.now() + pollTimeoutMs;
      let finalData = null;
      for (;;) {
        if (Date.now() > deadline) {
          logger?.error?.('miaowuai_image_poll_timeout', { characterId, styleId, taskId });
          return { status: 'unknown' }; // 超时：任务可能仍在渠道侧，冻结待对账
        }
        await sleep(pollIntervalMs);
        let data;
        try {
          const poll = await request(`/v1/images/${encodeURIComponent(taskId)}`, { method: 'GET' });
          if (!poll.ok || !poll.data || typeof poll.data !== 'object') {
            if ([404, 410].includes(poll.status)) {
              return { status: 'failed', error: '图片任务不存在或已过期。', providerMessage: short(poll.data) };
            }
            continue; // 单次轮询网络失败：继续轮询（任务已在渠道侧，不重提）
          }
          data = poll.data;
        } catch (error) {
          if (error instanceof ProviderError && error.retryable === true) continue; // 轮询网络抖动：继续
          return { status: 'unknown' };
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
          const downloaded = await downloadImage(finalData.contentUrl,
            finalData.needsAuth ? { Authorization: `Bearer ${apiKey}` } : undefined);
          if (Buffer.isBuffer(downloaded?.buffer)) {
            return { status: 'succeeded', buffer: downloaded.buffer,
              contentType: downloaded.contentType ?? 'image/png' };
          }
        } catch (error) {
          logger?.warn?.('miaowuai_image_download_failed', { attempt: attempt + 1, taskId, message: error?.message });
        }
        if (attempt < 2) await sleep(1_500 * 2 ** attempt);
      }
      logger?.warn?.('miaowuai_image_download_unknown', { taskId });
      return { status: 'unknown' }; // URL 已知，下载重试不再提交付费生成
    },
  };
}
