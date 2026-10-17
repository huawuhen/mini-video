import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRegistry, createWan30Adapter, createSeedance25Adapter,
  createModelhubImageAdapter, createImageProvider, createModelhubTransport } from '../../src/engine/providers/index.js';
import { normalizeVideo } from '../../src/engine/providers/modelhub-video.js';
import { TINY_PNG } from '../helpers/providers.js';

const fixture = async (name) => JSON.parse(await readFile(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))));

function fakeUpstream(samples) {
  const requests = [];
  let mode = 'success';
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    requests.push({ method: req.method, path: req.url, headers: req.headers, body });
    if (mode === 'accepted-disconnect' && req.method === 'POST') { req.socket.destroy(); return; }
    if (mode === 'timeout' && req.method === 'POST') return;
    const json = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (mode === 'reject') { json(400, samples.image.failed); return; }
    if (mode === 'upstream-failure') { json(503, { error: 'temporarily unavailable' }); return; }
    if (req.url === '/v1/videos/generations' && req.method === 'POST') { json(200, samples.video.submit); return; }
    if (req.url.startsWith('/v1/videos/tasks/') && req.method === 'GET') { json(200, samples.video.succeeded); return; }
    if (req.url === '/v1/images/generations' || req.url === '/v1/images/compositions') {
      json(200, samples.image.succeeded); return;
    }
    json(404, { error: 'missing' });
  });
  return { server, requests, setMode(value) { mode = value; } };
}

describe('engine/providers（M1-ENG-02）', () => {
  let upstream;
  let baseUrl;
  let samples;
  let transport;
  let wan;
  let seedance;
  let image;
  before(async () => {
    samples = { video: await fixture('modelhub-video-qa.json'), image: await fixture('modelhub-image-qa.json') };
    upstream = fakeUpstream(samples);
    upstream.server.listen(0, '127.0.0.1');
    await new Promise((resolve) => upstream.server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${upstream.server.address().port}`;
    transport = createModelhubTransport({ baseUrl, apiKey: 'fixture-token', timeoutMs: 2500 });
    wan = createWan30Adapter(transport);
    seedance = createSeedance25Adapter(transport);
    image = createModelhubImageAdapter({ transport, loadReference: async () => ({ buffer: TINY_PNG, contentType: 'image/png', name: 'ref.png' }) });
  });
  after(async () => { upstream.server.closeAllConnections(); await new Promise((resolve) => upstream.server.close(resolve)); });

  test('注册表校验、去重及分类', () => {
    const registry = createRegistry([wan, seedance, image]);
    assert.equal(registry.get('modelhub-wan-3.0'), wan);
    assert.equal(registry.list('video').length, 2);
    assert.throws(() => registry.get('missing'), (error) => error.submitted === false);
    assert.throws(() => createRegistry([wan, wan]), /重复/);
  });

  test('Wan/Seedance prepare：图片、音频参考与 tailRef 普通参考图', () => {
    const payload = wan.prepare({ prompt: '镜头向前移动', durationSeconds: 10, imageRefs: ['https://media.example.test/character.png'],
      audioRefs: ['https://media.example.test/voice.wav'], tailRef: 'https://media.example.test/tail.png', ratio: '9:16' },
    { durations: [5, 10, 15], resolution: '720p' });
    assert.deepEqual(payload, { model: 'wan-3.0', prompt: '镜头向前移动', resolution: '720p', ratio: '9:16', duration: 10,
      functionMode: 'omni_reference', image_file_1: 'https://media.example.test/tail.png',
      image_file_2: 'https://media.example.test/character.png', audio_file_1: 'https://media.example.test/voice.wav' });
    const other = seedance.prepare({ prompt: '片段', durationSeconds: 30, imageRefs: [], audioRefs: ['https://media.example.test/voice.wav'] });
    assert.equal(other.model, 'seedance-2.5');
    assert.throws(() => wan.prepare({ prompt: '片段', durationSeconds: 31 }), /时长/);
    const tailWithAudio = seedance.prepare({ prompt: '片段', durationSeconds: 10, tailRef: 'https://media.example.test/tail.png',
      audioRefs: ['https://media.example.test/voice.wav'] });
    assert.equal(tailWithAudio.functionMode, 'omni_reference');
    assert.equal(tailWithAudio.image_file_1, 'https://media.example.test/tail.png');
    assert.equal(tailWithAudio.audio_file_1, 'https://media.example.test/voice.wav');
  });

  test('HTTP 假服务：视频 submit/query/normalize 与响应夹具一致', async () => {
    upstream.setMode('success');
    const prepared = seedance.prepare({ prompt: '森林晨光', durationSeconds: 10, imageRefs: ['https://media.example.test/img.png'],
      audioRefs: ['https://media.example.test/voice.wav'] });
    assert.deepEqual(await seedance.submit(prepared, { idempotencyKey: 'id-1' }), { status: 'running', upstreamId: 'qa-task-001' });
    const sent = upstream.requests.at(-1);
    assert.equal(sent.path, '/v1/videos/generations');
    assert.equal(sent.headers.authorization, 'Bearer fixture-token');
    assert.equal(sent.headers['idempotency-key'], 'id-1');
    assert.equal(JSON.parse(sent.body).image_file_1, 'https://media.example.test/img.png');
    assert.deepEqual(await seedance.query('qa-task-001'), { status: 'succeeded',
      outputs: [{ url: 'https://media.example.test/videos/qa-task-001.mp4', kind: 'video' }] });
    assert.deepEqual(wan.normalize(samples.video.running), { status: 'running' });
    assert.deepEqual(wan.normalize(samples.video.failed), { status: 'failed',
      error: '视频生成失败，请稍后重试。', providerMessage: '模型拒绝生成' });
  });

  test('Wan 与 Seedance 均可提交、查询；缺任务 ID 与限流返回 unknown', async () => {
    upstream.setMode('success');
    const prepared = wan.prepare({ prompt: '云层穿行', durationSeconds: 5, tailRef: 'https://media.example.test/tail.png' });
    assert.deepEqual(await wan.submit(prepared, { idempotencyKey: 'wan-one' }),
      { status: 'running', upstreamId: 'qa-task-001' });
    assert.equal(JSON.parse(upstream.requests.at(-1).body).image_file_1, 'https://media.example.test/tail.png');
    assert.deepEqual(await wan.query('qa-task-001'), { status: 'succeeded',
      outputs: [{ url: 'https://media.example.test/videos/qa-task-001.mp4', kind: 'video' }] });
    const noId = createWan30Adapter({ request: async () => ({ status: 'queued' }) });
    assert.deepEqual(await noId.submit(prepared), { status: 'unknown' });
    const rateLimited = createWan30Adapter({ request: async () => { const error = new Error('rate limited');
      error.submitted = true; error.status = 429; throw error; } });
    assert.deepEqual(await rateLimited.submit(prepared), { status: 'unknown' });
  });

  test('视频每个参考仓库 URL 候选位置与终态均正确归一化', async () => {
    const cases = await fixture('modelhub-video-url-candidates.json');
    for (const { label, raw } of cases.cases) {
      assert.deepEqual(normalizeVideo({ status: 'running', ...raw }), { status: 'succeeded',
        outputs: [{ url: 'https://media.example.test/video.mp4', kind: 'video' }] }, label);
    }
    for (const status of ['failed', 'error', 'rejected', 'expired', 'cancelled', 'canceled', 'blocked', 'timeout']) {
      assert.equal(normalizeVideo({ status }).status, 'failed', status);
    }
    for (const status of ['succeeded', 'completed', 'success']) {
      assert.deepEqual(normalizeVideo({ status }), { status: 'unknown' }, status);
    }
    assert.deepEqual(normalizeVideo({ status: 'succeeded', video_url: 'https://user:pass@media.example.test/video.mp4' }),
      { status: 'unknown' });
  });

  test('图片请求字段按模型能力校验，仅取排序第一张参考图', async () => {
    upstream.setMode('success');
    const warnings = [];
    const refs = [];
    const adapter = createModelhubImageAdapter({ transport,
      logger: { warn: (name, details) => warnings.push({ name, details }) },
      loadReference: async (key) => { refs.push(key); return { buffer: TINY_PNG, contentType: 'image/png' }; } });
    const prepared = adapter.prepare({ promptHint: '绘本', description: '女孩',
      referenceKeys: ['users/u1/first.png', 'users/u1/second.png', 'users/u1/third.png'] });
    assert.equal(prepared.quality, '1080p');
    assert.equal(prepared.detail_level, 'medium');
    assert.deepEqual(prepared.referenceKeys, ['users/u1/first.png']);
    assert.equal(prepared.droppedReferences, 2);
    assert.deepEqual(warnings, [{ name: 'image_references_dropped', details: { model: 'gpt-image-2', droppedReferences: 2 } }]);
    const result = await adapter.submit(prepared);
    assert.equal(result.droppedReferences, 2);
    assert.deepEqual(refs, ['users/u1/first.png']);
    const body = upstream.requests.at(-1).body.toString();
    assert.match(body, /name="quality"\r\n\r\n1080p/);
    assert.match(body, /name="detail_level"\r\n\r\nmedium/);
    assert.equal((body.match(/name="images"/g) ?? []).length, 1);
    assert.throws(() => adapter.prepare({ description: '女孩', referenceKeys: [] }, { resolution: '2k' }),
      (error) => error.code === 'PROVIDER_INPUT_INVALID');
  });

  test('图片无参考 JSON 生成，有参考时 multipart compositions；facade 兼容 BE-04', async () => {
    upstream.setMode('success');
    const registry = createRegistry([image]);
    const facade = createImageProvider(registry, { downloadImage: async (url) => {
      assert.equal(url, samples.image.succeeded.data[0].url);
      return { buffer: TINY_PNG, contentType: 'image/png' };
    } });
    const result = await facade.generate({ characterId: 'chr_fixture', styleId: 'realistic',
      promptHint: 'photo-realistic', description: '短发角色', referenceKeys: [] });
    assert.deepEqual(result, { status: 'succeeded', buffer: TINY_PNG, contentType: 'image/png' });
    const without = upstream.requests.at(-1);
    assert.equal(without.path, '/v1/images/generations');
    assert.equal(JSON.parse(without.body).prompt, 'photo-realistic\n短发角色');
    const composed = await facade.generate({ characterId: 'chr_fixture', styleId: 'realistic',
      promptHint: 'photo-realistic', description: '短发角色', referenceKeys: ['users/u1/photo.png'] });
    assert.equal(composed.status, 'succeeded');
    const withReference = upstream.requests.at(-1);
    assert.equal(withReference.path, '/v1/images/compositions');
    assert.match(withReference.headers['content-type'], /multipart\/form-data/);
    assert.ok(withReference.body.includes(Buffer.from('name="images"')));
  });

  test('图片业务失败、响应缺 URL 与图片重生成不复用固定上游幂等键', async () => {
    upstream.setMode('success');
    const registry = createRegistry([image]);
    const facade = createImageProvider(registry, { downloadImage: async () => ({ buffer: TINY_PNG, contentType: 'image/png' }) });
    const input = { characterId: 'chr_repeat', styleId: 'realistic', promptHint: '写实', description: '短发', referenceKeys: [] };
    await facade.generate(input);
    await facade.generate(input);
    const latest = upstream.requests.slice(-2);
    assert.ok(latest.every((request) => !request.headers['idempotency-key']), '重复生成不能使用固定 characterId:styleId 键');
    upstream.setMode('reject');
    assert.deepEqual(await facade.generate(input), { status: 'failed',
      error: '图片生成请求被渠道拒绝，请稍后重试。', providerMessage: '图片内容不符合要求' });
    upstream.setMode('upstream-failure');
    assert.deepEqual(await facade.generate(input), { status: 'unknown' });
    upstream.setMode('success');
    assert.deepEqual(image.normalize({ data: [] }), { status: 'unknown' });
    assert.deepEqual(image.normalize(samples.image.failed), { status: 'failed',
      error: '图片生成失败，请修改内容后重试。', providerMessage: '图片内容不符合要求' });
    assert.deepEqual(wan.normalize({ status: 'succeeded', result: { url: 'https://media.example.test/compat.mp4' } }),
      { status: 'succeeded', outputs: [{ url: 'https://media.example.test/compat.mp4', kind: 'video' }] });
  });

  test('视频失败用户提示固定中文，上游原文只进运维字段；本地输入错误记日志', async () => {
    const result = wan.normalize({ status: 'failed', error: { message: 'upstream secret details'.repeat(20) } });
    assert.equal(result.error, '视频生成失败，请稍后重试。');
    assert.equal(result.providerMessage.length, 200);
    assert.ok(!result.error.includes('upstream'));
    const errors = [];
    const facade = createImageProvider(createRegistry([image]), { sku: { resolution: '2k' },
      downloadImage: async () => ({ buffer: TINY_PNG }), logger: { error: (...args) => errors.push(args) } });
    const invalid = await facade.generate({ characterId: 'chr_invalid', styleId: 'realistic',
      promptHint: '风格', description: '角色', referenceKeys: [] });
    assert.equal(invalid.status, 'failed');
    assert.equal(errors[0][0], 'image_provider_local_invalid');
    assert.equal(errors[0][1].code, 'PROVIDER_INPUT_INVALID');
  });

  test('参考照片读取失败可重试且未提交，恢复后仅调用上游一次', async () => {
    upstream.setMode('success');
    let reads = 0;
    const before = upstream.requests.length;
    const adapter = createModelhubImageAdapter({ transport, loadReference: async () => {
      reads += 1;
      if (reads === 1) throw new Error('storage 503');
      return { buffer: TINY_PNG, contentType: 'image/png' };
    } });
    const facade = createImageProvider(createRegistry([adapter]), {
      downloadImage: async () => ({ buffer: TINY_PNG, contentType: 'image/png' }),
    });
    const input = { characterId: 'chr_reference', styleId: 'realistic', promptHint: '写实',
      description: '虚构角色', referenceKeys: ['users/u1/reference.png'] };
    await assert.rejects(() => facade.generate(input), (error) => error.code === 'PROVIDER_REFERENCE_UNAVAILABLE'
      && error.submitted === false && error.retryable === true);
    assert.equal(upstream.requests.length, before, '读取失败前未调用上游');
    assert.equal((await facade.generate(input)).status, 'succeeded');
    assert.equal(reads, 2);
    assert.equal(upstream.requests.length, before + 1, '恢复后只提交一次');
    const malformed = createModelhubImageAdapter({ transport, loadReference: async () => ({ buffer: 'not-a-buffer' }) });
    const badFacade = createImageProvider(createRegistry([malformed]), {
      downloadImage: async () => ({ buffer: TINY_PNG }),
    });
    assert.equal((await badFacade.generate(input)).status, 'failed', '非 Buffer 属输入错误，不重试');
    assert.equal(upstream.requests.length, before + 1);
  });

  test('图片拒绝分类、429 重试、下载最多三次且不重提交', async () => {
    const registry = createRegistry([image]);
    const errors = [];
    let downloads = 0;
    const facade = createImageProvider(registry, { downloadImage: async () => {
      downloads += 1;
      if (downloads < 3) throw new Error('temporary download failure');
      return { buffer: TINY_PNG, contentType: 'image/png' };
    }, sleep: async () => {}, logger: { error: (...args) => errors.push(args) } });
    const input = { characterId: 'chr_a', styleId: 'realistic', promptHint: '写实', description: '女孩', referenceKeys: [] };
    upstream.setMode('success');
    const before = upstream.requests.length;
    assert.equal((await facade.generate(input)).status, 'succeeded');
    assert.equal(downloads, 3);
    assert.equal(upstream.requests.length - before, 1, '下载重试不得重新提交模型任务');
    upstream.setMode('reject');
    const failed = await facade.generate(input);
    assert.equal(failed.status, 'failed');
    assert.ok(!failed.error.includes('图片内容不符合要求'), '用户错误不得含上游原文');
    assert.equal(failed.providerMessage, '图片内容不符合要求');
    const rateLimited = createImageProvider(createRegistry([createModelhubImageAdapter({
      transport: { request: async () => { const error = new Error('429'); error.retryable = true; error.submitted = false;
        error.retryAfter = '2'; throw error; } },
    })]), { downloadImage: async () => ({ buffer: TINY_PNG }) });
    await assert.rejects(() => rateLimited.generate(input), (error) => error.retryable === true
      && error.submitted === false && error.retryAfter === '2');
    upstream.setMode('success');
  });

  test('响应体上限 1MB，拒绝类错误保留截断上游详情并记录鉴权故障', async () => {
    const transportLogs = [];
    const authTransport = createModelhubTransport({ baseUrl, apiKey: 'fixture-token', logger: {
      error: (...args) => transportLogs.push(args),
    }, fetchImpl: async () => new Response(JSON.stringify({ error: { code: 'AUTH', message: 'x'.repeat(240) } }),
      { status: 401, headers: { 'Content-Type': 'application/json' } }) });
    await assert.rejects(() => authTransport.request('/v1/images/generations', { method: 'POST', body: {} }),
      (error) => error.submitted === false && error.retryable === false && error.providerMessage.length === 200
        && error.providerCode === 'AUTH');
    assert.equal(transportLogs.length, 1);
    const oversized = createModelhubTransport({ baseUrl, apiKey: 'fixture-token', fetchImpl: async () =>
      new Response(JSON.stringify({ data: 'x'.repeat(1024 * 1024 + 1) }), { status: 200 }) });
    await assert.rejects(() => oversized.request('/v1/images/generations', { method: 'POST', body: {} }),
      (error) => error.code === 'SUBMISSION_UNKNOWN');
  });

  test('失败分类：明确 4xx/连接拒绝 submitted=false，受理后断开/超时/5xx 返回 unknown', async () => {
    const prepared = wan.prepare({ prompt: '测试', durationSeconds: 5 });
    upstream.setMode('reject');
    await assert.rejects(() => wan.submit(prepared), (error) => error.submitted === false && error.status === 400);
    upstream.setMode('upstream-failure');
    assert.deepEqual(await wan.submit(prepared), { status: 'unknown' });
    upstream.setMode('accepted-disconnect');
    assert.deepEqual(await wan.submit(prepared), { status: 'unknown' });
    upstream.setMode('timeout');
    const timeoutTransport = createModelhubTransport({ baseUrl, apiKey: 'fixture-token', timeoutMs: 60 });
    assert.deepEqual(await createWan30Adapter(timeoutTransport).submit(prepared), { status: 'unknown' });
    const closed = createServer();
    closed.listen(0, '127.0.0.1');
    await new Promise((resolve) => closed.once('listening', resolve));
    const closedPort = closed.address().port;
    await new Promise((resolve) => closed.close(resolve));
    const refused = createModelhubTransport({ baseUrl: `http://127.0.0.1:${closedPort}`, apiKey: 'fixture-token', timeoutMs: 2500 });
    await assert.rejects(() => createWan30Adapter(refused).submit(prepared), (error) => error.submitted === false);
    upstream.setMode('success');
  });
});
