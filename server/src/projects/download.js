// 上游视频落地本地：safeFetch（SSRF/大小/超时防护）→ 写临时文件，供 render.inspect / 拼接使用。
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { safeFetch } from '../engine/net/index.js';

export function createDownloader({ maxBytes, timeoutMs = 300_000, safeFetchImpl = safeFetch }) {
  return async function downloadToTempFile(url, localPath, { timeoutMs: override } = {}) {
    const response = await safeFetchImpl(url, { maxBytes, timeoutMs: override ?? timeoutMs });
    await pipeline(response.stream, createWriteStream(localPath));
    return localPath;
  };
}

/** 拉回已转存的片段成片：生产经签名下载链接走 safeFetch；测试可注入假实现。 */
export function createLocalFetcher({ storage, safeFetchImpl = safeFetch, signedUrlTtlSeconds = 3600,
  maxBytes = 536_870_912 }) {
  return async function fetchLocal(key, localPath) {
    const url = await storage.signedUrl(key, { ttlSeconds: signedUrlTtlSeconds });
    if (!/^https?:/i.test(url)) {
      throw new Error(`存储驱动无法提供 HTTP 下载地址（${url.slice(0, 40)}…），无法回拉本地文件`);
    }
    const response = await safeFetchImpl(url, { maxBytes, timeoutMs: 300_000 });
    await pipeline(response.stream, createWriteStream(localPath));
    return localPath;
  };
}
