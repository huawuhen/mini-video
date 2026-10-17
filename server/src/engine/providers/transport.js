// Source: chaodayun@2926b42 backend/providers.js
// Modelhub HTTP transport; never retry a POST whose acceptance is uncertain.
export class ProviderError extends Error {
  constructor(message, { code = 'PROVIDER_FAILED', submitted, retryable = false, status, providerMessage, providerCode, retryAfter } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
    this.retryable = retryable;
    if (submitted !== undefined) this.submitted = submitted;
    if (status !== undefined) this.status = status;
    if (providerMessage !== undefined) this.providerMessage = providerMessage;
    if (providerCode !== undefined) this.providerCode = providerCode;
    if (retryAfter !== undefined) this.retryAfter = retryAfter;
  }
}

const MAX_RESPONSE_BYTES = 1024 * 1024;
const short = (value) => typeof value === 'string' ? value.slice(0, 200) : undefined;
const definitelyNotSubmitted = (error) => {
  const code = error?.cause?.code ?? error?.code;
  return ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT', 'UND_ERR_CONNECT_TIMEOUT'].includes(code);
};

async function boundedJson(response) {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_RESPONSE_BYTES) throw new ProviderError('渠道响应超出大小限制。', {
        code: 'SUBMISSION_UNKNOWN', submitted: true,
      });
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), length).toString('utf8')); }
  catch { throw new ProviderError('渠道响应无法解析。', { code: 'SUBMISSION_UNKNOWN', submitted: true }); }
}

function providerDetails(data) {
  const error = data?.error;
  return {
    providerMessage: short(error?.message ?? (typeof error === 'string' ? error : data?.message)),
    providerCode: short(String(error?.code ?? data?.code ?? '')) || undefined,
  };
}

export function createModelhubTransport({ baseUrl, apiKey, fetchImpl = globalThis.fetch, timeoutMs = 30_000, logger } = {}) {
  if (!baseUrl || !apiKey) throw new ProviderError('渠道地址或凭证未配置。', { code: 'PROVIDER_CONFIG_INVALID', submitted: false });
  const origin = new URL(baseUrl);
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password) {
    throw new ProviderError('渠道地址无效。', { code: 'PROVIDER_CONFIG_INVALID', submitted: false });
  }
  async function request(path, { method = 'GET', body, idempotencyKey, headers = {} } = {}) {
    const url = new URL(path, `${origin.href.replace(/\/$/, '')}/`);
    if (url.origin !== origin.origin) throw new ProviderError('渠道路径无效。', { code: 'PROVIDER_CONFIG_INVALID', submitted: false });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const post = method.toUpperCase() === 'POST';
    try {
      const response = await fetchImpl(url, {
        method, signal: controller.signal, redirect: 'manual',
        headers: { Authorization: `Bearer ${apiKey}`, ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
          ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}), ...headers },
        ...(body === undefined ? {} : { body: body instanceof FormData ? body : JSON.stringify(body) }),
      });
      if (response.status === 429) throw new ProviderError('渠道请求过于频繁，请稍后重试。', {
        code: 'PROVIDER_RATE_LIMITED', submitted: false, retryable: true, status: 429,
        retryAfter: short(response.headers.get('retry-after')),
      });
      if (response.status >= 300 && response.status < 400) {
        throw new ProviderError('渠道重定向结果不确定。', { code: 'SUBMISSION_UNKNOWN', submitted: post, status: response.status });
      }
      if (response.status >= 400 && response.status < 500 && response.status !== 408) {
        let details = {};
        try { details = providerDetails(await boundedJson(response)); } catch { /* bounded response unavailable */ }
        const error = new ProviderError('渠道明确拒绝了请求。', {
          code: 'PROVIDER_REJECTED', submitted: false, status: response.status, ...details,
        });
        if ([401, 403].includes(response.status)) logger?.error?.('provider_auth_rejected', {
          status: response.status, providerCode: error.providerCode, providerMessage: error.providerMessage,
        });
        throw error;
      }
      if (!response.ok) throw new ProviderError('渠道受理结果不确定。', {
        code: 'SUBMISSION_UNKNOWN', submitted: post, status: response.status,
      });
      const length = response.headers.get('content-length');
      if (length && /^\d+$/.test(length) && BigInt(length) > BigInt(MAX_RESPONSE_BYTES)) {
        throw new ProviderError('渠道响应超出大小限制。', { code: 'SUBMISSION_UNKNOWN', submitted: post });
      }
      return await boundedJson(response);
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      if (definitelyNotSubmitted(error)) throw new ProviderError('无法连接生成渠道。', {
        code: 'PROVIDER_NOT_SUBMITTED', submitted: false, retryable: true,
      });
      throw new ProviderError('渠道受理结果不确定。', { code: 'SUBMISSION_UNKNOWN', submitted: post });
    } finally { clearTimeout(timer); }
  }
  return { request };
}

export async function submitSafely(transport, path, options) {
  try { return await transport.request(path, options); }
  catch (error) {
    if (error.submitted === false) throw error;
    return { status: 'unknown' };
  }
}
