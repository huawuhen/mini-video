import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { describe, test } from 'node:test';
import { createTransfer } from '../../src/engine/transfer/index.js';
import { createMemoryStorage } from '../../src/engine/storage/memory.js';

describe('engine/transfer（M1-ENG-03）', () => {
  test('经 safeFetch 下载并流式写入存储；contentType 回退与转发', async () => {
    const memory = createMemoryStorage();
    const puts = [];
    const storage = {
      async put(key, body, opts) {
        puts.push({ key, opts });
        const chunks = [];
        for await (const chunk of body) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        return memory.put(key, Buffer.concat(chunks), opts);
      },
      async signedUrl(key) { return memory.signedUrl(key); },
      async remove(keys) { return memory.remove(keys); },
    };
    const safeFetchCalls = [];
    const safeFetch = async (url, opts) => {
      safeFetchCalls.push({ url, opts });
      return {
        status: 200,
        contentType: 'video/mp4',
        stream: Readable.from([Buffer.from('part1'), Buffer.from('part2')]),
      };
    };
    const transferFromUrl = createTransfer({ safeFetch, storage });

    const result = await transferFromUrl('https://upstream.example/video.mp4', 'users/u1/renders/r1.mp4', { maxBytes: 1024, timeoutMs: 5000 });
    assert.deepEqual(result, { key: 'users/u1/renders/r1.mp4', contentType: 'video/mp4' });
    assert.deepEqual(safeFetchCalls[0], { url: 'https://upstream.example/video.mp4', opts: { maxBytes: 1024, timeoutMs: 5000 } });
    assert.deepEqual(puts[0].opts, { contentType: 'video/mp4' });
    assert.equal(await memory.signedUrl('users/u1/renders/r1.mp4'), 'memory://users/u1/renders/r1.mp4');

    // 上游没给 contentType 时回退 application/octet-stream
    const fallback = createTransfer({
      safeFetch: async () => ({ status: 200, contentType: '', stream: Readable.from([Buffer.from('x')]) }),
      storage,
    });
    const result2 = await fallback('https://upstream.example/a.bin', 'k2', {});
    assert.equal(result2.contentType, 'application/octet-stream');
  });

  test('put 失败：错误上抛并中断下载流', async () => {
    let destroyed = false;
    const storage = {
      async put() { throw new Error('存储写不进去了'); },
    };
    const safeFetch = async () => ({
      status: 200,
      contentType: '',
      stream: Readable.from([Buffer.from('x')], { destroy(err) { destroyed = true; return err; } }),
    });
    const transferFromUrl = createTransfer({ safeFetch, storage });
    await assert.rejects(
      () => transferFromUrl('https://upstream.example/a.bin', 'k', { maxBytes: 10, timeoutMs: 1000 }),
      /存储写不进去了/,
    );
    assert.equal(destroyed, true, 'put 失败后应销毁下载流');
  });
});
