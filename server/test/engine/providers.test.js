import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRegistry, createWan30Adapter, createSeedance25Adapter,
  createModelhubImageAdapter, createImageProvider, createModelhubTransport } from '../../src/engine/providers/index.js';
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
    transport = createModelhubTransport({ baseUrl, apiKey: 'fixture-token', timeoutMs: 70 });
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

  test('Wan/Seedance prepare：图片、音频参考及首帧对应编号字段', () => {
    const payload = wan.prepare({ prompt: '镜头向前移动', durationSeconds: 10, imageRefs: ['https://media.example.test/character.png'],
      audioRefs: ['https://media.example.test/voice.wav'], firstFrame: 'https://media.example.test/tail.png', ratio: '9:16' },
    { durations: [5, 10, 15], resolution: '720p' });
    assert.deepEqual(payload, { model: 'wan-3.0', prompt: '镜头向前移动', resolution: '720p', ratio: '9:16', duration: 10,
      functionMode: 'omni_reference', image_file_1: 'https://media.example.test/tail.png',
      image_file_2: 'https://media.example.test/character.png', audio_file_1: 'https://media.example.test/voice.wav' });
    const other = seedance.prepare({ prompt: '片段', durationSeconds: 30, imageRefs: [], audioRefs: ['https://media.example.test/voice.wav'] });
    assert.equal(other.model, 'seedance-2.5');
    assert.throws(() => wan.prepare({ prompt: '片段', durationSeconds: 31 }), /时长/);
    assert.throws(() => seedance.prepare({ prompt: '片段', durationSeconds: 10, functionMode: 'first_last_frames',
      audioRefs: ['https://media.example.test/voice.wav'] }), /音频/);
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
    assert.deepEqual(wan.normalize(samples.video.failed), { status: 'failed', error: '模型拒绝生成' });
  });

  test('Wan 与 Seedance 均可提交、查询；缺任务 ID 与限流返回 unknown', async () => {
    upstream.setMode('success');
    const prepared = wan.prepare({ prompt: '云层穿行', durationSeconds: 5, firstFrame: 'https://media.example.test/first.png' });
    assert.deepEqual(await wan.submit(prepared, { idempotencyKey: 'wan-one' }),
      { status: 'running', upstreamId: 'qa-task-001' });
    assert.equal(JSON.parse(upstream.requests.at(-1).body).image_file_1, 'https://media.example.test/first.png');
    assert.deepEqual(await wan.query('qa-task-001'), { status: 'succeeded',
      outputs: [{ url: 'https://media.example.test/videos/qa-task-001.mp4', kind: 'video' }] });
    const noId = createWan30Adapter({ request: async () => ({ status: 'queued' }) });
    assert.deepEqual(await noId.submit(prepared), { status: 'unknown' });
    const rateLimited = createWan30Adapter({ request: async () => { const error = new Error('rate limited');
      error.submitted = true; error.status = 429; throw error; } });
    assert.deepEqual(await rateLimited.submit(prepared), { status: 'unknown' });
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
    await assert.rejects(() => facade.generate(input), (error) => error.submitted === false && error.status === 400);
    upstream.setMode('upstream-failure');
    assert.deepEqual(await facade.generate(input), { status: 'unknown' });
    upstream.setMode('success');
    assert.deepEqual(image.normalize({ data: [] }), { status: 'unknown' });
    assert.deepEqual(image.normalize(samples.image.failed), { status: 'failed', error: '图片内容不符合要求' });
    assert.deepEqual(wan.normalize({ status: 'succeeded', result: { url: 'https://media.example.test/compat.mp4' } }),
      { status: 'succeeded', outputs: [{ url: 'https://media.example.test/compat.mp4', kind: 'video' }] });
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
    assert.deepEqual(await wan.submit(prepared), { status: 'unknown' });
    const closed = createServer();
    closed.listen(0, '127.0.0.1');
    await new Promise((resolve) => closed.once('listening', resolve));
    const closedPort = closed.address().port;
    await new Promise((resolve) => closed.close(resolve));
    const refused = createModelhubTransport({ baseUrl: `http://127.0.0.1:${closedPort}`, apiKey: 'fixture-token', timeoutMs: 100 });
    await assert.rejects(() => createWan30Adapter(refused).submit(prepared), (error) => error.submitted === false);
    upstream.setMode('success');
  });
});
