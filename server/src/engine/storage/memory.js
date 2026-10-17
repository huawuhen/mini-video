// 内存对象存储：接口与七牛实现一致（put / signedUrl / remove），供开发与测试。
// 原置于 src/queue/cron.js（M1-BE-03），M1-ENG-03 按 §6 要点 c 迁入 engine/storage（跨所有权改动已获 Lead 批准）。

/** 把 Buffer | Node Readable | web ReadableStream 收敛成 Buffer。 */
export async function streamToBuffer(body) {
  if (Buffer.isBuffer(body)) return body;
  const chunks = [];
  for await (const chunk of body) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

export function createMemoryStorage() {
  const objects = new Map();
  return {
    async put(key, body, { contentType } = {}) {
      const buffer = await streamToBuffer(body);
      objects.set(key, { buffer, contentType });
    },
    async signedUrl(key, _opts = {}) { return `memory://${key}`; },
    async remove(keys) { for (const key of keys) objects.delete(key); },
  };
}
