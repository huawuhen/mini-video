// 喵呜（miaowuai）渠道适配器测试（M2-BE-01）：OpenAI 风格异步任务协议。
// 全部用注入的假 fetch，不访问外网；字段与错误分类按 docs/openai-videos（2026-10-22 核对）。
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createMiaowuaiVideoAdapter, createMiaowuaiImageProvider } from '../../src/engine/providers/index.js';

/** 记录请求并按脚本回响应的假 fetch：steps 依次消费，元素 {status, body} 或 Error。 */
function fakeFetch(steps) {
  const calls = [];
  const queue = [...steps];
  const impl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : null,
      headers: init.headers ?? {} });
    const step = queue.shift() ?? { status: 500, body: '{"error":{"message":"脚本耗尽"}}' };
    if (step instanceof Error) throw step;
    return new Response(JSON.stringify(step.body ?? {}), { status: step.status,
      headers: { 'content-type': 'application/json' } });
  };
  return { calls, impl };
}

const ADAPTER_ARGS = { baseUrl: 'https://api.miaowuai.store', apiKey: 'test-key', logger: null };

describe('miaowuai 视频适配器（M2-BE-01）', () => {
  test('prepare：只保留渠道文档字段（未知字段上游 400），素材过滤为 http(s) URL', () => {
    const adapter = createMiaowuaiVideoAdapter({ ...ADAPTER_ARGS });
    const prepared = adapter.prepare({
      prompt: '  一只风筝  ', durationSeconds: 4, ratio: '9:16', resolution: '480p',
      imageRefs: ['https://cdn.example/a.png', 'not-a-url', 'https://cdn.example/b.png'],
      audioRefs: ['https://cdn.example/a.mp3'], someExtra: 'must-drop',
    });
    assert.deepEqual(prepared, { model: 'seedance-2.5-deal', prompt: '一只风筝', seconds: 4,
      ratio: '9:16', resolution: '480p',
      image_urls: ['https://cdn.example/a.png', 'https://cdn.example/b.png'],
      audio_urls: ['https://cdn.example/a.mp3'] });
    assert.equal('someExtra' in prepared, false, '未知字段必须丢弃（上游 400）');
  });

  test('submit：201 返回任务号 → running；429 → retryable 未提交；4xx → failed 未提交', async () => {
    const fetch1 = fakeFetch([{ status: 201, body: { id: 'task_a', status: 'queued' } }]);
    const adapter1 = createMiaowuaiVideoAdapter({ ...ADAPTER_ARGS, fetchImpl: fetch1.impl });
    const submitted = await adapter1.submit({ model: 'seedance-2.5-deal', prompt: 'p', seconds: 4 });
    assert.equal(submitted.status, 'running');
    assert.equal(submitted.upstreamId, 'task_a');
    assert.equal(fetch1.calls[0].method, 'POST');
    assert.equal(fetch1.calls[0].url, 'https://api.miaowuai.store/v1/videos');
    assert.equal(fetch1.calls[0].headers.Authorization, 'Bearer test-key');

    const fetch2 = fakeFetch([{ status: 429, body: {} }]);
    const adapter2 = createMiaowuaiVideoAdapter({ ...ADAPTER_ARGS, fetchImpl: fetch2.impl });
    await assert.rejects(() => adapter2.submit({ model: 'm', prompt: 'p', seconds: 4 }),
      (error) => error.retryable === true && error.submitted === false);

    const fetch3 = fakeFetch([{ status: 400, body: { error: { message: '未知字段' } } }]);
    const adapter3 = createMiaowuaiVideoAdapter({ ...ADAPTER_ARGS, fetchImpl: fetch3.impl });
    await assert.rejects(() => adapter3.submit({ model: 'm', prompt: 'p', seconds: 4 }),
      (error) => error.submitted === false && error.providerMessage === '未知字段');
  });

  test('query：状态映射与结果地址绝对化；失败与 unknown 分类', async () => {
    const steps = [
      { status: 200, body: { id: 't1', status: 'SUBMITTED' } },                    // 排队 → running
      { status: 200, body: { id: 't1', status: 'IN_PROGRESS' } },                  // 生成中 → running
      { status: 200, body: { id: 't1', status: 'completed',
        video_url: '/v1/videos/t1/content' } },                                     // 完成（站内相对路径）
      { status: 200, body: { id: 't2', status: 'FAILURE', error: { message: '内容违规' } } }, // 失败
      { status: 200, body: { id: 't3', status: 'completed' } },                    // 完成但无地址 → unknown
    ];
    const fetch = fakeFetch(steps);
    const adapter = createMiaowuaiVideoAdapter({ ...ADAPTER_ARGS, fetchImpl: fetch.impl });
    const r1 = await adapter.query('t1');
    assert.equal(r1.status, 'running');
    const r2 = await adapter.query('t1');
    assert.equal(r2.status, 'running');
    const r3 = await adapter.query('t1');
    assert.equal(r3.status, 'succeeded');
    assert.equal(r3.outputs[0].url, 'https://api.miaowuai.store/v1/videos/t1/content', '相对路径补全为绝对地址');
    const r4 = await adapter.query('t2');
    assert.equal(r4.status, 'failed');
    assert.equal(r4.providerMessage, '内容违规');
    const r5 = await adapter.query('t3');
    assert.equal(r5.status, 'unknown', '完成态无地址按结果未知冻结');
  });
});

describe('miaowuai 图片 provider（M2-BE-01）', () => {
  const ARGS = { baseUrl: 'https://api.miaowuai.store', apiKey: 'test-key',
    downloadImage: async (url, headers) => {
      if (String(url).includes('/content') && !headers?.Authorization) {
        throw new Error('站内 content 入口必须带 Bearer');
      }
      return { buffer: Buffer.from('PNG'), contentType: 'image/png' };
    }, logger: null };

  test('generate：提交 + 轮询到完成 + 下载成功；提交请求字段精确', async () => {
    const fetch = fakeFetch([
      { status: 200, body: { id: 'img_1' } },
      { status: 200, body: { id: 'img_1', status: 'IN_PROGRESS' } },
      { status: 200, body: { id: 'img_1', status: 'completed', url: 'https://cdn.example/out.png' } },
    ]);
    const provider = createMiaowuaiImageProvider({ ...ARGS, fetchImpl: fetch.impl,
      pollIntervalMs: 1, pollTimeoutMs: 10_000 });
    const result = await provider.generate({ characterId: 'chr_1', styleId: 'anime',
      promptHint: '形象提示', description: '4 岁女孩', referenceKeys: ['https://cdn.example/ref.png'],
      sku: { resolution: '1080p' } });
    assert.equal(result.status, 'succeeded');
    assert.equal(fetch.calls[0].method, 'POST');
    assert.equal(fetch.calls[0].url, 'https://api.miaowuai.store/v1/images');
    assert.deepEqual(fetch.calls[0].body, { model: 'GPT-image-2', prompt: '形象提示\n4 岁女孩',
      ratio: '1:1', resolution: '1080p', image_urls: ['https://cdn.example/ref.png'] });
    assert.equal(fetch.calls.length, 3, '提交 + 2 次轮询');
  });

  test('generate：4xx 拒绝 → failed；提交超时/5xx → unknown（冻结待对账）', async () => {
    const rejected = fakeFetch([{ status: 400, body: { error: { message: '参数不支持' } } }]);
    const provider1 = createMiaowuaiImageProvider({ ...ARGS, fetchImpl: rejected.impl });
    const r1 = await provider1.generate({ characterId: 'c', styleId: 's', promptHint: 'p', description: '', referenceKeys: [] });
    assert.equal(r1.status, 'failed');

    const unknown = fakeFetch([{ status: 500, body: {} }]);
    const provider2 = createMiaowuaiImageProvider({ ...ARGS, fetchImpl: unknown.impl });
    const r2 = await provider2.generate({ characterId: 'c', styleId: 's', promptHint: 'p', description: '', referenceKeys: [] });
    assert.equal(r2.status, 'unknown', '受理结果不确定必须冻结待对账');

    const connFail = fakeFetch([Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNRESET' } })]);
    const provider3 = createMiaowuaiImageProvider({ ...ARGS, fetchImpl: connFail.impl });
    const r3 = await provider3.generate({ characterId: 'c', styleId: 's', promptHint: 'p', description: '', referenceKeys: [] });
    assert.equal(r3.status, 'unknown', '提交后网络断开按结果未知');
  });

  test('generate：轮询超时 → unknown（不重提、冻结待对账）', async () => {
    const fetch = fakeFetch([{ status: 200, body: { id: 'img_slow' } }]);
    const provider = createMiaowuaiImageProvider({ ...ARGS, fetchImpl: fetch.impl,
      pollIntervalMs: 1, pollTimeoutMs: 30 });
    const result = await provider.generate({ characterId: 'c', styleId: 's', promptHint: 'p', description: '', referenceKeys: [] });
    assert.equal(result.status, 'unknown');
    assert.ok(fetch.calls.length >= 2, '提交后持续轮询到超时上限');
  });
});
