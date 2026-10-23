// aiide 图片生成 provider——OpenAI Images 协议（M2-BE-01 渠道切换，替代喵呜）。
// 文档 https://aiide.apifox.cn/chinese/464722004e0（generations）与 464722005e0（edits），2026-10-23 核对：
//   无参考照片 POST /v1/images/generations  JSON { model, prompt, size, n, quality?, response_format: 'b64_json' }
//   有参考照片 POST /v1/images/edits        multipart { model, prompt, n, size, response_format, image(二进制，1~4 张) }
//   响应 { data: [{ b64_json | url, revised_prompt }], created }，同步返回（实测 OpenAI 系 20~60 秒）。
//   size 取值：1024x1024 / 1536x1024 / 1024x1536 / 2048x2048 / 2048x1152 / 3840x2160 / 2160x3840 / auto。
// 面向 BE-04 的 generate() 契约：成功 { status:'succeeded', buffer, contentType }；明确拒绝 { status:'failed' }；
//   结果不确定 { status:'unknown' }（同步生成超时/断连可能已计费，冻结待对账）；连接失败/429/参考照片读取失败
//   抛 retryable（发生在扣费生成之前，交队列重试，ENG-02 口径）。
// 参考照片是存储 key：经注入的 loadReference(key) 签名下载为字节后以文件上传（喵呜版本按 http(s) 过滤会把 key 静默丢弃，此处修正）。
// 参考照片数量缺省 1（用户 2026-10-17 决定；gpt-image-2 edits 支持 1~4，maxReferences 可配，多图未真实验证）。
import { sniffImage } from './image-bytes.js';
import { ProviderError } from './transport.js';

const SIZES = {
  '1k': { square: '1024x1024', portrait: '1024x1536', landscape: '1536x1024' },
  '2k': { square: '2048x2048', landscape: '2048x1152' },
  '4k': { landscape: '3840x2160', portrait: '2160x3840' },
};
const RESOLUTION_ALIASES = { '1080p': '1k', '1024': '1k', '1k': '1k', '2k': '2k', '2048': '2k', '4k': '4k', '2160p': '4k' };
const NOT_SUBMITTED_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT', 'UND_ERR_CONNECT_TIMEOUT']);

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

export function createAiideImageProvider({ baseUrl, apiKey, model = 'gpt-image-2', resolution = '1k', ratio = '1:1',
  quality = '', maxReferences = 1, loadReference, downloadImage, fetchImpl = globalThis.fetch,
  requestTimeoutMs = 180_000, logger, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  if (!baseUrl || !apiKey) throw new ProviderError('aiide 渠道地址或凭证未配置。', { code: 'PROVIDER_CONFIG_INVALID', submitted: false });
  const root = String(baseUrl).replace(/\/+$/, '');
  const referenceLimit = Math.max(0, Number(maxReferences) || 0);

  async function request(path, { body, form } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      const response = await fetchImpl(`${root}${path}`, {
        method: 'POST', signal: controller.signal,
        // multipart 由 fetch 自动带 boundary，不能手写 Content-Type
        headers: { Authorization: `Bearer ${apiKey}`, ...(form ? {} : { 'Content-Type': 'application/json' }) },
        body: form ?? JSON.stringify(body),
      });
      const text = await response.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = null; }
      return { status: response.status, ok: response.ok, data, rawText: short(text) };
    } catch (error) {
      if (controller.signal.aborted) throw new ProviderError('aiide 图片生成请求超时。', { code: 'SUBMISSION_UNKNOWN', submitted: true });
      const code = error?.cause?.code ?? error?.code;
      if (NOT_SUBMITTED_CODES.has(code)) {
        throw new ProviderError('无法连接 aiide 渠道。', { code: 'PROVIDER_NOT_SUBMITTED', submitted: false, retryable: true });
      }
      throw new ProviderError('aiide 渠道受理结果不确定。', { code: 'SUBMISSION_UNKNOWN', submitted: true, providerMessage: short(error?.message) });
    } finally { clearTimeout(timer); }
  }

  async function loadReferences(keys) {
    if (!keys.length) return [];
    if (typeof loadReference !== 'function') {
      throw new ProviderError('参考照片读取器未配置。', { code: 'PROVIDER_CONFIG_INVALID', submitted: false });
    }
    const files = [];
    for (const key of keys) {
      let loaded;
      try {
        loaded = await loadReference(key);
      } catch (error) {
        // 读存储/下载失败发生在请求上游之前：明确未提交，交队列重试（ENG-02 审查口径）
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

  return {
    id: `aiide-${model}`,
    /** generate()：参考照片签名下载 → generations/edits 同步生成 → b64 解码（或 url 下载）。sku 入参可覆盖分辨率/画幅/质量。 */
    async generate({ characterId, styleId, promptHint, description, referenceKeys, sku: skuOverride } = {}) {
      const effective = { resolution, ratio, quality, ...skuOverride };
      const prompt = [promptHint, description].filter(Boolean).join('\n').trim();
      if (!prompt) return { status: 'failed', error: '图片生成提示词不能为空。' };
      const size = effective.size ?? sizeFor(effective.resolution, effective.ratio);
      if (!size) {
        logger?.error?.('aiide_image_size_unsupported', { characterId, styleId, resolution: effective.resolution, ratio: effective.ratio });
        return { status: 'failed', error: '图片生成参数不符合要求。' };
      }
      const wanted = (referenceKeys ?? []).filter((key) => typeof key === 'string' && key.trim());
      const refs = wanted.slice(0, referenceLimit);
      const droppedReferences = wanted.length - refs.length;
      if (droppedReferences > 0) logger?.info?.('aiide_image_references_trimmed', { characterId, styleId, kept: refs.length, droppedReferences });

      let files;
      try {
        files = await loadReferences(refs);
      } catch (error) {
        if (error.retryable === true) throw error;
        logger?.error?.('image_provider_local_invalid', { code: error.code, message: error.message, detail: error.providerMessage });
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
          response = await request('/v1/images/edits', { form });
        } else {
          response = await request('/v1/images/generations', { body: {
            model, prompt, size, n: 1, response_format: 'b64_json',
            ...(effective.quality ? { quality: String(effective.quality) } : {}),
          } });
        }
      } catch (error) {
        if (error instanceof ProviderError && error.retryable === true) throw error; // 连接失败：明确未提交
        logger?.warn?.('aiide_image_submission_unknown', { characterId, styleId, code: error?.code, detail: error?.providerMessage });
        return { status: 'unknown' }; // 超时/断连：同步生成可能已计费，冻结待对账
      }

      const { status, ok, data, rawText } = response;
      if (status === 429) {
        throw new ProviderError('aiide 渠道请求过于频繁，请稍后重试。', { code: 'PROVIDER_RATE_LIMITED', submitted: false, retryable: true, status });
      }
      if ([401, 403].includes(status)) logger?.error?.('aiide_image_auth_rejected', { status });
      if (status >= 400 && status < 500 && status !== 408) return rejected(data, rawText, status);
      if (!ok) {
        logger?.warn?.('aiide_image_upstream_error', { characterId, styleId, status, detail: short(rawText) });
        return { status: 'unknown' };
      }
      if (data?.error) return rejected(data, rawText);

      const item = Array.isArray(data?.data) ? data.data[0] : null;
      const extra = droppedReferences > 0 ? { droppedReferences } : {};
      if (typeof item?.b64_json === 'string' && item.b64_json.length) {
        const buffer = Buffer.from(item.b64_json, 'base64');
        const sniffed = sniffImage(buffer);
        if (!sniffed && buffer.length < 64) {
          logger?.warn?.('aiide_image_result_invalid', { characterId, styleId, bytes: buffer.length });
          return { status: 'unknown' };
        }
        return { status: 'succeeded', buffer, contentType: sniffed?.contentType ?? 'image/png', ...extra };
      }
      if (isHttpUrl(item?.url)) {
        if (typeof downloadImage !== 'function') {
          logger?.error?.('aiide_image_download_missing', { characterId, styleId });
          return { status: 'unknown' };
        }
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            const downloaded = await downloadImage(item.url);
            if (Buffer.isBuffer(downloaded?.buffer)) {
              const sniffed = sniffImage(downloaded.buffer);
              return { status: 'succeeded', buffer: downloaded.buffer,
                contentType: sniffed?.contentType ?? downloaded.contentType ?? 'image/png', ...extra };
            }
          } catch (error) {
            logger?.warn?.('aiide_image_download_failed', { attempt: attempt + 1, message: error?.message });
          }
          if (attempt < 2) await sleep(1_500 * 2 ** attempt);
        }
        return { status: 'unknown' }; // 地址已知，下载重试不再触发付费生成
      }
      logger?.warn?.('aiide_image_result_missing', { characterId, styleId, detail: short(rawText) });
      return { status: 'unknown' };
    },
  };
}
