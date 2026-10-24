// aiide 渠道适配器测试（M2-BE-01 渠道切换）：火山方舟视频协议 + 素材库过审 + OpenAI Images。
// 全部用注入的假 fetch / 假 materials，不访问外网；字段与错误分类按 apifox 文档（2026-10-23 核对）。
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createAiideMaterials, assertMaterialUrl, materialCacheKey, createAiideVideoAdapter,
  createAiideImageProvider, aiideImageSizeFor as sizeFor, pickVideoUrl, sniffImage, imageExtensionFor, withImageExtension,
} from '../../src/engine/providers/index.js';

const PNG_BYTES = Buffer.from('89504e470d0a1a0a0000000d4948445200000001', 'hex');
const JPEG_BYTES = Buffer.from('ffd8ffe000104a464946000101000001', 'hex');

/** 记录请求并按脚本回响应的假 fetch：steps 依次消费，元素 {status, body} 或 Error。支持 FormData 请求体。 */
function fakeFetch(steps) {
  const calls = [];
  const queue = [...steps];
  const impl = async (url, init = {}) => {
    let body = null;
    if (init.body instanceof FormData) {
      body = {};
      for (const [key, value] of init.body.entries()) {
        body[key] = value instanceof Blob ? { bytes: value.size, type: value.type, name: value.name } : value;
      }
    } else if (typeof init.body === 'string') body = JSON.parse(init.body);
    calls.push({ url: String(url), method: init.method ?? 'GET', body, headers: init.headers ?? {} });
    const step = queue.shift() ?? { status: 500, body: '{"error":{"message":"脚本耗尽"}}' };
    if (step instanceof Error) throw step;
    return new Response(JSON.stringify(step.body ?? {}), { status: step.status,
      headers: { 'content-type': 'application/json' } });
  };
  return { calls, impl };
}

const ARGS = { baseUrl: 'https://www.aiide.com', apiKey: 'test-key', logger: null };
const notAborted = (error) => {
  assert.ok(error instanceof Error);
  return true;
};

describe('image-bytes 嗅探（aiide 素材库扩展名要求）', () => {
  test('sniffImage 按文件头判定；imageExtensionFor 有 content-type 兜底', () => {
    assert.deepEqual(sniffImage(PNG_BYTES), { contentType: 'image/png', extension: 'png' });
    assert.equal(sniffImage(JPEG_BYTES).extension, 'jpg');
    assert.equal(sniffImage(Buffer.from('not-an-image-at-all')), null);
    assert.equal(imageExtensionFor({ buffer: null, contentType: 'image/jpeg' }), 'jpg');
    assert.equal(imageExtensionFor({ buffer: null, contentType: undefined }), 'png');
  });

  test('withImageExtension 补/换扩展名（旧 key 无扩展名也要能落盘）', () => {
    assert.equal(withImageExtension('users/u/looks/lkv_1', 'png'), 'users/u/looks/lkv_1.png');
    assert.equal(withImageExtension('users/u/looks/lkv_1.png', 'png'), 'users/u/looks/lkv_1.png');
    assert.equal(withImageExtension('users/u/looks/lkv_1', 'jpg'), 'users/u/looks/lkv_1.jpg');
    assert.equal(withImageExtension('users/u/looks/lkv_1.png', 'jpg'), 'users/u/looks/lkv_1.jpg');
  });
});

describe('aiide 素材库客户端', () => {
  test('assertMaterialUrl：公网 http(s) + 扩展名匹配；缺扩展名/非 http 直接拒绝（渠道硬性要求）', () => {
    assertMaterialUrl('https://cdn.example.com/a.jpg', 'image');
    assertMaterialUrl('https://cdn.example.com/a.PNG', 'image');
    assert.throws(() => assertMaterialUrl('https://cdn.example.com/noext', 'image'), notAborted);
    assert.throws(() => assertMaterialUrl('https://cdn.example.com/a.mp4', 'image'), notAborted);
    assert.throws(() => assertMaterialUrl('ftp://cdn.example.com/a.jpg', 'image'), notAborted);
    assert.throws(() => assertMaterialUrl('not a url', 'image'), notAborted);
    assertMaterialUrl('https://cdn.example.com/a.mp3', 'audio');
  });

  test('materialCacheKey 去掉签名参数（七牛 e/token 与常见签名族）', () => {
    const base = 'https://cdnh5.example.com/users/u/looks/a.png';
    const signed = `${base}?e=1790000000&token=AK%3Asig&X-Tos-Algorithm=TOS4`;
    assert.equal(materialCacheKey(signed, 'image'), materialCacheKey(base, 'image'));
  });

  test('register：upload ready → asset://；pending → 轮询到 ready；URL 参与缓存', async () => {
    const fetch = fakeFetch([
      { status: 200, body: { success: true, message: '', data: { asset_id: 'mat_a1', status: 'pending' } } },
      { status: 200, body: { success: true, message: '', data: { asset_id: 'mat_a1', status: 'pending' } } },
      { status: 200, body: { success: true, message: '', data: { asset_id: 'mat_a1', status: 'ready' } } },
    ]);
    const materials = createAiideMaterials({ ...ARGS, fetchImpl: fetch.impl, pollIntervalMs: 1, pollTimeoutMs: 5_000 });
    const ref = await materials.register('https://cdn.example.com/look.png', 'image');
    assert.equal(ref, 'asset://mat_a1');
    assert.equal(fetch.calls[0].method, 'POST');
    assert.equal(fetch.calls[0].url, 'https://www.aiide.com/v1/assets/upload');
    assert.deepEqual(fetch.calls[0].body, { url: 'https://cdn.example.com/look.png', type: 'image', purpose: 'Mini AI Video 参考素材' });
    assert.equal(fetch.calls[1].url, 'https://www.aiide.com/v1/assets/mat_a1');
    const again = await materials.register('https://cdn.example.com/look.png?e=1&token=x', 'image');
    assert.equal(again, 'asset://mat_a1', '重签同 URL 命中缓存，不重复上传');
    assert.equal(fetch.calls.length, 3);
  });

  test('register：审核不通过 → PROVIDER_REFERENCE_REJECTED（不可重试、未提交）', async () => {
    const fetch = fakeFetch([
      { status: 200, body: { success: true, message: '', data: { asset_id: 'mat_bad', status: 'failed',
        failure_reason: '素材审核不通过：图片可能涉及版权限制' } } },
    ]);
    const materials = createAiideMaterials({ ...ARGS, fetchImpl: fetch.impl });
    await assert.rejects(() => materials.register('https://cdn.example.com/face.png', 'image'),
      (error) => error.code === 'PROVIDER_REFERENCE_REJECTED' && error.retryable === false
        && error.submitted === false && /版权限制/.test(error.providerMessage));
  });

  test('register：渠道 4xx 拒绝 → PROVIDER_REJECTED；429/5xx/断连 → retryable（发生在视频提交前）', async () => {
    const rejected = fakeFetch([{ status: 400, body: { success: false, message: 'purpose is required' } }]);
    const materials1 = createAiideMaterials({ ...ARGS, fetchImpl: rejected.impl });
    await assert.rejects(() => materials1.register('https://cdn.example.com/a.png', 'image'),
      (error) => error.code === 'PROVIDER_REJECTED' && error.retryable === false);

    const limited = fakeFetch([{ status: 429, body: {} }]);
    const materials2 = createAiideMaterials({ ...ARGS, fetchImpl: limited.impl });
    await assert.rejects(() => materials2.register('https://cdn.example.com/a.png', 'image'),
      (error) => error.retryable === true && error.submitted === false);

    const down = fakeFetch([Object.assign(new Error('connect ECONNREFUSED'), { cause: { code: 'ECONNREFUSED' } })]);
    const materials3 = createAiideMaterials({ ...ARGS, fetchImpl: down.impl });
    await assert.rejects(() => materials3.register('https://cdn.example.com/a.png', 'image'),
      (error) => error.retryable === true);
  });

  test('register：审核等待超时 → retryable；asset:// 与 mat_ 引用原样返回', async () => {
    const fetch = fakeFetch([{ status: 200, body: { success: true, data: { asset_id: 'mat_slow', status: 'pending' } } }]);
    const materials = createAiideMaterials({ ...ARGS, fetchImpl: fetch.impl, pollIntervalMs: 1, pollTimeoutMs: 5 });
    await assert.rejects(() => materials.register('https://cdn.example.com/slow.png', 'image'),
      (error) => error.retryable === true);
    assert.equal(await materials.register('asset://mat_x', 'image'), 'asset://mat_x');
    assert.equal(await materials.register('mat_x', 'image'), 'asset://mat_x');
  });
});

describe('aiide 视频适配器（火山方舟协议）', () => {
  test('prepare：metadata 字段精确（content 角色数组 + generate_audio/ratio/duration/resolution/watermark），非链接素材丢弃', () => {
    const adapter = createAiideVideoAdapter({ ...ARGS });
    const prepared = adapter.prepare({
      prompt: '  女孩抱着狐狸  ', durationSeconds: 5, ratio: '9:16', resolution: '480p',
      imageRefs: ['https://cdn.example/tail.jpg', 'https://cdn.example/look.png', 'not-a-url', 'asset://mat_keep'],
      audioRefs: ['https://cdn.example/voice.mp3'],
      someExtra: 'must-drop',
    }, { durations: [5, 10, 15, 30] });
    assert.deepEqual(prepared, {
      model: 'dreamina-seedance-2-5-hc',
      prompt: '女孩抱着狐狸',
      metadata: {
        content: [
          { type: 'image_url', image_url: { url: 'https://cdn.example/tail.jpg' }, role: 'reference_image' },
          { type: 'image_url', image_url: { url: 'https://cdn.example/look.png' }, role: 'reference_image' },
          { type: 'image_url', image_url: { url: 'asset://mat_keep' }, role: 'reference_image' },
          { type: 'audio_url', audio_url: { url: 'https://cdn.example/voice.mp3' }, role: 'reference_audio' },
        ],
        generate_audio: true, ratio: '9:16', duration: 5, resolution: '480p', watermark: false,
      },
    });
    assert.equal('someExtra' in prepared, false);
  });

  test('prepare：时长/分辨率/画幅/SKU 允许值校验', () => {
    const adapter = createAiideVideoAdapter({ ...ARGS });
    assert.throws(() => adapter.prepare({ prompt: 'p', durationSeconds: 0, ratio: '9:16', resolution: '480p' }), notAborted);
    assert.throws(() => adapter.prepare({ prompt: 'p', durationSeconds: 4, ratio: '9:16', resolution: '512p' }), notAborted);
    assert.throws(() => adapter.prepare({ prompt: 'p', durationSeconds: 4, ratio: '竖屏', resolution: '480p' }), notAborted);
    assert.throws(() => adapter.prepare({ prompt: 'p', durationSeconds: 4, ratio: '9:16', resolution: '480p' }, { durations: [5] }), notAborted);
  });

  test('submit：素材过审后以 asset:// 提交；响应 task_id → running', async () => {
    const registered = [];
    const materials = { register: async (url, type) => { registered.push({ url, type }); return `asset://mat_${registered.length}`; } };
    const fetch = fakeFetch([{ status: 200, body: { id: 'cgt-1', task_id: 'cgt-1', object: 'video', status: '', progress: 0 } }]);
    const adapter = createAiideVideoAdapter({ ...ARGS, materials, fetchImpl: fetch.impl });
    const prepared = adapter.prepare({ prompt: 'p', durationSeconds: 5, ratio: '9:16', resolution: '480p',
      imageRefs: ['https://cdn.example/look.png'], audioRefs: ['https://cdn.example/v.mp3'] });
    const submitted = await adapter.submit(prepared, { idempotencyKey: 'take_1' });
    assert.equal(submitted.status, 'running');
    assert.equal(submitted.upstreamId, 'cgt-1');
    assert.deepEqual(registered, [{ url: 'https://cdn.example/look.png', type: 'image' }, { url: 'https://cdn.example/v.mp3', type: 'audio' }]);
    const body = fetch.calls[0].body;
    assert.equal(body.metadata.content[0].image_url.url, 'asset://mat_1');
    assert.equal(body.metadata.content[1].audio_url.url, 'asset://mat_2');
    assert.equal(fetch.calls[0].headers.Authorization, 'Bearer test-key');
  });

  test('submit：素材审核不通过 → 返回 failed（不抛，明确未提交不冻结）；素材库暂不可用 → retryable 抛出', async () => {
    const fetch = fakeFetch([]);
    const rejected = { register: async () => {
      const error = new Error('参考素材未通过渠道审核。');
      error.code = 'PROVIDER_REFERENCE_REJECTED';
      error.providerMessage = '涉及版权限制';
      throw error;
    } };
    const adapter1 = createAiideVideoAdapter({ ...ARGS, materials: rejected, fetchImpl: fetch.impl });
    const failed = await adapter1.submit(adapter1.prepare({ prompt: 'p', durationSeconds: 5, ratio: '9:16', resolution: '480p',
      imageRefs: ['https://cdn.example/look.png'] }));
    assert.equal(failed.status, 'failed');
    assert.equal(failed.providerMessage, '涉及版权限制');

    const unavailable = { register: async () => {
      const error = new Error('素材库暂不可用。');
      error.code = 'PROVIDER_REFERENCE_UNAVAILABLE';
      error.retryable = true;
      throw error;
    } };
    const adapter2 = createAiideVideoAdapter({ ...ARGS, materials: unavailable, fetchImpl: fetch.impl });
    await assert.rejects(() => adapter2.submit(adapter2.prepare({ prompt: 'p', durationSeconds: 5, ratio: '9:16', resolution: '480p',
      imageRefs: ['https://cdn.example/look.png'] })), (error) => error.retryable === true);
  });

  test('submit：429 → retryable；4xx → 返回 failed（上游明确拒绝）；5xx/超时 → unknown 抛出', async () => {
    const base = { prompt: 'p', durationSeconds: 5, ratio: '9:16', resolution: '480p', imageRefs: [] };
    const limited = fakeFetch([{ status: 429, body: { error: { message: 'rate limited' } } }]);
    const adapter1 = createAiideVideoAdapter({ ...ARGS, fetchImpl: limited.impl });
    await assert.rejects(() => adapter1.submit(adapter1.prepare(base)), (error) => error.retryable === true && error.submitted === false);

    const rejected = fakeFetch([{ status: 400, body: { error: { message: 'duration not supported', code: 'invalid_duration' } } }]);
    const adapter2 = createAiideVideoAdapter({ ...ARGS, fetchImpl: rejected.impl });
    const failed = await adapter2.submit(adapter2.prepare(base));
    assert.equal(failed.status, 'failed', '上游明确拒绝必须返回 failed，让该段退款而非冻结');
    assert.equal(failed.providerMessage, 'duration not supported');
    assert.equal(failed.providerCode, 'invalid_duration');

    const boom = fakeFetch([{ status: 502, body: {} }]);
    const adapter3 = createAiideVideoAdapter({ ...ARGS, fetchImpl: boom.impl });
    await assert.rejects(() => adapter3.submit(adapter3.prepare(base)), (error) => error.code === 'SUBMISSION_UNKNOWN');

    const timeout = fakeFetch([Object.assign(new Error('aborted'), { name: 'AbortError' })]);
    const adapter4 = createAiideVideoAdapter({ ...ARGS, fetchImpl: timeout.impl, timeoutMs: 5 });
    await assert.rejects(() => adapter4.submit(adapter4.prepare(base)), (error) => error.code === 'SUBMISSION_UNKNOWN' && error.submitted === true);

    const noId = fakeFetch([{ status: 200, body: { object: 'video' } }]);
    const adapter5 = createAiideVideoAdapter({ ...ARGS, fetchImpl: noId.impl });
    await assert.rejects(() => adapter5.submit(adapter5.prepare(base)), (error) => error.code === 'SUBMISSION_UNKNOWN');
  });

  test('query：状态映射（排队/处理中 → running；成功+地址 → succeeded；成功无地址 → unknown；失败/过期 → failed）', async () => {
    const steps = [
      { status: 200, body: { code: 'success', data: { task_id: 't1', status: 'QUEUED' } } },
      { status: 200, body: { code: 'success', data: { task_id: 't1', status: 'IN_PROGRESS', progress: '50%' } } },
      { status: 200, body: { code: 'success', data: { task_id: 't1', status: 'SUCCESS', data: {
        status: 'succeeded', content: { video_url: 'https://ark.example.com/v.mp4?X-Tos-Expires=86400' },
        usage: { total_tokens: 108900, completion_tokens: 108900 } } } } },
      { status: 200, body: { code: 'success', data: { task_id: 't2', status: 'FAILURE', fail_reason: '内容违规' } } },
      { status: 200, body: { code: 'success', data: { task_id: 't3', status: 'SUCCESS', data: { status: 'succeeded', content: {} } } } },
      { status: 200, body: { code: 'success', data: { task_id: 't4', status: 'IN_PROGRESS', data: { status: 'expired' } } } },
    ];
    const fetch = fakeFetch(steps);
    const adapter = createAiideVideoAdapter({ ...ARGS, fetchImpl: fetch.impl });
    assert.equal((await adapter.query('t1')).status, 'running');
    assert.equal((await adapter.query('t1')).status, 'running');
    const ok = await adapter.query('t1');
    assert.equal(ok.status, 'succeeded');
    assert.equal(ok.outputs[0].url, 'https://ark.example.com/v.mp4?X-Tos-Expires=86400');
    assert.equal(ok.usage.total_tokens, 108900, 'usage 透传（按 token 计费，冒烟要拿它校准成本）');
    const failed = await adapter.query('t2');
    assert.equal(failed.status, 'failed');
    assert.equal(failed.providerMessage, '内容违规');
    assert.equal((await adapter.query('t3')).status, 'unknown', '完成态无地址按结果未知冻结');
    assert.equal((await adapter.query('t4')).status, 'failed', '上游 expired 是明确失败终态');
  });

  test('query：成功态 fail_reason 字段错放成片链接时仍能收割；404 → failed；5xx → retryable 抛出', async () => {
    const steps = [
      { status: 200, body: { code: 'success', data: { task_id: 't1', status: 'SUCCESS',
        fail_reason: 'https://ark.example.com/real.mp4?sig=1', data: { status: 'succeeded', content: {} } } } },
      { status: 404, body: { code: 'not_found', message: 'task not found' } },
      { status: 500, body: { error: { message: 'boom' } } },
    ];
    const fetch = fakeFetch(steps);
    const adapter = createAiideVideoAdapter({ ...ARGS, fetchImpl: fetch.impl });
    const ok = await adapter.query('t1');
    assert.equal(ok.status, 'succeeded', '文档示例：成功任务的 fail_reason 字段放着成片链接（渠道字段错位）');
    assert.equal(ok.outputs[0].url, 'https://ark.example.com/real.mp4?sig=1');
    const missing = await adapter.query('gone');
    assert.equal(missing.status, 'failed');
    await assert.rejects(() => adapter.query('t2'), (error) => error.retryable === true && error.submitted === true,
      '单次查询失败交队列退避继续轮询，绝不因查询失败冻结');
  });

  test('pickVideoUrl 只接受无凭据的 http(s) 链接', () => {
    assert.equal(pickVideoUrl({ content: { video_url: 'https://a.example/v.mp4' } }), 'https://a.example/v.mp4');
    assert.equal(pickVideoUrl({ url: 'https://user:pass@a.example/v.mp4' }), null);
    assert.equal(pickVideoUrl({ url: '/v1/videos/t1/content' }), null);
  });
});

describe('aiide 图片 provider（OpenAI Images）', () => {
  const downloadImage = async () => ({ buffer: PNG_BYTES, contentType: 'image/png' });

  test('sizeFor：档位 × 画幅 → OpenAI size；1080p 别名兼容；不支持的组合返回 null', () => {
    assert.equal(sizeFor('1k', '1:1'), '1024x1024');
    assert.equal(sizeFor('1k', '3:4'), '1024x1536');
    assert.equal(sizeFor('1k', '9:16'), '1024x1536');
    assert.equal(sizeFor('1k', '16:9'), '1536x1024');
    assert.equal(sizeFor('1080p', '1:1'), '1024x1024', '喵呜时期 SKU 的 1080p 别名仍可用');
    assert.equal(sizeFor('2k', '1:1'), '2048x2048');
    assert.equal(sizeFor('2k', '9:16'), null, '2K 竖版渠道未列出，不要猜');
    assert.equal(sizeFor('4k', '9:16'), '2160x3840');
    assert.equal(sizeFor('1536x1024', '1:1'), '1536x1024', '直接给 WxH 原样透传');
    assert.equal(sizeFor('8k', '1:1'), null);
  });

  test('generate 文生图：POST /v1/images/generations 精确字段 + b64_json 解码（content-type 按字节嗅探）', async () => {
    const fetch = fakeFetch([{ status: 200, body: { data: [{ b64_json: PNG_BYTES.toString('base64') }], created: 1 } }]);
    const provider = createAiideImageProvider({ ...ARGS, fetchImpl: fetch.impl, downloadImage });
    const result = await provider.generate({ characterId: 'chr_1', styleId: 'anime', promptHint: '形象提示',
      description: '4 岁女孩', referenceKeys: [], sku: { resolution: '1k', ratio: '1:1' } });
    assert.equal(result.status, 'succeeded');
    assert.equal(result.contentType, 'image/png');
    assert.deepEqual(fetch.calls[0].body, { model: 'gpt-image-2', prompt: '形象提示\n4 岁女孩', size: '1024x1024',
      n: 1, response_format: 'b64_json' });
    assert.equal(fetch.calls[0].url, 'https://www.aiide.com/v1/images/generations');
  });

  test('generate 带参考照片：loadReference 下载字节 → multipart edits（含 image 文件与表单字段）', async () => {
    const fetch = fakeFetch([{ status: 200, body: { data: [{ b64_json: PNG_BYTES.toString('base64') }] } }]);
    const loadReferenceCalls = [];
    const provider = createAiideImageProvider({ ...ARGS, fetchImpl: fetch.impl, downloadImage,
      loadReference: async (key) => { loadReferenceCalls.push(key); return { buffer: PNG_BYTES, contentType: 'image/png' }; } });
    const result = await provider.generate({ characterId: 'chr_1', styleId: 'anime', promptHint: 'p', description: 'd',
      referenceKeys: ['users/u/uploads/up_1'], sku: { resolution: '1k', ratio: '3:4' } });
    assert.equal(result.status, 'succeeded');
    assert.deepEqual(loadReferenceCalls, ['users/u/uploads/up_1']);
    assert.equal(fetch.calls[0].url, 'https://www.aiide.com/v1/images/edits');
    assert.equal(fetch.calls[0].body.model, 'gpt-image-2');
    assert.equal(fetch.calls[0].body.prompt, 'p\nd');
    assert.equal(fetch.calls[0].body.size, '1024x1536', '3:4 竖版映射到 1024x1536');
    assert.equal(fetch.calls[0].body.n, '1');
    assert.equal(fetch.calls[0].body.response_format, 'b64_json');
    assert.deepEqual(fetch.calls[0].body.image, { bytes: PNG_BYTES.length, type: 'image/png', name: 'ref1.png' });
  });

  test('generate：参考照片读取失败 → retryable 抛出（未提交）；非图片字节 → failed；超上限裁剪并计数', async () => {
    const fetch = fakeFetch([]);
    const provider1 = createAiideImageProvider({ ...ARGS, fetchImpl: fetch.impl, downloadImage,
      loadReference: async () => { throw new Error('storage 503'); } });
    await assert.rejects(() => provider1.generate({ promptHint: 'p', description: '', referenceKeys: ['k1'] }),
      (error) => error.retryable === true && error.submitted === false);

    const provider2 = createAiideImageProvider({ ...ARGS, fetchImpl: fetch.impl, downloadImage,
      loadReference: async () => ({ buffer: Buffer.from('definitely not an image'), contentType: 'text/plain' }) });
    const bad = await provider2.generate({ promptHint: 'p', description: '', referenceKeys: ['k1'] });
    assert.equal(bad.status, 'failed');

    let calls = 0;
    const ok = fakeFetch([{ status: 200, body: { data: [{ b64_json: PNG_BYTES.toString('base64') }] } }]);
    const provider3 = createAiideImageProvider({ ...ARGS, fetchImpl: ok.impl, downloadImage, maxReferences: 1,
      loadReference: async () => { calls += 1; return { buffer: PNG_BYTES }; } });
    const trimmed = await provider3.generate({ promptHint: 'p', description: '',
      referenceKeys: ['k1', 'k2', 'k3'], sku: {} });
    assert.equal(trimmed.status, 'succeeded');
    assert.equal(trimmed.droppedReferences, 2, '当前口径只用第一张（用户 2026-10-17），多出的计入 droppedReferences');
    assert.equal(calls, 1);
  });

  test('generate：4xx → failed；5xx/超时 → unknown；ECONNREFUSED → retryable 抛出（明确未提交）', async () => {
    const base = { promptHint: 'p', description: '', referenceKeys: [] };
    const rejected = fakeFetch([{ status: 401, body: { error: { message: 'invalid api key' } } }]);
    const provider1 = createAiideImageProvider({ ...ARGS, fetchImpl: rejected.impl, downloadImage });
    const r1 = await provider1.generate(base);
    assert.equal(r1.status, 'failed');
    assert.equal(r1.providerMessage, 'invalid api key');

    const boom = fakeFetch([{ status: 500, body: {} }]);
    const provider2 = createAiideImageProvider({ ...ARGS, fetchImpl: boom.impl, downloadImage });
    assert.equal((await provider2.generate(base)).status, 'unknown');

    const timeout = fakeFetch([Object.assign(new Error('aborted'), { name: 'AbortError' })]);
    const provider3 = createAiideImageProvider({ ...ARGS, fetchImpl: timeout.impl, downloadImage, requestTimeoutMs: 5 });
    assert.equal((await provider3.generate(base)).status, 'unknown', '同步生成超时可能已计费：冻结待对账');

    const refused = fakeFetch([Object.assign(new Error('connect ECONNREFUSED'), { cause: { code: 'ECONNREFUSED' } })]);
    const provider4 = createAiideImageProvider({ ...ARGS, fetchImpl: refused.impl, downloadImage });
    await assert.rejects(() => provider4.generate(base), (error) => error.retryable === true);
  });

  test('generate：429 → retryable；size 组合不支持 → failed；b64 是垃圾字节 → unknown', async () => {
    const base = { promptHint: 'p', description: '', referenceKeys: [] };
    const limited = fakeFetch([{ status: 429, body: {} }]);
    const provider1 = createAiideImageProvider({ ...ARGS, fetchImpl: limited.impl, downloadImage });
    await assert.rejects(() => provider1.generate(base), (error) => error.retryable === true);

    const fetch = fakeFetch([]);
    const provider2 = createAiideImageProvider({ ...ARGS, fetchImpl: fetch.impl, downloadImage });
    const badSize = await provider2.generate({ ...base, sku: { resolution: '8k' } });
    assert.equal(badSize.status, 'failed');

    const garbage = fakeFetch([{ status: 200, body: { data: [{ b64_json: Buffer.from('junk').toString('base64') }] } }]);
    const provider3 = createAiideImageProvider({ ...ARGS, fetchImpl: garbage.impl, downloadImage });
    assert.equal((await provider3.generate(base)).status, 'unknown');
  });

  test('generate：渠道返回 url 形态 → 受控下载，下载失败重试 3 次后 unknown（不再付费重提）', async () => {
    const fetch = fakeFetch([{ status: 200, body: { data: [{ url: 'https://cdn.example/out.png' }] } }]);
    let downloads = 0;
    const provider = createAiideImageProvider({ ...ARGS, fetchImpl: fetch.impl, sleep: async () => {},
      downloadImage: async () => { downloads += 1; throw new Error('cdn 503'); } });
    const result = await provider.generate({ promptHint: 'p', description: '', referenceKeys: [] });
    assert.equal(result.status, 'unknown');
    assert.equal(downloads, 3);
  });
});
