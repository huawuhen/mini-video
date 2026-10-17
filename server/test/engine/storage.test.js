import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { describe, test } from 'node:test';
import { createMemoryStorage } from '../../src/engine/storage/memory.js';
import { createQiniuStorage } from '../../src/engine/storage/qiniu.js';
import { createStorageFromConfig } from '../../src/engine/storage/index.js';

const CONF = { accessKey: 'test-ak', secretKey: 'test-sk', bucket: 'miv-bucket', domain: 'cdn.example.com', region: 'z0' };
const now = () => 1_700_000_000_000;
const POLICY = 'eyJzY29wZSI6Im1pdi1idWNrZXQ6dXNlcnMvdXNyXzEvdXBsb2Fkcy94LnBuZyIsImRlYWRsaW5lIjoxNzAwMDAzNjAwfQ==';
const UPLOAD_TOKEN = `test-ak:3wEamaosjw5ZhYkFwayM4FisO0w=:${POLICY}`;

const ok = (data = {}) => ({ ok: true, status: 200, json: async () => data, text: async () => '' });

// These are fixed HMAC-SHA1 answer vectors for test-ak/test-sk at 1700000000 seconds,
// independently calculated from the Qiniu upload policy and QBox management string-to-sign.
describe('engine/storage（M1-ENG-03）', () => {
  test('私有下载：attname、e 在 token 之前且均参与签名', () => {
    const storage = createQiniuStorage(CONF, { now });
    assert.equal(storage.signedUrl('users/usr_1/looks/lkv_1.png'),
      'https://cdn.example.com/users/usr_1/looks/lkv_1.png?e=1700003600&token=test-ak:iTdWS1LLJ939LBDg2R6yQqSDV4w=');
    assert.equal(storage.signedUrl('a/b/c.mp4', { download: '我的成片.mp4' }),
      'https://cdn.example.com/a/b/c.mp4?attname=%E6%88%91%E7%9A%84%E6%88%90%E7%89%87.mp4&e=1700003600&token=test-ak:BYBwilT2W7J4SMgIxT0XzmC1des=');
    assert.match(storage.signedUrl('a/b/c.mp4', { download: true }), /\?attname=c\.mp4&e=1700003600&token=test-ak:[^&]+$/);
  });

  test('≤8MB 表单上传：上传凭证已知答案，token/key/file 字段与区域域名', async () => {
    const calls = [];
    const storage = createQiniuStorage(CONF, { now, fetchImpl: async (url, init) => { calls.push({ url, init }); return ok(); } });
    const data = Buffer.from('binary-content');
    assert.deepEqual(await storage.put('users/usr_1/uploads/x.png', data, { contentType: 'image/png' }),
      { key: 'users/usr_1/uploads/x.png', size: data.length, contentType: 'image/png' });
    assert.equal(calls[0].url, 'https://up-z0.qiniup.com/');
    assert.equal(calls[0].init.method, 'POST');
    assert.match(calls[0].init.headers['Content-Type'], /^multipart\/form-data; boundary=miv-/);
    assert.ok(!calls[0].init.headers.Authorization, '表单上传用上传凭证，不用管理凭证');
    const body = calls[0].init.body.toString();
    assert.match(body, /name="token"\r\n\r\ntest-ak:3wEamaosjw5ZhYkFwayM4FisO0w=/);
    assert.ok(body.includes(UPLOAD_TOKEN));
    assert.match(body, /name="key"\r\n\r\nusers\/usr_1\/uploads\/x\.png/);
    assert.match(body, /name="file"; filename="upload"/);
    assert.ok(calls[0].init.body.includes(data));
    const policy = JSON.parse(Buffer.from(POLICY.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
    assert.deepEqual(policy, { scope: 'miv-bucket:users/usr_1/uploads/x.png', deadline: 1700003600 });
    const smallStream = await storage.put('users/usr_1/uploads/x.png', Readable.from([data]), { contentType: 'image/png' });
    assert.equal(smallStream.size, data.length);
    assert.equal(calls[1].init.method, 'POST');
    assert.equal(calls[1].url, 'https://up-z0.qiniup.com/');
    const failed = createQiniuStorage(CONF, { fetchImpl: async () => ({ ok: false, status: 571, text: async () => 'denied' }) });
    await assert.rejects(() => failed.put('k', Buffer.from('x')), /七牛表单上传失败/);
  });

  test('分片上传 v2：路径仅编码对象名，按序上传分片并以服务端 etag 完成', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith('/uploads')) return ok({ uploadId: 'upload-test-1' });
      if (init.method === 'PUT') return ok({ etag: `etag-${calls.filter((call) => call.init.method === 'PUT').length}` });
      return ok({ key: 'large.mp4', hash: 'hash' });
    };
    const storage = createQiniuStorage(CONF, { now, fetchImpl });
    const input = Buffer.alloc(9 * 1024 * 1024, 0x61);
    const result = await storage.put('users/u1/large.mp4', Readable.from([input]), { contentType: 'video/mp4' });
    assert.equal(result.size, input.length);
    const prefix = 'https://up-z0.qiniup.com/buckets/miv-bucket/objects/dXNlcnMvdTEvbGFyZ2UubXA0/uploads';
    assert.deepEqual(calls.map(({ url, init }) => [init.method, url]), [
      ['POST', prefix], ['PUT', `${prefix}/upload-test-1/1`], ['PUT', `${prefix}/upload-test-1/2`],
      ['PUT', `${prefix}/upload-test-1/3`], ['POST', `${prefix}/upload-test-1`],
    ]);
    for (const call of calls) assert.match(call.init.headers.Authorization, /^UpToken test-ak:/);
    assert.deepEqual(calls.filter((call) => call.init.method === 'PUT').map((call) => call.init.headers['Content-Length']),
      [String(4 * 1024 * 1024), String(4 * 1024 * 1024), String(1024 * 1024)]);
    assert.equal(calls[1].init.headers['Content-Type'], 'application/octet-stream');
    assert.deepEqual(JSON.parse(calls[4].init.body), {
      parts: [{ partNumber: 1, etag: 'etag-1' }, { partNumber: 2, etag: 'etag-2' },
        { partNumber: 3, etag: 'etag-3' }], mimeType: 'video/mp4',
    });
  });

  test('分片失败会 abort，不会 complete；本地流输入不整件缓冲', async () => {
    const calls = [];
    const storage = createQiniuStorage(CONF, { now, fetchImpl: async (url, init) => {
      calls.push(init.method);
      if (url.endsWith('/uploads')) return ok({ uploadId: 'bad' });
      if (init.method === 'PUT') return { ok: false, status: 500, text: async () => 'part failed' };
      return ok();
    } });
    await assert.rejects(() => storage.put('huge.mp4', Readable.from([Buffer.alloc(9 * 1024 * 1024)])), /第 1 片上传失败/);
    assert.deepEqual(calls, ['POST', 'PUT', 'DELETE']);
  });

  test('分片完成阶段失败同样中止 uploadId', async () => {
    const calls = [];
    const storage = createQiniuStorage(CONF, { now, fetchImpl: async (url, init) => {
      calls.push([init.method, url]);
      if (url.endsWith('/uploads')) return ok({ uploadId: 'complete-fail' });
      if (init.method === 'PUT') return ok({ etag: 'etag-1' });
      if (init.method === 'DELETE') return ok();
      return { ok: false, status: 500, text: async () => 'complete failed' };
    } });
    await assert.rejects(() => storage.put('large.mp4', Buffer.alloc(9 * 1024 * 1024)), /分片完成失败/);
    assert.deepEqual(calls.map(([method]) => method), ['POST', 'PUT', 'PUT', 'PUT', 'POST', 'DELETE']);
    assert.equal(calls.at(-1)[1], calls.at(-2)[1]);
  });

  test('管理凭证 QBox 已知答案、删除 612 幂等', async () => {
    const calls = [];
    const storage = createQiniuStorage(CONF, { fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return { ok: false, status: 612 };
    } });
    await storage.remove(['a/b.png']);
    assert.equal(calls[0].url, 'https://rs.qbox.me/delete/bWl2LWJ1Y2tldDphL2IucG5n');
    assert.equal(calls[0].init.headers.Authorization, 'QBox test-ak:siM37Ksj0AmVBxRjsf6RAdtwlu8=');
  });

  test('配置和内存接口', async () => {
    assert.throws(() => createQiniuStorage({ accessKey: '', secretKey: '', bucket: '', domain: '' }), /配置不完整/);
    const memory = createMemoryStorage();
    await memory.put('a.png', Buffer.from('abc'));
    await memory.put('b.mp4', Readable.from([Buffer.from('v'), Buffer.from('ideo')]));
    assert.equal(await memory.signedUrl('a.png'), 'memory://a.png');
    await memory.remove(['a.png', 'a.png', 'b.mp4']);
    assert.equal(typeof createStorageFromConfig({ production: false,
      storage: { driver: 'memory', qiniu: CONF, signedUrlTtlSeconds: 60 } }).put, 'function');
    assert.throws(() => createStorageFromConfig({ production: true,
      storage: { driver: 'memory', qiniu: CONF, signedUrlTtlSeconds: 60 } }), /qiniu/);
    assert.equal(typeof createStorageFromConfig({ production: true,
      storage: { driver: 'qiniu', qiniu: CONF, signedUrlTtlSeconds: 60 } }).put, 'function');
  });
});
