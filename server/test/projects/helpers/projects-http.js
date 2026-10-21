// 片段链 HTTP 测试用：对象在内存，signedUrl 返回 https 链接（与七牛驱动形态一致）。
import { createMemoryStorage } from '../../../src/engine/storage/memory.js';

export function httpMemoryStorage() {
  const memory = createMemoryStorage();
  const removed = [];
  return {
    put: memory.put,
    remove: async (keys) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) removed.push(key);
      return memory.remove(keys);
    },
    async signedUrl(key, { ttlSeconds = 3600, download } = {}) {
      const attname = download ? `attname=${encodeURIComponent(String(download))}&` : '';
      return `https://signed.example/${key}?${attname}ttl=${ttlSeconds}`;
    },
    removed,
  };
}
