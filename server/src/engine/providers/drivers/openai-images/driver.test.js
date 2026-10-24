// openai-images 驱动测试：共用契约套件 + 特有场景（网关 524/504 自动重试 ≤2、edits 分支、
// 分辨率映射、参考照片裁剪、URL 结果下载重试）。
import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import driver, { sizeFor } from './index.js';
import { runImageDriverContract, contractChannel, createScriptedFetch, consoleCapture } from '../../contract-test.js';

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

const channel = contractChannel({
  kind: 'image', driver: 'openai-images',
  modelMap: { image: 'gpt-image-2' },
  params: { requestTimeoutMs: 300, gatewayRetryMax: 2 },
});

const build = ({ fetchImpl, logger, deps = {} }) => driver.create(channel, {
  logger, deps: {
    fetchImpl,
    loadReference: deps.loadReference ?? (async () => ({ buffer: TINY_PNG, contentType: 'image/png' })),
    downloadImage: deps.downloadImage ?? (async () => ({ buffer: TINY_PNG, contentType: 'image/png' })),
  },
});

runImageDriverContract({
  title: 'openai-images 契约',
  build,
  fixtures: {
    generateAccepted: fixture('generate-accepted.json'),
    generateRejected: fixture('generate-rejected.json'),
  },
});

// ───────── 本驱动特有场景 ─────────

test('openai-images：网关 524 自动重试（≤2 次）后成功，attempts=2，用户只计费一次口径', async () => {
  const scripted = createScriptedFetch([
    { match: '', method: 'POST', status: 524, json: fixture('generate-gateway-timeout.json') },
    { match: '', method: 'POST', status: 200, json: fixture('generate-accepted.json') },
  ]);
  const instance = build({ fetchImpl: scripted.fetchImpl, logger: consoleCapture() });
  const result = await instance.generate({ promptHint: 'cute', description: 'mother', referenceKeys: [] });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.attempts, 2);
  assert.equal(scripted.calls.length, 2);
});

test('openai-images：524 重试 2 次仍失败 → unknown（冻结待对账），attempts=3', async () => {
  const scripted = createScriptedFetch([
    { match: '', method: 'POST', status: 524, json: fixture('generate-gateway-timeout.json') },
    { match: '', method: 'POST', status: 504, json: fixture('generate-gateway-timeout.json') },
    { match: '', method: 'POST', status: 524, json: fixture('generate-gateway-timeout.json') },
  ]);
  const instance = build({ fetchImpl: scripted.fetchImpl, logger: consoleCapture() });
  const result = await instance.generate({ promptHint: 'cute', description: 'mother', referenceKeys: [] });
  assert.equal(result.status, 'unknown');
  assert.equal(result.attempts, 3);
  assert.equal(scripted.calls.length, 3, '总尝试 ≤ 1+2 次');
});

test('openai-images：非网关 5xx 不重试（避免对已受理请求重复计费）', async () => {
  const scripted = createScriptedFetch([
    { match: '', method: 'POST', status: 500, json: { error: 'internal' } },
  ]);
  const instance = build({ fetchImpl: scripted.fetchImpl, logger: consoleCapture() });
  const result = await instance.generate({ promptHint: 'cute', description: 'mother', referenceKeys: [] });
  assert.equal(result.status, 'unknown');
  assert.equal(scripted.calls.length, 1);
});

test('openai-images：gatewayRetryMax 硬上限 2（配置再大也只重试 2 次）', async () => {
  const scripted = createScriptedFetch([
    { match: '', method: 'POST', status: 524, json: {} },
    { match: '', method: 'POST', status: 524, json: {} },
    { match: '', method: 'POST', status: 524, json: {} },
  ]);
  const instance = driver.create(
    contractChannel({ kind: 'image', driver: 'openai-images', modelMap: { image: 'gpt-image-2' },
      params: { requestTimeoutMs: 300, gatewayRetryMax: 9 } }),
    { logger: consoleCapture(), deps: { fetchImpl: scripted.fetchImpl } });
  const result = await instance.generate({ promptHint: 'cute', description: 'mother', referenceKeys: [] });
  assert.equal(result.status, 'unknown');
  assert.equal(scripted.calls.length, 3);
});

test('openai-images：有参考照片走 edits multipart，无参考走 generations JSON', async () => {
  const withRefs = createScriptedFetch([{ match: '/v1/images/edits', method: 'POST', status: 200, json: fixture('generate-accepted.json') }]);
  const withRefsInstance = build({ fetchImpl: withRefs.fetchImpl, logger: consoleCapture() });
  const withRefsResult = await withRefsInstance.generate({ promptHint: 'p', description: 'd', referenceKeys: ['users/u1/uploads/upl_1'] });
  assert.equal(withRefsResult.status, 'succeeded');
  assert.ok(withRefs.calls.length === 1 && withRefs.calls[0].url.includes('/v1/images/edits'));

  const noRefs = createScriptedFetch([{ match: '/v1/images/generations', method: 'POST', status: 200, json: fixture('generate-accepted.json') }]);
  const noRefsInstance = build({ fetchImpl: noRefs.fetchImpl, logger: consoleCapture() });
  const noRefsResult = await noRefsInstance.generate({ promptHint: 'p', description: 'd', referenceKeys: [] });
  assert.equal(noRefsResult.status, 'succeeded');
  assert.ok(noRefs.calls.length === 1 && noRefs.calls[0].url.includes('/v1/images/generations'));
});

test('openai-images：参考照片超出上限只取第一张并记 droppedReferences', async () => {
  const scripted = createScriptedFetch([{ match: '/v1/images/edits', method: 'POST', status: 200, json: fixture('generate-accepted.json') }]);
  const instance = build({ fetchImpl: scripted.fetchImpl, logger: consoleCapture() });
  const result = await instance.generate({ promptHint: 'p', description: 'd',
    referenceKeys: ['users/u1/uploads/upl_1', 'users/u1/uploads/upl_2', 'users/u1/uploads/upl_3'] });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.droppedReferences, 2);
});

test('openai-images：参考照片读取失败 → retryable（发生在计费生成之前）', async () => {
  const scripted = createScriptedFetch([]);
  const instance = build({ fetchImpl: scripted.fetchImpl, logger: consoleCapture(),
    deps: { loadReference: async () => { throw new Error('storage 503'); } } });
  await assert.rejects(instance.generate({ promptHint: 'p', description: 'd', referenceKeys: ['k1'] }),
    (error) => error.retryable === true && error.submitted === false);
  assert.equal(scripted.calls.length, 0, '上游零调用');
});

test('openai-images：结果 URL 下载失败重试 3 次后 unknown（地址已知不再付费生成）', async () => {
  const scripted = createScriptedFetch([
    { match: '/v1/images/generations', method: 'POST', status: 200, json: { data: [{ url: 'https://cdn.example.test/out.png' }] } },
  ]);
  let failures = 0;
  const instance = build({ fetchImpl: scripted.fetchImpl, logger: consoleCapture(),
    deps: { downloadImage: async () => { failures += 1; throw new Error('net'); } } });
  const result = await instance.generate({ promptHint: 'p', description: 'd', referenceKeys: [] });
  assert.equal(result.status, 'unknown');
  assert.equal(failures, 3);
});

test('openai-images：sizeFor 分辨率档 × 画幅映射', () => {
  assert.equal(sizeFor('1k', '1:1'), '1024x1024');
  assert.equal(sizeFor('1k', '9:16'), '1024x1536');
  assert.equal(sizeFor('1k', '16:9'), '1536x1024');
  assert.equal(sizeFor('1080p', '1:1'), '1024x1024');
  assert.equal(sizeFor('1024x768'), '1024x768');
  assert.equal(sizeFor('512p', '1:1'), null);
});

test('openai-images：catalog() 模型目录', async () => {
  const scripted = createScriptedFetch([{ match: '/v1/models', method: 'GET', status: 200, json: fixture('models.json') }]);
  const instance = build({ fetchImpl: scripted.fetchImpl, logger: consoleCapture() });
  const catalog = await instance.catalog();
  assert.deepEqual(catalog.models.map((m) => m.name), ['gpt-image-2', 'dreamina-seedance-2-5-hc']);
});
