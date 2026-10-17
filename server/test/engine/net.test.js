import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { describe, test } from 'node:test';
import { createSafeFetch, isPublicAddress } from '../../src/engine/net/index.js';

/** 假响应：真 Readable（有 on/resume/pipe/destroy）+ statusCode/headers。 */
function fakeResponse(status, headers = {}, chunks = []) {
  const stream = Readable.from(chunks);
  stream.statusCode = status;
  stream.headers = headers;
  return stream;
}

/** 永不结束但可销毁的响应流（超时测试用）。 */
function neverEndingResponse(status = 200) {
  const stream = new Readable({ read() {} });
  stream.push(Buffer.from('start'));
  stream.statusCode = status;
  stream.headers = {};
  return stream;
}

const expectCode = (code) => (err) => err.code === code;
const PUBLIC_IP = [{ address: '93.184.216.34', family: 4 }];
const okResolver = async () => PUBLIC_IP;

describe('engine/net（M1-ENG-03）', () => {
  test('isPublicAddress：私网/回环/链路本地/元数据/映射地址全部拒绝', () => {
    for (const ip of ['10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '127.0.0.1', '0.0.0.0',
      '169.254.169.254', '100.64.0.1', '224.0.0.1', '198.18.0.1', '::1', 'fe80::1', 'fc00::1',
      '::ffff:10.0.0.1', '::ffff:169.254.169.254', 'fd00::1', '2001:db8::1', '2001::1', '0:0:0:0:0:0:0:1']) {
      assert.equal(isPublicAddress(ip), false, ip);
    }
    for (const ip of ['93.184.216.34', '1.1.1.1', '2606:4700::1111', '2001:4860:4860::8888']) {
      assert.equal(isPublicAddress(ip), true, ip);
    }
  });

  test('URL 与协议校验：非 http(s)、带凭证、内网主机名一律拒绝', async () => {
    const safeFetch = createSafeFetch({ resolver: okResolver });
    for (const url of ['ftp://example.com/x', 'https://user:pass@example.com/x', 'http://localhost/x',
      'http://127.0.0.1/x', 'http://169.254.169.254/meta', 'http://10.0.0.1/x', 'http://[::1]/x',
      'http://[::ffff:10.0.0.1]/x', 'http://api.internal/x']) {
      await assert.rejects(() => safeFetch(url), (err) => {
        assert.ok(['REMOTE_URL_INVALID', 'REMOTE_ADDRESS_BLOCKED'].includes(err.code), `${url} → ${err.code}`);
        return true;
      }, url);
    }
  });

  test('DNS 解析到私网地址 → REMOTE_ADDRESS_BLOCKED', async () => {
    const safeFetch = createSafeFetch({ resolver: async () => [{ address: '192.168.0.9', family: 4 }] });
    await assert.rejects(() => safeFetch('https://example.com/file'), expectCode('REMOTE_ADDRESS_BLOCKED'));
    const safeFetchEmpty = createSafeFetch({ resolver: async () => [] });
    await assert.rejects(() => safeFetchEmpty('https://example.com/file'), expectCode('REMOTE_ADDRESS_BLOCKED'));
  });

  test('成功下载：DNS 钉定 IP、内容与 Content-Type 正确', async () => {
    const seen = [];
    const safeFetch = createSafeFetch({
      resolver: async (hostname) => {
        seen.push(hostname);
        return PUBLIC_IP;
      },
      httpImpl: async ({ url, pinned }) => {
        assert.equal(pinned[0].address, '93.184.216.34', '连接必须钉定到已验证 IP');
        assert.equal(url.hostname, 'example.com');
        return fakeResponse(200, { 'content-type': 'video/mp4' }, [Buffer.from('hello '), Buffer.from('world')]);
      },
    });
    const remote = await safeFetch('https://example.com/file.mp4');
    assert.equal(remote.status, 200);
    assert.equal(remote.contentType, 'video/mp4');
    const chunks = [];
    for await (const chunk of remote.stream) chunks.push(chunk);
    assert.equal(Buffer.concat(chunks).toString(), 'hello world');
    assert.deepEqual(seen, ['example.com']);
  });

  test('重定向：逐跳复验（私网目标被拒）、超过 3 次拒绝', async () => {
    const blocked = createSafeFetch({
      resolver: async (hostname) => (hostname === 'redirect.example' ? PUBLIC_IP : [{ address: '10.9.9.9', family: 4 }]),
      httpImpl: async () => fakeResponse(302, { location: 'https://private.example/file' }),
    });
    await assert.rejects(() => blocked('https://redirect.example/a'), expectCode('REMOTE_ADDRESS_BLOCKED'));

    let hop = 0;
    const chain = createSafeFetch({
      resolver: okResolver,
      httpImpl: async () => { hop += 1; return fakeResponse(302, { location: `https://hop${hop}.example/x` }); },
    });
    await assert.rejects(() => chain('https://start.example/a'), expectCode('REMOTE_REDIRECT_LIMIT'));

    const good = createSafeFetch({
      resolver: okResolver,
      httpImpl: async ({ url }) => (url.pathname === '/a'
        ? fakeResponse(302, { location: '/real-file' })
        : fakeResponse(200, { 'content-type': 'application/octet-stream' }, [Buffer.from('final')])),
    });
    const remote = await good('https://start.example/a');
    const chunks = [];
    for await (const chunk of remote.stream) chunks.push(chunk);
    assert.equal(Buffer.concat(chunks).toString(), 'final');
  });

  test('maxBytes：Content-Length 预检拒绝；流式超限中断', async () => {
    const declared = createSafeFetch({
      resolver: okResolver,
      httpImpl: async () => fakeResponse(200, { 'content-length': '1000' }, [Buffer.alloc(10)]),
    });
    await assert.rejects(() => declared('https://example.com/big', { maxBytes: 10 }), expectCode('REMOTE_TOO_LARGE'));

    const streamed = createSafeFetch({
      resolver: okResolver,
      httpImpl: async () => fakeResponse(200, {}, [Buffer.alloc(6), Buffer.alloc(6)]),
    });
    const remote = await streamed('https://example.com/big', { maxBytes: 10 });
    await assert.rejects(async () => {
      for await (const chunk of remote.stream) chunk; // eslint-disable-line no-unused-vars
    }, expectCode('REMOTE_TOO_LARGE'));
  });

  test('超时：响应流长时间不结束 → REMOTE_TIMEOUT 销毁流', async () => {
    const safeFetch = createSafeFetch({
      resolver: okResolver,
      httpImpl: async () => neverEndingResponse(),
    });
    const remote = await safeFetch('https://example.com/slow', { timeoutMs: 50 });
    await assert.rejects(async () => {
      for await (const chunk of remote.stream) chunk; // eslint-disable-line no-unused-vars
    }, expectCode('REMOTE_TIMEOUT'));
  });

  test('HTTP 4xx/5xx → REMOTE_HTTP_ERROR', async () => {
    const safeFetch = createSafeFetch({
      resolver: okResolver,
      httpImpl: async () => fakeResponse(404, {}, [Buffer.from('nope')]),
    });
    await assert.rejects(() => safeFetch('https://example.com/missing'), expectCode('REMOTE_HTTP_ERROR'));
  });
});
