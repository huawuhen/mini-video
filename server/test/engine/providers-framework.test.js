// 驱动框架测试：注册表扫描与形状校验、共用 HTTP 层的地址校验（M2-BE-03）。
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { loadDriverRegistry, createDriverRegistry } from '../../src/engine/providers/registry.js';
import { assertDriverExport, ProviderError } from '../../src/engine/providers/contract.js';
import { createChannelHttp, parseBaseUrl } from '../../src/engine/providers/transport.js';

describe('驱动注册表（扫描 + 形状校验）', () => {
  let registry;
  before(async () => { registry = await loadDriverRegistry(); });

  test('扫描到全部 6 个驱动且形状合法（含 M2-WEB-01 的 local-mock，devOnly）', () => {
    const ids = registry.list().map((driver) => driver.id).sort();
    assert.deepEqual(ids, ['aiide-ark', 'local-mock', 'openai-compatible', 'openai-image-tasks', 'openai-images', 'openai-videos']);
    assert.equal(registry.get('local-mock').devOnly, true); // 生产环境拒绝注册（行为见 local-mock/driver.test）
    for (const meta of registry.list()) {
      assert.ok(Array.isArray(meta.kinds) && meta.kinds.length); // list() 只给表单元数据
      const driver = registry.get(meta.id);
      assert.ok(driver.configSchema && typeof driver.create === 'function');
    }
  });

  test('每个驱动 create 出的实例通过契约形状校验（假渠道 + 注入 fetch）', async () => {
    const scriptedFetch = async () => ({ status: 200, ok: true, headers: { get: () => null }, text: async () => '{}' });
    const channels = [
      { id: 'pch_t1', kind: 'video', name: 't', driver: 'aiide-ark', baseUrl: 'https://a.example.test',
        credential: 'sk-x', modelMap: { video: 'm1' }, params: {} },
      { id: 'pch_t2', kind: 'image', name: 't', driver: 'openai-images', baseUrl: 'https://a.example.test',
        credential: 'sk-x', modelMap: { image: 'm2' }, params: {} },
      { id: 'pch_t3', kind: 'llm', name: 't', driver: 'openai-compatible', baseUrl: 'https://a.example.test',
        credential: 'sk-x', modelMap: { llm: 'm3' }, params: {} },
    ];
    for (const channel of channels) {
      const instance = registry.create(channel, { deps: { fetchImpl: scriptedFetch,
        loadReference: async () => ({ buffer: Buffer.from('x'), contentType: 'image/png' }),
        downloadImage: async () => ({ buffer: Buffer.from('x'), contentType: 'image/png' }) } });
      assert.ok(typeof instance.id === 'string');
      assert.equal(typeof instance.capabilities(), 'object');
    }
  });

  test('驱动不存在 / kind 不匹配 → 明确报错', () => {
    assert.throws(() => registry.get('no-such-driver'), (error) => error.code === 'DRIVER_NOT_FOUND');
    assert.throws(() => registry.create({ id: 'x', kind: 'video', name: 'x', driver: 'openai-images',
      baseUrl: 'https://a.example.test', credential: 'sk-x', modelMap: {}, params: {} }, {}),
      /不支持 video/);
  });
});

describe('驱动导出形状校验（assertDriverExport）', () => {
  test('id 必须等于目录名、kinds 合法、create 必须是函数', () => {
    const good = { id: 'demo', kinds: ['video'], configSchema: {}, create() { return {}; } };
    assert.doesNotThrow(() => assertDriverExport(good, 'demo'));
    assert.throws(() => assertDriverExport({ ...good, id: 'other' }, 'demo'), /等于目录名/);
    assert.throws(() => assertDriverExport({ ...good, kinds: ['sms'] }), /kinds/);
    assert.throws(() => assertDriverExport({ ...good, create: null }), /create/);
  });

  test('单个驱动目录损坏不拖垮扫描（跳过并记日志）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'miv-drivers-'));
    try {
      mkdirSync(join(dir, 'good-driver'));
      writeFileSync(join(dir, 'good-driver', 'index.js'),
        'export default { id: "good-driver", kinds: ["video"], configSchema: {}, create: () => ({ id: "x", capabilities: () => ({ model: "m" }), prepare() {}, submit() {}, query() {}, normalize(r) { return r; } }) };');
      mkdirSync(join(dir, 'bad-driver'));
      writeFileSync(join(dir, 'bad-driver', 'index.js'), 'export default { id: "wrong" };'); // 形状不合法
      mkdirSync(join(dir, 'not-a-driver')); // 无 index.js：跳过
      const logs = [];
      const registry = await loadDriverRegistry({
        dir, logger: { error: (event, fields) => logs.push({ event, fields }) },
      });
      assert.ok(registry.has('good-driver'));
      assert.ok(!registry.has('bad-driver'));
      assert.equal(logs.filter((entry) => entry.event === 'driver_load_failed').length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('共用 HTTP 层（createChannelHttp）', () => {
  test('渠道地址校验：非 http(s)、带用户名密码、缺凭证', () => {
    assert.throws(() => parseBaseUrl('ftp://a.example.test'), ProviderError);
    assert.throws(() => parseBaseUrl('https://user:pw@a.example.test'), ProviderError);
    assert.throws(() => createChannelHttp({ baseUrl: 'https://a.example.test' }), ProviderError);
    assert.throws(() => createChannelHttp({ baseUrl: 'https://a.example.test', credential: '' }), ProviderError);
  });

  test('路径越出渠道 origin 被拒（防 SSRF 式跳转）', async () => {
    const http = createChannelHttp({ baseUrl: 'https://a.example.test', credential: 'sk-x' });
    await assert.rejects(http.request('https://b.example.test/v1'), /越出渠道地址/);
  });

  test('请求路径带基址路径段时按相对解析', async () => {
    const seen = [];
    const http = createChannelHttp({
      baseUrl: 'https://llm.example.test/api/paas/v4', credential: 'sk-x',
      fetchImpl: async (url) => { seen.push(String(url)); return { status: 200, ok: true, headers: { get: () => null }, text: async () => '{}' }; },
    });
    await http.request('chat/completions', { method: 'POST', body: {} });
    assert.equal(seen[0], 'https://llm.example.test/api/paas/v4/chat/completions');
  });

  test('网络错误分类：连接类 → 未提交可重试；其余 → 结果不确定', async () => {
    const http = createChannelHttp({
      baseUrl: 'https://a.example.test', credential: 'sk-x',
      fetchImpl: async () => { const error = new Error('refused'); error.code = 'ECONNREFUSED'; throw error; },
    });
    await assert.rejects(http.request('/v1/x'), (error) => error.submitted === false && error.retryable === true);

    const http2 = createChannelHttp({
      baseUrl: 'https://a.example.test', credential: 'sk-x',
      fetchImpl: async () => { const error = new Error('reset'); error.code = 'ECONNRESET'; throw error; },
    });
    await assert.rejects(http2.request('/v1/x', { method: 'POST' }), (error) => error.code === 'SUBMISSION_UNKNOWN' && error.submitted === true);
    await assert.rejects(http2.request('/v1/x'), (error) => error.code === 'SUBMISSION_UNKNOWN');
  });

  test('createDriverRegistry 空表：get 报 DRIVER_NOT_FOUND', () => {
    const empty = createDriverRegistry(new Map());
    assert.throws(() => empty.get('any'), (error) => error.code === 'DRIVER_NOT_FOUND');
  });
});
