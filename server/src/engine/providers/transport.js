// 共用 HTTP 层（docs/ARCHITECTURE.md §5.5 驱动规范 1）：所有驱动一律经这里发请求，
// 不引入厂商 SDK；需要签名/HMAC 写在驱动内部（先经本层校验 URL 再自行加头）。
// 统一职责：超时中断、响应体大小上限、Bearer 鉴权、JSON/FormData 编码、
// 网络层错误的统一分类（连接类 → 确定未提交可重试；超时/断连 → 结果不确定）。
// 渠道 base_url 是管理员录入的受信配置（审计留痕），SSRF 防护对象是「用户可控 URL」
// （参考素材、上游成片下载走 engine/net.safeFetch，与本层无关）。
import { ProviderError } from './contract.js';

export { ProviderError };

const MAX_RESPONSE_BYTES = 1024 * 1024;
const NOT_SUBMITTED_CODES = new Set([
  'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT', 'UND_ERR_CONNECT_TIMEOUT',
]);

const short = (value) => {
  if (value === undefined || value === null) return undefined;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.slice(0, 200);
};

/** 解析渠道地址：仅 http(s)、不带用户名密码（防头注入与凭证泄漏）。 */
export function parseBaseUrl(baseUrl) {
  if (!baseUrl || typeof baseUrl !== 'string') {
    throw new ProviderError('渠道地址未配置。', { code: 'PROVIDER_CONFIG_INVALID', submitted: false });
  }
  let origin;
  try { origin = new URL(baseUrl); } catch {
    throw new ProviderError('渠道地址不是合法 URL。', { code: 'PROVIDER_CONFIG_INVALID', submitted: false });
  }
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password) {
    throw new ProviderError('渠道地址无效。', { code: 'PROVIDER_CONFIG_INVALID', submitted: false });
  }
  return origin;
}

/**
 * 建一个渠道 HTTP 客户端。request() 永不因「HTTP 状态码」抛错（状态分类是驱动的职责），
 * 只因网络层故障抛 ProviderError：
 *   - 连接类失败（拒绝/DNS）→ { submitted:false, retryable:true }
 *   - 超时 / 中断 / 读取失败 → { submitted: method==='POST' }（结果不确定，绝不自动重试）
 * @returns {{ request(path: string, opts?: {method?: string, body?: object, form?: FormData,
 *            headers?: object, timeoutMs?: number}): Promise<{status: number, ok: boolean, data: object|null, rawText?: string}> }}
 */
export function createChannelHttp({ baseUrl, credential, fetchImpl = globalThis.fetch, timeoutMs = 180_000 } = {}) {
  const origin = parseBaseUrl(baseUrl);
  if (!credential || typeof credential !== 'string') {
    throw new ProviderError('渠道凭证未配置。', { code: 'PROVIDER_CONFIG_INVALID', submitted: false });
  }
  const root = origin.href.replace(/\/+$/, '');

  async function request(path, { method = 'GET', body, form, headers = {}, timeoutMs: perCallTimeout } = {}) {
    let url;
    try { url = new URL(String(path), `${root}/`); } catch {
      throw new ProviderError('渠道路径无效。', { code: 'PROVIDER_CONFIG_INVALID', submitted: false });
    }
    if (url.origin !== origin.origin) {
      throw new ProviderError('渠道路径越出渠道地址。', { code: 'PROVIDER_CONFIG_INVALID', submitted: false });
    }
    const post = method.toUpperCase() === 'POST';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), perCallTimeout ?? timeoutMs);
    try {
      const response = await fetchImpl(url, {
        method, signal: controller.signal,
        headers: {
          Authorization: `Bearer ${credential}`,
          // multipart 由 fetch 自动带 boundary，不能手写 Content-Type
          ...(form ? {} : body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...headers,
        },
        ...(body === undefined && form === undefined ? {} : { body: form ?? JSON.stringify(body) }),
      });
      // 有界读取：超限直接按「结果不确定」处理（响应可能已受理）
      const reader = response.body?.getReader?.();
      if (reader) {
        const chunks = [];
        let length = 0;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            length += value.byteLength;
            if (length > MAX_RESPONSE_BYTES) {
              throw new ProviderError('渠道响应超出大小限制。', { code: 'SUBMISSION_UNKNOWN', submitted: post });
            }
            chunks.push(value);
          }
          const text = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), length).toString('utf8');
          let data = null;
          try { data = text ? JSON.parse(text) : null; } catch { data = null; }
          return { status: response.status, ok: response.ok, data, rawText: short(text) };
        } finally { reader.releaseLock(); }
      }
      const text = await response.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = null; }
      return { status: response.status, ok: response.ok, data, rawText: short(text) };
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      if (controller.signal.aborted) {
        throw new ProviderError('渠道请求超时。', { code: 'SUBMISSION_UNKNOWN', submitted: post });
      }
      const code = error?.cause?.code ?? error?.code;
      if (NOT_SUBMITTED_CODES.has(code)) {
        throw new ProviderError('无法连接生成渠道。', { code: 'PROVIDER_NOT_SUBMITTED', submitted: false, retryable: true });
      }
      throw new ProviderError('渠道请求失败，结果不确定。', {
        code: 'SUBMISSION_UNKNOWN', submitted: post, providerMessage: short(error?.message),
      });
    } finally { clearTimeout(timer); }
  }

  return { request, root };
}
