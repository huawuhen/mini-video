// openai-images 驱动——OpenAI Images 同步图片协议（generations / edits；aiide 网关的 gpt-image-2，
// M2-BE-03 由 M2-BE-01 的 aiide-image.js 平移）。
// 文档 https://aiide.apifox.cn/chinese/464722004e0（generations）与 464722005e0（edits），2026-10-23 核对：
//   无参考照片 POST /v1/images/generations  JSON { model, prompt, size, n, quality?, response_format: 'b64_json' }
//   有参考照片 POST /v1/images/edits        multipart { model, prompt, n, size, response_format, image(二进制，1~4 张) }
//   响应 { data: [{ b64_json | url, revised_prompt }], created }，同步返回（实测 20~60 秒）。
//   size 取值：1024x1024 / 1536x1024 / 1024x1536 / 2048x2048 / 2048x1152 / 3840x2160 / 2160x3840 / auto。
// 网关超时重试（Lead 2026-10-24 裁决②）：该同步接口在 Cloudflare 后面，网关约 100 秒掐断（HTTP 524/504）。
//   响应状态 524/504 时驱动内部自动重试，**最多 2 次**（仅限图片类、仅限网关超时）；
//   用户只按一次计费，重试成本平台承担，逐次记入尝试记录（返回 attempts，处理器写入 gen_tasks.result）。
// 参考照片是存储 key：经注入的 loadReference(key) 签名下载为字节后以文件上传；
//   参考照片数量缺省 1（用户 2026-10-17 决定；协议支持 1~4，maxReferences 可配）。
import { ProviderError } from '../../contract.js';
import { createChannelHttp } from '../../transport.js';
import { sniffImage } from '../../image-bytes.js';

const SIZES = {
  '1k': { square: '1024x1024', portrait: '1024x1536', landscape: '1536x1024' },
  '2k': { square: '2048x2048', landscape: '2048x1152' },
  '4k': { landscape: '3840x2160', portrait: '2160x3840' },
};
const RESOLUTION_ALIASES = { '1080p': '1k', '1024': '1k', '1k': '1k', '2k': '2k', '2048': '2k', '4k': '4k', '2160p': '4k' };
const GATEWAY_TIMEOUT_STATUSES = new Set([504, 524]);

const short = (value) => {
  if (value === undefined || value === null) return undefined;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.slice(0, 200);
};
const isHttpUrl = (value) => typeof value === 'string' && /^https?:\/\//i.test(value);

/** 分辨率档（1k/2k/4k，兼容 1080p 等别名）× 画幅 → OpenAI size；不支持的组合返回 null。 */
export function sizeFor(resolution, ratio = '1:1') {
  if (/^\d+x\d+$/i.test(String(resolution ?? ''))) return String(resolution).toLowerCase(); // 直接给 WxH
  const tier = RESOLUTION_ALIASES[String(resolution ?? '').toLowerCase()];
  if (!tier) return null;
  const [w, h] = String(ratio ?? '1:1').split(':').map(Number);
  const orientation = !w || !h || w === h ? 'square' : w > h ? 'landscape' : 'portrait';
  return SIZES[tier]?.[orientation] ?? null;
}

export const DEFAULT_PARAMS = Object.freeze({
  model: 'gpt-image-2',
  resolution: '1k',
  ratio: '1:1',
  quality: '',           // 缺省不传，由渠道按模型默认
  maxReferences: 1,
  requestTimeoutMs: 180_000,
  gatewayRetryMax: 2,    // 524/504 自动重试上限（Lead 裁决：≤2，硬上限 2）
});

export default {
  id: 'openai-images',
  kinds: ['image'],
  configSchema: {
    baseUrl: 'url',
    credential: 'secret',
    modelMap: 'models', // { "image": "gpt-image-2" }，优先于 params.model
    params: {
      model: 'string（缺省 gpt-image-2）',
      resolution: 'string（1k/2k/4k，缺省 1k）',
      ratio: 'string（缺省 1:1）',
      quality: 'string（low/medium/high，缺省不传）',
      maxReferences: 'int（参考照片上限，缺省 1，协议上限 4）',
      requestTimeoutMs: 'int（缺省 180000；同步生成实测 20~110 秒）',
      gatewayRetryMax: 'int（网关 524/504 自动重试上限，缺省 2，硬上限 2——用户只计费一次）',
    },
  },

  /** @param ctx.deps { fetchImpl, loadReference(key)→{buffer,contentType}, downloadImage(url)→{buffer,contentType}, sleep } */
  create(channel, { logger, deps = {} } = {}) {
    const params = { ...DEFAULT_PARAMS, ...(channel.params ?? {}) };
    const model = channel.modelMap?.image ?? params.model;
    const http = createChannelHttp({
      baseUrl: channel.baseUrl, credential: channel.credential,
      timeoutMs: params.requestTimeoutMs, fetchImpl: deps.fetchImpl,
    });
    const referenceLimit = Math.min(4, Math.max(0, Number(params.maxReferences) || 0));
    const gatewayRetryMax = Math.min(2, Math.max(0, Number(params.gatewayRetryMax) || 0));
    const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

    async function loadReferences(keys) {
      if (!keys.length) return [];
      if (typeof deps.loadReference !== 'function') {
        throw new ProviderError('参考照片读取器未配置。', { code: 'PROVIDER_CONFIG_INVALID', submitted: false });
      }
      const files = [];
      for (const key of keys) {
        let loaded;
        try {
          loaded = await deps.loadReference(key);
        } catch (error) {
          // 读存储/下载失败发生在请求上游之前：明确未提交，交队列重试（M1-ENG-02 审查口径）
          throw new ProviderError('参考照片暂时无法读取。', {
            code: 'PROVIDER_REFERENCE_UNAVAILABLE', submitted: false, retryable: true, providerMessage: short(error?.message),
          });
        }
        const sniffed = sniffImage(loaded?.buffer);
        if (!sniffed) {
          throw new ProviderError('参考照片不是可识别的图片文件。', { code: 'PROVIDER_INPUT_INVALID', submitted: false,
            providerMessage: short(loaded?.contentType ?? typeof loaded?.buffer) });
        }
        files.push({ buffer: loaded.buffer, contentType: sniffed.contentType, name: `ref${files.length + 1}.${sniffed.extension}` });
      }
      return files;
    }

    function rejected(data, rawText, status) {
      return { status: 'failed', error: '图片生成请求被渠道拒绝，请稍后重试。', ...(status ? { httpStatus: status } : {}),
        providerMessage: short(data?.error?.message ?? data?.message ?? data?.error ?? rawText),
        providerCode: short(String(data?.error?.code ?? data?.code ?? '')) };
    }

    /**
     * 发起同步生成请求；网关 524/504 时自动重试（≤ gatewayRetryMax 次，每次记录尝试）。
     * 连接类失败（retryable）在 http 层抛出、直接透传（发生在计费生成之前）。
     */
    async function generateRequest({ path, body, form }) {
      let attempts = 0;
      for (;;) {
        const response = await http.request(path, { method: 'POST', body, form });
        attempts += 1;
        if (GATEWAY_TIMEOUT_STATUSES.has(response.status) && attempts <= gatewayRetryMax) {
          logger?.warn?.('images_gateway_timeout_retry', { status: response.status, attempt: attempts,
            retryMax: gatewayRetryMax, note: '重试成本平台承担，用户只计费一次' });
          continue;
        }
        return { ...response, attempts };
      }
    }

    return {
      id: `openai-images/${model}`,
      kind: 'image',

      capabilities() {
        return {
          model,
          resolutions: ['1k', '2k', '4k'],
          ratios: ['1:1', '3:4', '4:3', '9:16', '16:9'],
          refImages: referenceLimit,
          withAudio: false,
        };
      },

      /** generate()：参考照片签名下载 → generations/edits 同步生成 → b64 解码（或 url 下载）。sku 入参可覆盖分辨率/画幅/质量。 */
      async generate({ characterId, styleId, promptHint, description, referenceKeys, sku: skuOverride } = {}) {
        const effective = { resolution: params.resolution, ratio: params.ratio, quality: params.quality, ...skuOverride };
        const prompt = [promptHint, description].filter(Boolean).join('\n').trim();
        if (!prompt) return { status: 'failed', error: '图片生成提示词不能为空。' };
        const size = effective.size ?? sizeFor(effective.resolution, effective.ratio);
        if (!size) {
          logger?.error?.('images_size_unsupported', { characterId, styleId, resolution: effective.resolution, ratio: effective.ratio });
          return { status: 'failed', error: '图片生成参数不符合要求。' };
        }
        const wanted = (referenceKeys ?? []).filter((key) => typeof key === 'string' && key.trim());
        const refs = wanted.slice(0, referenceLimit);
        const droppedReferences = wanted.length - refs.length;
        if (droppedReferences > 0) logger?.info?.('images_references_trimmed', { characterId, styleId, kept: refs.length, droppedReferences });

        let files;
        try {
          files = await loadReferences(refs);
        } catch (error) {
          if (error.retryable === true) throw error;
          logger?.error?.('image_provider_local_invalid', { errorCode: error.code, message: error.message, detail: error.providerMessage });
          return { status: 'failed', error: '图片生成参数不符合要求。', providerMessage: error.providerMessage };
        }

        let response;
        try {
          if (files.length) {
            const form = new FormData();
            form.set('model', model);
            form.set('prompt', prompt);
            form.set('n', '1');
            form.set('size', size);
            form.set('response_format', 'b64_json');
            if (effective.quality) form.set('quality', String(effective.quality));
            for (const file of files) form.append('image', new Blob([file.buffer], { type: file.contentType }), file.name);
            response = await generateRequest({ path: '/v1/images/edits', form });
          } else {
            response = await generateRequest({ path: '/v1/images/generations', body: {
              model, prompt, size, n: 1, response_format: 'b64_json',
              ...(effective.quality ? { quality: String(effective.quality) } : {}),
            } });
          }
        } catch (error) {
          if (error instanceof ProviderError && error.retryable === true) throw error; // 连接失败：明确未提交
          logger?.warn?.('images_submission_unknown', { characterId, styleId, errorCode: error?.code, detail: error?.providerMessage });
          return { status: 'unknown', attempts: error?.attempts ?? 1 }; // 超时/断连：同步生成可能已计费，冻结待对账
        }

        const { status, ok, data, rawText, attempts } = response;
        if (status === 429) {
          throw new ProviderError('生成渠道请求过于频繁，请稍后重试。', { code: 'PROVIDER_RATE_LIMITED', submitted: false, retryable: true, status });
        }
        if ([401, 403].includes(status)) logger?.error?.('images_auth_rejected', { status });
        if (status >= 400 && status < 500 && status !== 408) return { ...rejected(data, rawText, status), attempts };
        if (!ok) {
          // 含 524/504 重试耗尽：网关切断时上游可能已受理甚至已出图——按结果不确定冻结待对账
          logger?.warn?.('images_upstream_error', { characterId, styleId, status, attempts, detail: short(rawText) });
          return { status: 'unknown', attempts };
        }
        if (data?.error) return { ...rejected(data, rawText), attempts };

        const item = Array.isArray(data?.data) ? data.data[0] : null;
        const extra = { ...(droppedReferences > 0 ? { droppedReferences } : {}), attempts };
        if (typeof item?.b64_json === 'string' && item.b64_json.length) {
          const buffer = Buffer.from(item.b64_json, 'base64');
          const sniffed = sniffImage(buffer);
          if (!sniffed && buffer.length < 64) {
            logger?.warn?.('images_result_invalid', { characterId, styleId, bytes: buffer.length });
            return { status: 'unknown', attempts };
          }
          return { status: 'succeeded', buffer, contentType: sniffed?.contentType ?? 'image/png', ...extra };
        }
        if (isHttpUrl(item?.url)) {
          if (typeof deps.downloadImage !== 'function') {
            logger?.error?.('images_download_missing', { characterId, styleId });
            return { status: 'unknown', attempts };
          }
          for (let attempt = 0; attempt < 3; attempt += 1) {
            try {
              const downloaded = await deps.downloadImage(item.url);
              if (Buffer.isBuffer(downloaded?.buffer)) {
                const sniffed = sniffImage(downloaded.buffer);
                return { status: 'succeeded', buffer: downloaded.buffer,
                  contentType: sniffed?.contentType ?? downloaded.contentType ?? 'image/png', ...extra };
              }
            } catch (error) {
              logger?.warn?.('images_download_failed', { attempt: attempt + 1, message: error?.message });
            }
            if (attempt < 2) await sleep(1_500 * 2 ** attempt);
          }
          return { status: 'unknown', attempts }; // 地址已知，下载重试不再触发付费生成
        }
        logger?.warn?.('images_result_missing', { characterId, styleId, detail: short(rawText) });
        return { status: 'unknown', attempts };
      },

      /** 免费模型目录（channel:test 用）：GET /v1/models。 */
      async catalog() {
        const { ok, status, data } = await http.request('/v1/models');
        if (!ok || !Array.isArray(data?.data)) {
          throw new ProviderError(`模型目录不可用（HTTP ${status ?? 'ERR'}）。`, {
            code: 'PROVIDER_QUERY_FAILED', submitted: false,
          });
        }
        return { models: data.data.map((item) => ({ name: String(item.id ?? item.model ?? '') })).filter((m) => m.name) };
      },
    };
  },
};
