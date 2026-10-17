// Source: chaodayun@2926b42 storage/qiniu-kodo.js + backend/object-storage.js
// Adapted from the S3 client to the native Qiniu Kodo APIs; HTTP is injectable for tests.
import { createHmac, randomBytes } from 'node:crypto';

export class StorageError extends Error {
  constructor(message, { code = 'STORAGE_FAILED', status } = {}) {
    super(message);
    this.name = 'StorageError';
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

const FORM_MAX_BYTES = 8 * 1024 * 1024;
const PART_SIZE = 4 * 1024 * 1024;
const urlsafeBase64 = (value) => Buffer.from(value).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
const signature = (secret, input) => urlsafeBase64(createHmac('sha1', secret).update(input).digest());
const encodeKey = (key) => key.split('/').map(encodeURIComponent).join('/');

async function* partsOf(body) {
  if (Buffer.isBuffer(body)) { yield body; return; }
  if (typeof body?.[Symbol.asyncIterator] !== 'function') throw new StorageError('上传内容必须是 Buffer 或可读流。');
  yield* body;
}

// The iterator may yield arbitrarily large buffers; retain at most one full part and the current input chunk.
function chunkReader(body) {
  const iterator = partsOf(body)[Symbol.asyncIterator]();
  let pending = Buffer.alloc(0);
  let done = false;
  return {
    async next(size) {
      const chunks = [];
      let length = 0;
      while (length < size) {
        if (!pending.length && !done) {
          const item = await iterator.next();
          done = item.done;
          if (!done) pending = Buffer.isBuffer(item.value) ? item.value : Buffer.from(item.value);
        }
        if (!pending.length) {
          if (done) break;
          continue;
        }
        const take = Math.min(size - length, pending.length);
        chunks.push(pending.subarray(0, take));
        pending = pending.subarray(take);
        length += take;
      }
      return length ? Buffer.concat(chunks, length) : null;
    },
    async close() { await iterator.return?.(); },
  };
}

export function createQiniuStorage(
  { accessKey, secretKey, bucket, domain, region = 'z0' },
  { defaultTtlSeconds = 3600, fetchImpl = globalThis.fetch, now = () => Date.now(), policyTtlSeconds = 3600 } = {},
) {
  if (!accessKey || !secretKey || !bucket || !domain) {
    throw new StorageError('七牛存储配置不完整（QINIU_ACCESS_KEY / SECRET_KEY / BUCKET / DOMAIN）', { code: 'STORAGE_CONFIG_MISSING' });
  }
  const uploadHost = `https://up-${region}.qiniup.com`;
  const downloadBase = domain.startsWith('http') ? domain.replace(/\/$/, '') : `https://${domain}`;
  const qboxToken = (input) => `${accessKey}:${signature(secretKey, input)}`;
  const uploadToken = (key) => {
    const policy = urlsafeBase64(JSON.stringify({ scope: `${bucket}:${key}`, deadline: Math.floor(now() / 1000) + policyTtlSeconds }));
    return `${accessKey}:${signature(secretKey, policy)}:${policy}`;
  };

  async function requireSuccess(response, operation) {
    if (!response.ok) {
      throw new StorageError(`七牛${operation}失败（HTTP ${response.status}）：${(await response.text().catch(() => '')).slice(0, 200)}`, { status: response.status });
    }
    return response;
  }

  async function formUpload(key, data, contentType, token) {
    const boundary = `miv-${randomBytes(16).toString('hex')}`;
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="token"\r\n\r\n${token}\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="key"\r\n\r\n${key}\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="upload"\r\nContent-Type: ${contentType}\r\n\r\n`),
      data,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    await requireSuccess(await fetchImpl(`${uploadHost}/`, {
      method: 'POST', headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` }, body,
    }), '表单上传');
    return { key, size: data.length, contentType };
  }

  async function multipartUpload(key, reader, first, contentType, token) {
    // Native Kodo v2: https://developer.qiniu.com/kodo/api/6364/multipartupload-interface
    const resource = `${uploadHost}/buckets/${encodeURIComponent(bucket)}/objects/${urlsafeBase64(key)}/uploads`;
    const auth = { Authorization: `UpToken ${token}` };
    const init = await requireSuccess(await fetchImpl(resource, { method: 'POST', headers: auth }), '分片初始化');
    const { uploadId } = await init.json();
    if (!uploadId || typeof uploadId !== 'string') throw new StorageError('七牛未返回分片 uploadId。');
    const endpoint = `${resource}/${encodeURIComponent(uploadId)}`;
    const parts = [];
    let size = 0;
    try {
      for (let chunk = first, partNumber = 1; chunk; chunk = await reader.next(PART_SIZE), partNumber += 1) {
        if (partNumber > 10_000) throw new StorageError('七牛分片数量超过上限。');
        const response = await requireSuccess(await fetchImpl(`${endpoint}/${partNumber}`, {
          method: 'PUT',
          headers: { ...auth, 'Content-Type': 'application/octet-stream', 'Content-Length': String(chunk.length) },
          body: chunk,
        }), `第 ${partNumber} 片上传`);
        const { etag } = await response.json();
        if (!etag || typeof etag !== 'string') throw new StorageError('七牛未返回分片 etag。');
        parts.push({ partNumber, etag });
        size += chunk.length;
      }
      await requireSuccess(await fetchImpl(endpoint, {
        method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ parts, mimeType: contentType }),
      }), '分片完成');
      return { key, size, contentType };
    } catch (error) {
      await fetchImpl(endpoint, { method: 'DELETE', headers: auth }).catch(() => {});
      throw error;
    }
  }

  return {
    driver: 'qiniu',
    async put(key, body, { contentType = 'application/octet-stream' } = {}) {
      const safeContentType = typeof contentType === 'string' && !/[\r\n]/.test(contentType) && contentType.trim()
        ? contentType : 'application/octet-stream';
      const token = uploadToken(key);
      if (Buffer.isBuffer(body) && body.length <= FORM_MAX_BYTES) {
        return formUpload(key, body, safeContentType, token);
      }
      const reader = chunkReader(body);
      try {
        // Unknown-length streams need a bounded peek to select the upload protocol.
        // Keep at most 8MB + 1 byte before switching to fixed 4MB parts.
        const prefix = await reader.next(FORM_MAX_BYTES + 1);
        if (!prefix || prefix.length <= FORM_MAX_BYTES) {
          return await formUpload(key, prefix ?? Buffer.alloc(0), safeContentType, token);
        }
        const remaining = {
          prefix,
          async next(size) {
            const chunks = [];
            let length = 0;
            while (length < size) {
              if (this.prefix.length) {
                const take = Math.min(size - length, this.prefix.length);
                chunks.push(this.prefix.subarray(0, take));
                this.prefix = this.prefix.subarray(take);
                length += take;
                continue;
              }
              const chunk = await reader.next(size - length);
              if (!chunk) break;
              chunks.push(chunk);
              length += chunk.length;
            }
            return length ? Buffer.concat(chunks, length) : null;
          },
        };
        return await multipartUpload(key, remaining, await remaining.next(PART_SIZE), safeContentType, token);
      } finally { await reader.close(); }
    },
    signedUrl(key, { ttlSeconds, download } = {}) {
      const deadline = Math.floor(now() / 1000) + Math.max(1, ttlSeconds ?? defaultTtlSeconds);
      const base = `${downloadBase}/${encodeKey(key)}`;
      const filename = download === true ? key.split('/').at(-1) : download;
      const unsigned = filename ? `${base}?attname=${encodeURIComponent(String(filename))}&e=${deadline}` : `${base}?e=${deadline}`;
      return `${unsigned}&token=${qboxToken(unsigned)}`;
    },
    // Legacy QBox management authorization: sign path + '\n'. Kodo still accepts this
    // scheme for RS deletion; unlike uploads it does not use an upload token.
    async remove(keys) {
      for (const key of keys) {
        const path = `/delete/${urlsafeBase64(`${bucket}:${key}`)}`;
        const response = await fetchImpl(`https://rs.qbox.me${path}`, {
          method: 'POST', headers: { Authorization: `QBox ${qboxToken(`${path}\n`)}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        });
        if (!response.ok && response.status !== 612) await requireSuccess(response, '删除');
      }
    },
  };
}
