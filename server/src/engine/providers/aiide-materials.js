// aiide 素材库客户端（视频参考素材过审，M2-BE-01 渠道切换）。
// 文档 https://aiide.apifox.cn/chinese/492968369e0 与 492968371e0（2026-10-23 核对）：
//   POST /v1/assets/upload { url, type: image|video|audio, purpose } → { success, data: { asset_id, status, failure_reason? } }
//   GET  /v1/assets/{asset_id}                                       → 同形态；status: pending | ready | failed
//   视频生成请求里以 `asset://mat_xxx` 引用。渠道要求 URL 公网可达、扩展名与 type 匹配
//   （图 jpg/jpeg/png/webp/bmp/tiff/gif/heic，视频 mp4/mov，音频 wav/mp3）；
//   「涉及人脸、虚拟人图片需走素材库接口过审，否则视频会生成失败」——数字人形象图全部要过这里。
// 过审发生在视频提交之前：任何失败都明确「未提交」——网络/5xx/429/等待超时 → retryable（交队列退避重试）；
//   渠道 4xx / 审核不通过 → 不可重试，由视频适配器转成 { status: 'failed' }（该段失败退回，不冻结）。
// 参考移植：超搭云 aiide/materials.js（去掉 Ark 直签分支，错误改为本仓库 ProviderError 口径）。
import { ProviderError } from './transport.js';

export const MATERIAL_EXTENSIONS = Object.freeze({
  image: /\.(jpe?g|png|webp|bmp|tiff?|gif|heic)$/i,
  video: /\.(mp4|mov)$/i,
  audio: /\.(wav|mp3)$/i,
});
// 缓存键去掉签名参数（七牛 e/token、S3/TOS/OSS 签名族）：同一对象重签后仍命中同一素材
const SIGNING_QUERY = /^(e|token|signature|expires|ossaccesskeyid|security-token|x-amz-.*|x-goog-.*|x-tos-.*)$/i;
const NOT_SUBMITTED_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'UND_ERR_CONNECT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET']);

const short = (value) => {
  if (value === undefined || value === null) return undefined;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.slice(0, 200);
};

export function materialCacheKey(url, type) {
  try {
    const parsed = new URL(url);
    for (const key of [...parsed.searchParams.keys()]) {
      if (SIGNING_QUERY.test(key)) parsed.searchParams.delete(key);
    }
    parsed.hash = '';
    return `${type}:${parsed.toString()}`;
  } catch { return `${type}:${url}`; }
}

/** 本地预检：URL 必须是 http(s) 且路径以该类型支持的扩展名结尾（渠道硬性要求，缺扩展名上游 400）。 */
export function assertMaterialUrl(url, type) {
  const pattern = MATERIAL_EXTENSIONS[type];
  if (!pattern) throw new ProviderError('素材类型不受支持。', { code: 'PROVIDER_INPUT_INVALID', submitted: false });
  let parsed;
  try { parsed = new URL(url); } catch {
    throw new ProviderError('素材地址不是合法 URL。', { code: 'PROVIDER_INPUT_INVALID', submitted: false });
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    throw new ProviderError('素材地址必须是公网 http(s) 链接。', { code: 'PROVIDER_INPUT_INVALID', submitted: false });
  }
  if (!pattern.test(parsed.pathname)) {
    throw new ProviderError('素材地址缺少渠道支持的文件扩展名。', {
      code: 'PROVIDER_INPUT_INVALID', submitted: false, providerMessage: `${type}: ${parsed.pathname.slice(-40)}`,
    });
  }
}

export function createAiideMaterials({ baseUrl, apiKey, fetchImpl = globalThis.fetch, requestTimeoutMs = 60_000,
  pollIntervalMs = 2_000, pollTimeoutMs = 180_000, purpose = 'Mini AI Video 参考素材', cacheSize = 500, logger,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  if (!baseUrl || !apiKey) throw new ProviderError('aiide 渠道地址或凭证未配置。', { code: 'PROVIDER_CONFIG_INVALID', submitted: false });
  const root = String(baseUrl).replace(/\/+$/, '');
  const cache = new Map(); // cacheKey → Promise<assetRef>

  const unavailable = (message, extra = {}) => new ProviderError(message, {
    code: 'PROVIDER_REFERENCE_UNAVAILABLE', submitted: false, retryable: true, ...extra,
  });

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
      if (controller.signal.aborted) throw unavailable('素材库请求超时。');
      const code = error?.cause?.code ?? error?.code;
      if (NOT_SUBMITTED_CODES.has(code)) throw unavailable('无法连接素材库。');
      throw unavailable('素材库请求失败。', { providerMessage: short(error?.message) });
    } finally { clearTimeout(timer); }
  }

  /** 把渠道响应转成素材记录或抛错：429/5xx → retryable；4xx/success:false → 明确拒绝（不可重试、未提交）。 */
  function unwrap(result, action) {
    const { status, ok, data, rawText } = result;
    if (status === 429 || status >= 500 || status === 408) {
      throw unavailable(`素材库${action}暂不可用。`, { status, providerMessage: short(data?.message ?? data?.error ?? rawText) });
    }
    if (!ok) {
      if ([401, 403].includes(status)) logger?.error?.('aiide_materials_auth_rejected', { status });
      throw new ProviderError(`素材${action}被渠道拒绝。`, {
        code: 'PROVIDER_REJECTED', submitted: false, status,
        providerMessage: short(data?.error?.message ?? data?.message ?? data?.error ?? rawText),
        providerCode: short(String(data?.error?.code ?? data?.code ?? '')),
      });
    }
    if (data?.success === false) {
      throw new ProviderError(`素材${action}被渠道拒绝。`, {
        code: 'PROVIDER_REJECTED', submitted: false, status,
        providerMessage: short(data.message ?? data.error), providerCode: short(String(data.code ?? '')),
      });
    }
    return data?.data ?? {};
  }

  function rejectedByReview(asset) {
    return new ProviderError('参考素材未通过渠道审核。', {
      code: 'PROVIDER_REFERENCE_REJECTED', submitted: false, retryable: false,
      providerMessage: short(asset.failure_reason ?? asset.error ?? asset.message),
    });
  }

  async function waitUntilReady(assetId) {
    const deadline = Date.now() + pollTimeoutMs;
    let interval = pollIntervalMs;
    for (;;) {
      const asset = unwrap(await request(`/v1/assets/${encodeURIComponent(assetId)}`), '查询');
      const state = String(asset.status ?? '').toLowerCase();
      if (state === 'ready') return asset.asset_id ?? assetId;
      if (state === 'failed') throw rejectedByReview(asset);
      if (Date.now() >= deadline) {
        logger?.warn?.('aiide_materials_review_timeout', { assetId, pollTimeoutMs });
        throw unavailable('参考素材审核等待超时。', { providerMessage: `asset ${assetId} 仍为 ${state || 'pending'}` });
      }
      await sleep(interval);
      interval = Math.min(Math.ceil(interval * 1.5), 5_000);
    }
  }

  async function upload(url, type) {
    const asset = unwrap(await request('/v1/assets/upload', { method: 'POST', body: { url, type, purpose } }), '上传');
    if (String(asset.status ?? '').toLowerCase() === 'failed') throw rejectedByReview(asset);
    if (!asset.asset_id) {
      const detail = asset.error ?? asset.assets?.[0]?.error ?? asset.failure_reason;
      if (detail) {
        throw new ProviderError('素材上传被渠道拒绝。', { code: 'PROVIDER_REJECTED', submitted: false, providerMessage: short(detail) });
      }
      throw unavailable('素材上传未返回素材编号。');
    }
    const assetId = String(asset.asset_id);
    return String(asset.status ?? '').toLowerCase() === 'ready' ? assetId : waitUntilReady(assetId);
  }

  return {
    /** 已是 asset:// 引用的原样返回；否则上传并等待过审，返回 `asset://mat_xxx`。 */
    async register(url, type = 'image') {
      const source = String(url ?? '').trim();
      if (/^asset:\/\//i.test(source)) return source;
      if (/^mat_[A-Za-z0-9_-]+$/.test(source)) return `asset://${source}`;
      assertMaterialUrl(source, type);
      const key = materialCacheKey(source, type);
      if (!cache.has(key)) {
        if (cache.size >= cacheSize) cache.delete(cache.keys().next().value); // 简单 FIFO 上限，防长期运行无界增长
        const promise = upload(source, type).then((assetId) => `asset://${assetId}`).catch((error) => {
          cache.delete(key); // 失败不缓存：下次重试重新上传
          throw error;
        });
        cache.set(key, promise);
      }
      const assetRef = await cache.get(key);
      logger?.info?.('aiide_material_ready', { type, assetRef });
      return assetRef;
    },
    /** 测试/诊断：缓存条目数。 */
    cacheSize() { return cache.size; },
  };
}
