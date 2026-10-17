import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { Readable } from 'node:stream';
import { describe, test } from 'node:test';
import { createMemoryStorage } from '../../src/engine/storage/memory.js';
import { createQiniuStorage } from '../../src/engine/storage/qiniu.js';
import { createStorageFromConfig } from '../../src/engine/storage/index.js';

const CONF = { accessKey: 'test-ak', secretKey: 'test-sk', bucket: 'miv-bucket', domain: 'cdn.example.com', region: 'z0' };
const urlsafeBase64 = (value) => Buffer.from(value).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
const expectedToken = (secret, signStr) => `test-ak:${urlsafeBase64(createHmac('sha1', secret).update(signStr).digest())}`;

describe('engine/storage（M1-ENG-03）', () => {
  test('七牛 signedUrl：私有下载签名与 attachment 文件名', () => {
    const now = () => 1_700_000_000_000;
    const storage = createQiniuStorage(CONF, { defaultTtlSeconds: 3600, now });
    const url = storage.signedUrl('users/usr_1/looks/lkv_1.png');
    assert.equal(url, `https://cdn.example.com/users/usr_1/looks/lkv_1.png?e=1700003600&token=${expectedToken('test-sk', `https://cdn.example.com/users/usr_1/looks/lkv_1.png?e=1700003600`)}`);
    const download = storage.signedUrl('users/usr_1/looks/lkv_1.png', { download: true });
    assert.ok(download.endsWith('&attachment=lkv_1.png'), download);
    const named = storage.signedUrl('a/b/c.mp4', { download: '我的成片.mp4' });
    assert.ok(named.endsWith(`&attachment=${encodeURIComponent('我的成片.mp4')}`), named);
  });

  test('七牛 put：请求拼装与 QBox 签名；失败抛 StorageError', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 200, text: async () => '' };
    };
    const storage = createQiniuStorage(CONF, { fetchImpl });
    const data = Buffer.from('binary-content');
    const result = await storage.put('users/usr_1/uploads/x.png', data, { contentType: 'image/png' });
    assert.equal(result.key, 'users/usr_1/uploads/x.png');

    const call = calls[0];
    const path = `/put/${urlsafeBase64('miv-bucket:users/usr_1/uploads/x.png')}/`;
    assert.equal(call.url, `https://up-z0.qiniup.com${path}`);
    assert.equal(call.init.method, 'PUT');
    assert.equal(call.init.headers.Authorization, `QBox ${expectedToken('test-sk', `${path}\n${data.toString('binary')}`)}`);
    assert.equal(call.init.headers['Content-Type'], 'image/png');

    const failing = createQiniuStorage(CONF, { fetchImpl: async () => ({ ok: false, status: 571, text: async () => 'denied' }) });
    await assert.rejects(() => failing.put('k', Buffer.from('x')), /七牛上传失败/);
  });

  test('七牛 remove：删除请求签名；612 视为已删除幂等', async () => {
    const calls = [];
    const storage = createQiniuStorage(CONF, {
      fetchImpl: async (url, init) => {
        calls.push({ url, init, status: calls.length });
        return { ok: calls.length === 0, status: calls.length === 0 ? 200 : 612, text: async () => '' };
      },
    });
    await storage.remove(['a/b.png', 'a/gone.png']);
    assert.equal(calls.length, 2);
    const path = `/delete/${urlsafeBase64('miv-bucket:a/b.png')}`;
    assert.equal(calls[0].url, `https://rs.qbox.me${path}`);
    assert.equal(calls[0].init.headers.Authorization, `QBox ${expectedToken('test-sk', `${path}\n`)}`);
  });

  test('七牛配置不完整启动报错', () => {
    assert.throws(() => createQiniuStorage({ accessKey: '', secretKey: '', bucket: '', domain: '' }), /配置不完整/);
  });

  test('memory 实现：buffer 与流式 put、signedUrl、remove 幂等', async () => {
    const storage = createMemoryStorage();
    await storage.put('a.png', Buffer.from('abc'), { contentType: 'image/png' });
    await storage.put('b.mp4', Readable.from([Buffer.from('v'), Buffer.from('ideo')]));
    assert.equal(await storage.signedUrl('a.png'), 'memory://a.png');
    await storage.remove(['a.png', 'a.png']);
    await storage.remove(['b.mp4']);
  });

  test('createStorageFromConfig：按 driver 选择，生产强制 qiniu 且配置完整', () => {
    const memoryConfig = { production: false, storage: { driver: 'memory', qiniu: CONF, signedUrlTtlSeconds: 60 } };
    assert.equal(typeof createStorageFromConfig(memoryConfig).put, 'function');

    const prodMemory = { production: true, storage: { driver: 'memory', qiniu: CONF, signedUrlTtlSeconds: 60 } };
    assert.throws(() => createStorageFromConfig(prodMemory), /qiniu/);

    const prodQiniuMissing = { production: true, storage: { driver: 'qiniu', qiniu: { accessKey: '', secretKey: '', bucket: '', domain: '' }, signedUrlTtlSeconds: 60 } };
    assert.throws(() => createStorageFromConfig(prodQiniuMissing), /配置不完整/);

    const prodQiniu = { production: true, storage: { driver: 'qiniu', qiniu: CONF, signedUrlTtlSeconds: 60 } };
    assert.equal(typeof createStorageFromConfig(prodQiniu).put, 'function');
  });
});
