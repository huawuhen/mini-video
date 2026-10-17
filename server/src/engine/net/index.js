// Source: chaodayun@2926b42 network-safety.js（大幅简化适配：
//   undici Agent → node:http/https 的 lookup 选项钉定已验证 IP；去掉重试、Range、公网 DNS 回退与代理逻辑；
//   保留：URL/凭证校验、公网地址判定（含 IPv6 与 IPv4 映射）、DNS 预解析 + 钉定（防重绑定）、
//   逐跳重定向复验（最多 3 次）、maxBytes 流式超限中断、整体超时。解析器与 HTTP 实现可注入，测试不访问外网）。
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
    this.code = code; // REMOTE_URL_INVALID / REMOTE_ADDRESS_BLOCKED / REMOTE_DNS_FAILED / REMOTE_TOO_LARGE / REMOTE_TIMEOUT / REMOTE_REDIRECT_LIMIT / REMOTE_HTTP_ERROR / REMOTE_FETCH_FAILED
  }
}

/** 仅公网单播地址；映射/过渡类 IPv6 一律拒绝。 */
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
  // 公网 IPv6 目前只从 2000::/3 分配；其内的特殊段（IETF 协议、Teredo/ORCHID、文档、6to4 内嵌 IPv4）一并拒绝
  const [first, second = '0'] = address.toLowerCase().split(':');
  const a = Number.parseInt(first, 16);
  const b = Number.parseInt(second || '0', 16);
  return a >= 0x2000 && a <= 0x3fff
    && !(a === 0x2001 && (b < 0x0200 || b === 0x0db8))
    && a !== 0x2002 && !(a === 0x3fff && b < 0x1000);
}

function parseRemoteUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new SafeFetchError('REMOTE_URL_INVALID', '远程地址必须是有效的 URL。');
  }
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

/** 默认解析器：系统 DNS，全部返回结果。 */
async function defaultResolver(hostname) {
  const records = await dns.promises.lookup(hostname, { all: true, verbatim: true });
  return records.map((r) => ({ address: r.address, family: r.family }));
}

/**
 * 默认 HTTP 实现：node:http(s) 请求，用 lookup 钩子把连接钉定到已验证的 IP，
 * Host 头与 TLS SNI 仍用原始主机名（证书校验不受影响）。
 * 返回 IncomingMessage（带 statusCode/headers，本身是 Readable）。
 */
function defaultHttpImpl({ url: current, pinned, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const transport = current.protocol === 'https:' ? https : http;
    const req = transport.request(
      {
        host: current.hostname,
        port: current.port || undefined,
        path: `${current.pathname}${current.search}`,
        method: 'GET',
        servername: current.protocol === 'https:' ? current.hostname : undefined,
        headers: {
          host: current.host,
          accept: '*/*',
          'accept-encoding': 'identity',
          'user-agent': 'mini-video-engine/1.0',
          connection: 'close',
        },
        lookup: (host, options, callback) => {
          const record = pinned[0];
          if (options?.all) callback(null, [{ address: record.address, family: record.family }]);
          else callback(null, record.address, record.family);
        },
      },
      (res) => resolve(res),
    );
    req.setTimeout(timeoutMs, () => req.destroy(new SafeFetchError('REMOTE_TIMEOUT', '远程读取超过时间限制。')));
    req.on('error', (err) => reject(err instanceof SafeFetchError ? err : new SafeFetchError('REMOTE_FETCH_FAILED', `网络请求失败：${err.message}`)));
    req.end();
  });
}

/** 给响应流加 maxBytes 计数（超限立即销毁）与整体超时。 */
function guardStream(res, { maxBytes, timeoutMs }) {
  let total = 0;
  const timer = setTimeout(() => res.destroy(new SafeFetchError('REMOTE_TIMEOUT', '远程读取超过时间限制。')), timeoutMs);
  const guard = new Transform({
    transform(chunk, _encoding, callback) {
      total += chunk.length;
      if (total > maxBytes) {
        res.destroy();
        callback(new SafeFetchError('REMOTE_TOO_LARGE', '远程响应超过大小限制。'));
        return;
      }
      callback(null, chunk);
    },
    flush(callback) { clearTimeout(timer); callback(); },
  });
  guard.on('close', () => clearTimeout(timer));
  res.on('error', (err) => guard.destroy(err instanceof SafeFetchError ? err : new SafeFetchError('REMOTE_FETCH_FAILED', `读取远程响应失败：${err.message}`)));
  res.pipe(guard);
  return guard;
}

/**
 * safeFetch(url, { maxBytes, timeoutMs }) → { status, contentType, headers, stream }
 * stream 为 Node Readable（已按 maxBytes 与超时守护），调用方负责消费完或销毁。
 * 每一跳重定向都重新做 DNS 解析与地址校验（防重绑定），最多 3 次。
 */
export function createSafeFetch({ resolver = defaultResolver, httpImpl = defaultHttpImpl } = {}) {
  return async function safeFetch(url, { maxBytes = 64 * 1024 * 1024, timeoutMs = 60_000 } = {}) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new SafeFetchError('REMOTE_URL_INVALID', 'maxBytes 必须是正整数。');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new SafeFetchError('REMOTE_URL_INVALID', 'timeoutMs 必须是正整数。');
    let current = parseRemoteUrl(url);
    for (let hop = 0; ; hop += 1) {
      let records;
      try {
        records = await resolver(current.hostname);
      } catch (err) {
        throw err instanceof SafeFetchError ? err : new SafeFetchError('REMOTE_DNS_FAILED', '无法解析远程地址。');
      }
      if (!Array.isArray(records) || !records.length) throw new SafeFetchError('REMOTE_ADDRESS_BLOCKED', '远程地址没有可用的解析结果。');
      const pinned = records
        .map((r) => ({ address: r.address ?? r, family: r.family ?? isIP(r.address ?? r) }))
        .filter((r) => isPublicAddress(r.address));
      if (!pinned.length) throw new SafeFetchError('REMOTE_ADDRESS_BLOCKED', '远程地址解析到了本机、私网或保留地址。');

      const res = await httpImpl({ url: current.url, pinned, timeoutMs });
      const status = res.statusCode ?? res.status ?? 0;
      if ([301, 302, 303, 307, 308].includes(status)) {
        const location = res.headers?.location;
        res.resume(); // 丢弃重定向响应体
        if (hop >= MAX_REDIRECTS) throw new SafeFetchError('REMOTE_REDIRECT_LIMIT', '远程重定向次数超过限制。');
        if (!location) throw new SafeFetchError('REMOTE_URL_INVALID', '远程重定向缺少目标地址。');
        current = parseRemoteUrl(new URL(location, current.url).href); // 每一跳重新校验
        continue;
      }
      if (status < 200 || status >= 400) {
        res.resume();
        throw new SafeFetchError('REMOTE_HTTP_ERROR', `远程下载返回 HTTP ${status}。`);
      }
      const declared = Number(res.headers?.['content-length']);
      if (Number.isSafeInteger(declared) && declared > maxBytes) {
        res.resume();
        throw new SafeFetchError('REMOTE_TOO_LARGE', '远程响应超过大小限制。');
      }
      return {
        status,
        contentType: (res.headers?.['content-type'] ?? '').split(';')[0].trim() || 'application/octet-stream',
        headers: res.headers ?? {},
        stream: guardStream(res, { maxBytes, timeoutMs }),
      };
    }
  };
}

/** 默认实例（README 中的 safeFetch(url, { maxBytes, timeoutMs })）。 */
export const safeFetch = createSafeFetch();
