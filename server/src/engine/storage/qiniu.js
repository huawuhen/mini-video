// Source: chaodayun@2926b42 storage/qiniu-kodo.js + backend/object-storage.js（适配：
//   S3 SDK → 七牛原生协议（PUT 上传 / RS 删除 / 私有下载签名），零第三方依赖，只用 node:crypto + fetch；
//   私有签名链接支持 download 附 attachment 文件名。HTTP 实现可注入，测试不访问外网。
//   协议签名按七牛官方文档实现；真实桶联调在 M2（当前仅单测签名形状与请求拼装））。
import { createHmac } from 'node:crypto';
import { streamToBuffer } from './memory.js';

export class StorageError extends Error {
  constructor(message, { code = 'STORAGE_FAILED', status } = {}) {
    super(message);
    this.name = 'StorageError';
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

const urlsafeBase64 = (value) => Buffer.from(value).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
const hmacSha1 = (secret, data) => createHmac('sha1', secret).update(data).digest();

/** URL 编码 key，保留路径斜杠。 */
const encodeKey = (key) => key.split('/').map(encodeURIComponent).join('/');

export function createQiniuStorage(
  { accessKey, secretKey, bucket, domain, region = 'z0' },
  { defaultTtlSeconds = 3600, fetchImpl = globalThis.fetch, now = () => Date.now() } = {},
) {
  if (!accessKey || !secretKey || !bucket || !domain) {
    throw new StorageError('七牛存储配置不完整（QINIU_ACCESS_KEY / SECRET_KEY / BUCKET / DOMAIN）', { code: 'STORAGE_CONFIG_MISSING' });
  }
  const uploadHost = `https://up-${region}.qiniup.com`;
  const rsHost = 'https://rs.qbox.me';
  const downloadBase = domain.startsWith('http') ? domain.replace(/\/$/, '') : `https://${domain}`;

  const qboxToken = (signStr) => `${accessKey}:${urlsafeBase64(hmacSha1(secretKey, signStr))}`;

  return {
    driver: 'qiniu',
    /** put(key, stream|buffer, { contentType })：七牛 PUT 方式直传（signStr = path + '\n' + body）。 */
    async put(key, body, { contentType = 'application/octet-stream' } = {}) {
      const data = await streamToBuffer(body);
      const path = `/put/${urlsafeBase64(`${bucket}:${key}`)}/`;
      const res = await fetchImpl(`${uploadHost}${path}`, {
        method: 'PUT',
        headers: {
          Authorization: `QBox ${qboxToken(`${path}\n${data.toString('binary')}`)}`,
          'Content-Type': contentType,
          'Content-Length': String(data.length),
        },
        body: data,
      });
      if (!res.ok) {
        throw new StorageError(`七牛上传失败（HTTP ${res.status}）：${(await res.text().catch(() => '')).slice(0, 200)}`, { status: res.status });
      }
      return { key, size: data.length, contentType };
    },
    /** signedUrl(key, { ttlSeconds, download })：私有空间下载签名；download 时附 attachment 文件名。 */
    signedUrl(key, { ttlSeconds, download } = {}) {
      const deadline = Math.floor(now() / 1000) + Math.max(1, ttlSeconds ?? defaultTtlSeconds);
      const url = `${downloadBase}/${encodeKey(key)}?e=${deadline}`;
      const token = qboxToken(url);
      let signed = `${url}&token=${token}`;
      if (download) {
        const filename = download === true ? key.split('/').at(-1) : String(download);
        signed += `&attachment=${encodeURIComponent(filename)}`;
      }
      return signed;
    },
    /** remove(keys)：逐个调 RS 删除接口（对象不存在视为已删除）。 */
    async remove(keys) {
      for (const key of keys) {
        const path = `/delete/${urlsafeBase64(`${bucket}:${key}`)}`;
        const res = await fetchImpl(`${rsHost}${path}`, {
          method: 'POST',
          headers: { Authorization: `QBox ${qboxToken(`${path}\n`)}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        });
        if (!res.ok && res.status !== 612) { // 612 = 文件不存在，幂等
          throw new StorageError(`七牛删除失败（HTTP ${res.status}）：${(await res.text().catch(() => '')).slice(0, 200)}`, { status: res.status });
        }
      }
    },
  };
}
