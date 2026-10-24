// Source: chaodayun@2926b42 network-safety.js
// Adapted to pinned node:http(s) connections with injectable DNS and transport.
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import { isIP } from 'node:net';
import { Transform } from 'node:stream';

const MAX_REDIRECTS = 3;

export class SafeFetchError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SafeFetchError';
    this.code = code;
  }
}

export function isPublicAddress(address) {
  if (typeof address !== 'string' || address.includes('%')) return false;
  const family = isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99)))
      || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
      || (a === 203 && b === 0 && c === 113));
  }
  if (family !== 6) return false;
  const [first, second = '0'] = address.toLowerCase().split(':');
  const a = Number.parseInt(first, 16);
  const b = Number.parseInt(second || '0', 16);
  return a >= 0x2000 && a <= 0x3fff
    && !(a === 0x2001 && (b < 0x0200 || b === 0x0db8))
    && a !== 0x2002 && !(a === 0x3fff && b < 0x1000);
}

function parseRemoteUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new SafeFetchError('REMOTE_URL_INVALID', '远程地址必须是有效的 URL。'); }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) {
    throw new SafeFetchError('REMOTE_URL_INVALID', '远程地址仅支持无用户名密码的 HTTP(S) URL。');
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  if (!hostname || hostname === 'localhost' || /\.(localhost|local|internal)$/.test(hostname)
    || (isIP(hostname) && !isPublicAddress(hostname))) {
    throw new SafeFetchError('REMOTE_ADDRESS_BLOCKED', '远程地址不允许指向本机、私网或保留地址。');
  }
  url.hash = '';
  return { url, hostname };
}

async function defaultResolver(hostname) {
  return dns.promises.lookup(hostname, { all: true, verbatim: true });
}

function requestAtAddress(current, record, signal, transport, extraHeaders) {
  return new Promise((resolve, reject) => {
    const req = transport.request({
      host: current.hostname,
      port: current.port || undefined,
      path: `${current.pathname}${current.search}`,
      method: 'GET',
      servername: current.protocol === 'https:' ? current.hostname : undefined,
      headers: { host: current.host, accept: '*/*', 'accept-encoding': 'identity',
        'user-agent': 'mini-video-engine/1.0', connection: 'close', ...(extraHeaders ?? {}) },
      signal,
      lookup: (_host, options, callback) => {
        if (options?.all) callback(null, [{ ...record }]);
        else callback(null, record.address, record.family);
      },
    }, resolve);
    req.on('error', (error) => reject(signal.aborted ? signal.reason
      : new SafeFetchError('REMOTE_FETCH_FAILED', `网络请求失败：${error.message}`)));
    req.end();
  });
}

async function defaultHttpImpl({ url, pinned, signal, headers }, transport = url.protocol === 'https:' ? https : http) {
  let lastError;
  for (const record of pinned) {
    if (signal.aborted) throw signal.reason;
    try { return await requestAtAddress(url, record, signal, transport, headers); }
    catch (error) {
      if (signal.aborted) throw signal.reason;
      lastError = error;
    }
  }
  throw lastError;
}

function awaitAbortable(promise, signal, lateValue) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => { signal.removeEventListener('abort', onAbort); reject(signal.reason); };
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then((value) => {
      signal.removeEventListener('abort', onAbort);
      if (signal.aborted) { lateValue?.(value); return; }
      resolve(value);
    }, (error) => { signal.removeEventListener('abort', onAbort); if (!signal.aborted) reject(error); });
  });
}

function guardStream(res, { maxBytes, signal, dispose }) {
  let total = 0;
  const guard = new Transform({
    transform(chunk, _encoding, callback) {
      total += chunk.length;
      if (total > maxBytes) {
        res.destroy();
        callback(new SafeFetchError('REMOTE_TOO_LARGE', '远程响应超过大小限制。'));
      } else callback(null, chunk);
    },
  });
  const onAbort = () => res.destroy(signal.reason);
  signal.addEventListener('abort', onAbort, { once: true });
  res.on('error', (error) => guard.destroy(error instanceof SafeFetchError ? error
    : new SafeFetchError('REMOTE_FETCH_FAILED', `读取远程响应失败：${error.message}`)));
  guard.on('close', () => { signal.removeEventListener('abort', onAbort); dispose(); });
  res.pipe(guard);
  return guard;
}

export function createSafeFetch({ resolver = defaultResolver, httpImpl = defaultHttpImpl, transport } = {}) {
  const request = transport ? (options) => defaultHttpImpl(options, transport) : httpImpl;
  return async function safeFetch(url, { maxBytes = 64 * 1024 * 1024, timeoutMs = 60_000, headers = {} } = {}) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new SafeFetchError('REMOTE_URL_INVALID', 'maxBytes 必须是正整数。');
    if (headers && typeof headers !== 'object') throw new SafeFetchError('REMOTE_URL_INVALID', 'headers 必须是对象。');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new SafeFetchError('REMOTE_URL_INVALID', 'timeoutMs 必须是正整数。');
    const controller = new AbortController();
    const { signal } = controller;
    const timer = setTimeout(() => controller.abort(new SafeFetchError('REMOTE_TIMEOUT', '远程读取超过时间限制。')), timeoutMs);
    const dispose = () => clearTimeout(timer);
    let current;
    try {
      current = parseRemoteUrl(url);
      for (let hop = 0; ; hop += 1) {
        let records;
        try { records = await awaitAbortable(resolver(current.hostname, { signal }), signal); }
        catch (error) {
          if (signal.aborted) throw signal.reason;
          throw error instanceof SafeFetchError ? error : new SafeFetchError('REMOTE_DNS_FAILED', '无法解析远程地址。');
        }
        if (!Array.isArray(records) || !records.length) {
          throw new SafeFetchError('REMOTE_ADDRESS_BLOCKED', '远程地址没有可用的解析结果。');
        }
        const pinned = records.map((record) => ({
          address: record.address ?? record,
          family: record.family ?? isIP(record.address ?? record),
        }));
        if (pinned.some(({ address, family }) => !isPublicAddress(address) || isIP(address) !== family)) {
          throw new SafeFetchError('REMOTE_ADDRESS_BLOCKED', '远程地址解析到了本机、私网或保留地址。');
        }
        pinned.sort((a, b) => a.family - b.family);
        const res = await awaitAbortable(request({ url: current.url, pinned, timeoutMs, signal, headers }), signal,
          (response) => response?.destroy?.());
        const status = res.statusCode ?? res.status ?? 0;
        if ([301, 302, 303, 307, 308].includes(status)) {
          const location = res.headers?.location;
          res.destroy();
          if (hop >= MAX_REDIRECTS) throw new SafeFetchError('REMOTE_REDIRECT_LIMIT', '远程重定向次数超过限制。');
          if (!location) throw new SafeFetchError('REMOTE_URL_INVALID', '远程重定向缺少目标地址。');
          current = parseRemoteUrl(new URL(location, current.url).href);
          continue;
        }
        if (status < 200 || status >= 300) {
          res.destroy();
          throw new SafeFetchError('REMOTE_HTTP_ERROR', `远程下载返回 HTTP ${status}。`);
        }
        const length = res.headers?.['content-length'];
        if (length && /^\d+$/.test(length) && BigInt(length) > BigInt(maxBytes)) {
          res.destroy();
          throw new SafeFetchError('REMOTE_TOO_LARGE', '远程响应超过大小限制。');
        }
        return { status, contentType: (res.headers?.['content-type'] ?? '').split(';')[0].trim()
          || 'application/octet-stream', headers: res.headers ?? {},
        stream: guardStream(res, { maxBytes, signal, dispose }) };
      }
    } catch (error) {
      dispose();
      throw signal.aborted ? signal.reason : error;
    }
  };
}

export const safeFetch = createSafeFetch();
