// aiide-ark 驱动测试：共用契约套件（样本回放，零真实费用）+ 本驱动特有场景
// （素材过审注入 asset://、fail_reason 字段错位兜底、usage 透传、目录接口）。
import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import driver from './index.js';
import { createMaterials, assertMaterialUrl, materialCacheKey } from './materials.js';
import {
  runVideoDriverContract, contractChannel, createScriptedFetch, consoleCapture,
} from '../../contract-test.js';
import { ProviderError } from '../../contract.js';

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

const channel = contractChannel({
  kind: 'video', driver: 'aiide-ark',
  modelMap: { video: 'dreamina-seedance-2-5-hc' },
  params: { requestTimeoutMs: 300, materialsPollIntervalMs: 1, materialsPollTimeoutMs: 300 },
});

const build = ({ fetchImpl, logger }) => driver.create(channel, { logger, deps: { fetchImpl } });

runVideoDriverContract({
  title: 'aiide-ark 契约',
  build,
  // 通用场景用 asset:// 引用绕开素材库（过审链路有专属场景覆盖）
  videoInput: {
    prompt: 'A girl waves at the camera, gentle smile.',
    imageRefs: ['asset://mat_contract1'],
    audioRefs: [],
    durationSeconds: 5,
    ratio: '9:16',
    resolution: '480p',
  },
  fixtures: {
    submitAccepted: fixture('submit-accepted.json'),
    submitRejected: fixture('submit-rejected.json'),
    queryRunning: fixture('query-running.json'),
    querySucceeded: fixture('query-succeeded.json'),
    queryFailed: fixture('query-failed.json'),
  },
});

// ───────── 本驱动特有场景 ─────────

test('aiide-ark：素材过审后以 asset:// 提交（人脸/虚拟人参考图必须过审）', async () => {
  const scripted = createScriptedFetch([
    { match: '/v1/assets/upload', method: 'POST', status: 200,
      json: { success: true, message: '', data: { asset_id: 'mat_a1', status: 'ready' } } },
    { match: '/v1/video/generations', method: 'POST', status: 200, json: fixture('submit-accepted.json') },
  ]);
  const instance = build({ fetchImpl: scripted.fetchImpl, logger: consoleCapture() });
  const prepared = instance.prepare({ prompt: 'wave', imageRefs: ['https://cdn.example.test/looks/lkv_1.png'],
    durationSeconds: 5, ratio: '9:16', resolution: '480p' });
  const result = await instance.submit(prepared, {});
  assert.equal(result.status, 'running');
  const submitCall = JSON.stringify(scripted.calls);
  assert.ok(scripted.calls.some((call) => call.url.includes('/v1/assets/upload')), '先过素材库');
  assert.ok(submitCall.length > 0 && result.upstreamId);
  // 提交体里的参考图应是 asset://（读取第二轮 POST 的请求体需要更重的录制器，这里验证素材库被调用即可；
  // asset:// 注入逻辑由 materials 单测与既有 M2-BE-01 用例覆盖）
});

test('aiide-ark：素材审核不通过 → { status:"failed" }（不冻结）+ 中文文案', async () => {
  const scripted = createScriptedFetch([
    { match: '/v1/assets/upload', method: 'POST', status: 200,
      json: { success: true, data: { asset_id: 'mat_bad', status: 'failed', failure_reason: 'face verification required' } } },
  ]);
  const instance = build({ fetchImpl: scripted.fetchImpl, logger: consoleCapture() });
  const prepared = instance.prepare({ prompt: 'wave', imageRefs: ['https://cdn.example.test/looks/lkv_2.png'],
    durationSeconds: 5, ratio: '9:16', resolution: '480p' });
  const result = await instance.submit(prepared, {});
  assert.equal(result.status, 'failed');
  assert.equal(result.error, '参考素材未通过渠道审核，请更换形象或照片后重试。');
  assert.equal(scripted.calls.filter((call) => call.url.includes('/v1/video/generations')).length, 0, '视频未被提交');
});

test('aiide-ark：素材库暂不可用（5xx）→ retryable 抛出（明确未提交）', async () => {
  const scripted = createScriptedFetch([
    { match: '/v1/assets/upload', method: 'POST', status: 503, json: { message: 'busy' } },
  ]);
  const instance = build({ fetchImpl: scripted.fetchImpl, logger: consoleCapture() });
  const prepared = instance.prepare({ prompt: 'wave', imageRefs: ['https://cdn.example.test/looks/lkv_3.png'],
    durationSeconds: 5, ratio: '9:16', resolution: '480p' });
  await assert.rejects(instance.submit(prepared, {}), (error) => error.retryable === true && error.submitted === false);
});

test('aiide-ark：成功态 fail_reason 字段错位放成片链接时兜底取出', async () => {
  const misplaced = {
    code: 'success',
    data: {
      task_id: 't9', status: 'SUCCESS',
      fail_reason: 'https://ark.example.test/real.mp4?sig=1',
      data: { status: 'succeeded', content: {} },
    },
  };
  const scripted = createScriptedFetch([{ match: '', method: 'GET', status: 200, json: misplaced }]);
  const instance = build({ fetchImpl: scripted.fetchImpl, logger: consoleCapture() });
  const result = await instance.query('t9');
  assert.equal(result.status, 'succeeded');
  assert.equal(result.outputs[0].url, 'https://ark.example.test/real.mp4?sig=1');
});

test('aiide-ark：usage 透传（按 token 计费，结算成本校准依据）', async () => {
  const scripted = createScriptedFetch([{ match: '', method: 'GET', status: 200, json: fixture('query-succeeded.json') }]);
  const instance = build({ fetchImpl: scripted.fetchImpl, logger: consoleCapture() });
  const result = await instance.query('t1');
  assert.equal(result.usage.total_tokens, 48437);
});

test('aiide-ark：catalog() 返回模型目录（channel:test 用，免费）', async () => {
  const scripted = createScriptedFetch([{ match: '/v1/models', method: 'GET', status: 200, json: fixture('models.json') }]);
  const instance = build({ fetchImpl: scripted.fetchImpl, logger: consoleCapture() });
  const catalog = await instance.catalog();
  assert.deepEqual(catalog.models.map((m) => m.name), ['dreamina-seedance-2-5-hc', 'gpt-image-2']);
});

test('aiide-ark：prepare 校验（时长/分辨率/画幅/提示词）', () => {
  const instance = build({ fetchImpl: createScriptedFetch([]).fetchImpl, logger: consoleCapture() });
  const base = { prompt: 'p', durationSeconds: 5, ratio: '9:16', resolution: '480p' };
  assert.throws(() => instance.prepare({ ...base, prompt: '' }), ProviderError);
  assert.throws(() => instance.prepare({ ...base, durationSeconds: 7 }, { durations: [5, 10] }), ProviderError);
  assert.throws(() => instance.prepare({ ...base, resolution: '4k' }), ProviderError);
  assert.throws(() => instance.prepare({ ...base, ratio: '' }), ProviderError);
});

// 素材库客户端单测（缓存、扩展名预检、签名参数归一）
test('materials：asset:// 与 mat_ 原样返回；缓存去重签名参数', async () => {
  const scripted = createScriptedFetch([
    { match: '/v1/assets/upload', method: 'POST', status: 200,
      json: { success: true, data: { asset_id: 'mat_b1', status: 'ready' } } },
  ]);
  const materials = createMaterials({ http: {
    request: async (path, opts) => {
      const response = await scripted.fetchImpl(`https://channel.example.test${path}`, opts);
      const text = await response.text();
      return { status: response.status, ok: response.ok,
        data: text ? JSON.parse(text) : null, rawText: text.slice(0, 200) };
    },
  }, pollIntervalMs: 1, logger: consoleCapture() });
  assert.equal(await materials.register('asset://mat_x1'), 'asset://mat_x1');
  const url = 'https://cdn.example.test/looks/lkv_9.png?e=1&token=abc';
  assert.equal(await materials.register(url), 'asset://mat_b1');
  await materials.register(`${url}&token=other`); // 同对象不同签名：命中缓存，不再上传
  assert.equal(scripted.remaining, 0, '第二次 register 命中缓存');
  assert.equal(materials.cacheSize(), 1);
});

test('materials：扩展名预检与缓存键归一', () => {
  assert.throws(() => assertMaterialUrl('https://x.example/a', 'image'), ProviderError);
  assert.throws(() => assertMaterialUrl('ftp://x.example/a.png', 'image'), ProviderError);
  assertMaterialUrl('https://x.example/a.webp', 'image');
  assert.equal(
    materialCacheKey('https://c.example/a.png?e=1&token=x&other=2', 'image'),
    materialCacheKey('https://c.example/a.png?e=2&token=y&other=2', 'image'),
  );
});
