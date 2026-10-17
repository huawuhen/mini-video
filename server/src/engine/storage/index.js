// 存储入口（engine/README：createStorage(config) → { put, signedUrl, remove }；memory 实现 + 七牛 Kodo 实现）。
// createStorageFromConfig 按 config.storage.driver 选择实现；生产必须为 qiniu 且配置完整。
import { createMemoryStorage } from './memory.js';
import { createQiniuStorage, StorageError } from './qiniu.js';

export { createMemoryStorage, StorageError };

export function createStorageFromConfig(config) {
  const { driver, qiniu, signedUrlTtlSeconds } = config.storage;
  if (driver === 'qiniu') return createQiniuStorage(qiniu, { defaultTtlSeconds: signedUrlTtlSeconds });
  if (config.production) throw new Error('生产环境 STORAGE_DRIVER 必须为 qiniu（并配置 QINIU_ACCESS_KEY / SECRET_KEY / BUCKET / DOMAIN）');
  return createMemoryStorage();
}
