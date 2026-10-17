// Source: chaodayun@2926b42 backend/providers.js, modelhub-models.js
// Modelhub request transport shared by video and image adapters; dependencies are injected.
export class ProviderError extends Error {
  constructor(message, { code = 'PROVIDER_FAILED', submitted, status } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
    if (submitted !== undefined) this.submitted = submitted;
    if (status !== undefined) this.status = status;
  }
}

const definitelyNotSubmitted = (error) => {
  const code = error?.cause?.code ?? error?.code;
  return ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT'].includes(code);
};

export function createModelhubTransport({ baseUrl, apiKey, fetchImpl = globalThis.fetch, timeoutMs = 30_000 }) {
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
    let response;
    try {
      response = await fetchImpl(url, {
        method, signal: controller.signal, redirect: 'manual',
        headers: { Authorization: `Bearer ${apiKey}`, ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
          ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}), ...headers },
        ...(body === undefined ? {} : { body: body instanceof FormData ? body : JSON.stringify(body) }),
      });
      if (response.status >= 300 && response.status < 400) {
        throw new ProviderError('渠道重定向结果不确定。', { code: 'SUBMISSION_UNKNOWN', submitted: post, status: response.status });
      }
      // A 4xx response (other than timeout/rate limit) explicitly rejects the request.
      if (response.status >= 400 && response.status < 500 && ![408, 429].includes(response.status)) {
        throw new ProviderError('渠道明确拒绝了请求。', { code: 'PROVIDER_REJECTED', submitted: false, status: response.status });
      }
      if (!response.ok) throw new ProviderError('渠道受理结果不确定。', {
        code: 'SUBMISSION_UNKNOWN', submitted: post, status: response.status,
      });
      try { return await response.json(); }
      catch { throw new ProviderError('渠道响应无法解析，受理结果不确定。', { code: 'SUBMISSION_UNKNOWN', submitted: post }); }
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      if (definitelyNotSubmitted(error)) throw new ProviderError('无法连接生成渠道。', {
        code: 'PROVIDER_NOT_SUBMITTED', submitted: false,
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
