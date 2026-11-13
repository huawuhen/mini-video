// vidu 驱动测试：共用契约套件（样本回放，零真实费用）+ 本驱动特有场景
// （Token 鉴权、接口选型 reference2video/text2video、480p→540p 映射、时长与提示词上限、
//   参考图 7 张截断、credits 透传、余额测试接口、配置校验）。
import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import driver from './index.js';
import { pickVideoUrl } from './index.js';
import {
  runVideoDriverContract, contractChannel, createScriptedFetch, consoleCapture,
} from '../../contract-test.js';
import { ProviderError } from '../../contract.js';

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

const channel = contractChannel({
  kind: 'video', driver: 'vidu', modelMap: { video: 'viduq3-turbo' },
  params: { requestTimeoutMs: 300 },
});

const build = ({ fetchImpl, logger }) => driver.create(channel, { logger, deps: { fetchImpl } });

runVideoDriverContract({
  title: 'vidu 契约',
  build,
  fixtures: {
    submitAccepted: fixture('submit-accepted.json'),
    submitRejected: fixture('submit-rejected.json'),
    queryRunning: fixture('query-running.json'),
    querySucceeded: fixture('query-succeeded.json'),
    queryFailed: fixture('query-failed.json'),
  },
});

// ───────── 本驱动特有场景 ─────────

test('vidu：Token 方案鉴权 + 有参考图走 reference2video + 480p 提交为 540p', async () => {
  const seen = [];
  const fetchImpl = async (url, init = {}) => {
    seen.push({ url: String(url), auth: String(init.headers?.Authorization ?? ''), body: init.body });
    return { status: 200, ok: true, text: async () => JSON.stringify(fixture('submit-accepted.json')) };
  };
  const instance = build({ fetchImpl, logger: consoleCapture() });
  const prepared = instance.prepare({
    prompt: 'A girl waves at the camera.',
    imageRefs: ['https://cdn.example.test/looks/lkv_1.png'],
    audioRefs: ['https://cdn.example.test/voices/v1.wav'], // Vidu 无音频参考入参：忽略
    durationSeconds: 5, ratio: '9:16', resolution: '480p',
  }, {});
  const result = await instance.submit(prepared, {});
  assert.equal(result.status, 'running');
  assert.equal(result.upstreamId, 'task_3f9k2m8q0001');
  assert.equal(seen.length, 1);
  assert.match(seen[0].auth, /^Token /, '鉴权必须是 Token 方案');
  assert.ok(seen[0].url.includes('/ent/v2/reference2video'), '有参考图走参考生接口');
  const body = JSON.parse(seen[0].body);
  assert.equal(body.model, 'viduq3-turbo');
  assert.equal(body.resolution, '540p', '产品 480p → Vidu 540p');
  assert.equal(body.aspect_ratio, '9:16');
  assert.equal(body.duration, 5);
  assert.equal(body.audio, true);
  assert.equal(body.off_peak, false);
  assert.deepEqual(body.images, ['https://cdn.example.test/looks/lkv_1.png']);
  assert.ok(!('audio_refs' in body) && !JSON.stringify(body).includes('voices/v1.wav'), '音频参考不进请求体');
});

test('vidu：无参考图回退 text2video（pro 支持、viduq3 明确拒绝）', async () => {
  const scripted = createScriptedFetch([
    { match: '/ent/v2/text2video', method: 'POST', status: 200, json: fixture('submit-accepted.json') },
  ]);
  const instance = build({ fetchImpl: scripted.fetchImpl, logger: consoleCapture() });
  const prepared = instance.prepare({
    prompt: 'A empty street at dusk, wind blows.', imageRefs: [], audioRefs: [],
    durationSeconds: 5, ratio: '16:9', resolution: '720p',
  }, {});
  const result = await instance.submit(prepared, {});
  assert.equal(result.status, 'running');
  assert.equal(scripted.remaining, 0);

  const q3OnlyRef = driver.create(contractChannel({ kind: 'video', driver: 'vidu', modelMap: { video: 'viduq3' } }),
    { logger: consoleCapture() });
  assert.throws(() => q3OnlyRef.prepare({
    prompt: 'p', imageRefs: [], audioRefs: [], durationSeconds: 5, ratio: '16:9', resolution: '720p',
  }), (error) => error instanceof ProviderError && error.code === 'PROVIDER_INPUT_INVALID');
});

test('vidu：时长与 SKU 校验（30 秒明确拒绝、sku.durations 白名单）', () => {
  const instance = build({ fetchImpl: createScriptedFetch([]).fetchImpl, logger: consoleCapture() });
  const base = { prompt: 'p', imageRefs: ['https://cdn.example.test/a.png'], audioRefs: [],
    ratio: '9:16', resolution: '480p' };
  assert.throws(() => instance.prepare({ ...base, durationSeconds: 30 }), (error) => {
    assert.ok(error instanceof ProviderError);
    assert.equal(error.code, 'PROVIDER_INPUT_INVALID');
    assert.equal(error.submitted, false);
    return true;
  }, '参考生 turbo 上限 15 秒，30 秒段必须明确拒绝（SKU 已收窄，见迁移 017）');
  assert.throws(() => instance.prepare({ ...base, durationSeconds: 10 }, { durations: [5, 15] }), ProviderError);
  assert.doesNotThrow(() => instance.prepare({ ...base, durationSeconds: 15 }));
});

test('vidu：提示词上限（turbo 5000）与分辨率/画幅校验', () => {
  const instance = build({ fetchImpl: createScriptedFetch([]).fetchImpl, logger: consoleCapture() });
  const base = { imageRefs: [], audioRefs: [], durationSeconds: 5, ratio: '16:9', resolution: '720p' };
  assert.throws(() => instance.prepare({ ...base, prompt: '长'.repeat(5001) }), ProviderError);
  assert.doesNotThrow(() => instance.prepare({ ...base, prompt: '长'.repeat(5000) }));
  assert.throws(() => instance.prepare({ ...base, prompt: 'p', resolution: '2k' }), ProviderError);
  assert.throws(() => instance.prepare({ ...base, prompt: 'p', ratio: '21:9' }), ProviderError);
});

test('vidu：参考图超 7 张截断（保序，尾帧在最前）并记日志', () => {
  const logger = consoleCapture();
  const instance = build({ fetchImpl: createScriptedFetch([]).fetchImpl, logger });
  const images = Array.from({ length: 9 }, (_, i) => `https://cdn.example.test/ref-${i}.png`);
  const prepared = instance.prepare({
    prompt: 'p', imageRefs: images, audioRefs: [], durationSeconds: 10, ratio: '9:16', resolution: '720p',
  }, {});
  assert.deepEqual(prepared.body.images, images.slice(0, 7), '截断保留前 7 张（图1=尾帧优先）');
  const warn = logger.entries.find((entry) => entry.event === 'vidu_ref_truncated');
  assert.ok(warn && warn.fields.dropped === 2, '截断量进日志');
});

test('vidu：成功态无 creations 地址 → unknown（不伪造成功）', async () => {
  const scripted = createScriptedFetch([
    { match: '/ent/v2/tasks/', method: 'GET', status: 200,
      json: { id: 't1', state: 'success', err_code: '', credits: 35, creations: [] } },
  ]);
  const instance = build({ fetchImpl: scripted.fetchImpl, logger: consoleCapture() });
  const result = await instance.query('t1');
  assert.equal(result.status, 'unknown');
});

test('vidu：credits 透传 usage（成本校准依据，积分口径）', async () => {
  const scripted = createScriptedFetch([
    { match: '/ent/v2/tasks/', method: 'GET', status: 200, json: fixture('query-succeeded.json') },
  ]);
  const instance = build({ fetchImpl: scripted.fetchImpl, logger: consoleCapture() });
  const result = await instance.query('task_3f9k2m8q0001');
  assert.equal(result.usage.credits, 35);
});

test('vidu：TaskNotFound（404）→ failed；err_code 进 providerCode', async () => {
  const scripted = createScriptedFetch([
    { match: '/ent/v2/tasks/', method: 'GET', status: 404,
      json: { code: 'TaskNotFound', message: 'task not found' } },
  ]);
  const instance = build({ fetchImpl: scripted.fetchImpl, logger: consoleCapture() });
  const result = await instance.query('gone');
  assert.equal(result.status, 'failed');
});

test('vidu：catalog() 走余额接口并汇总积分/并发（channel:test 免费连通检查）', async () => {
  const scripted = createScriptedFetch([
    { match: '/ent/v2/credits', method: 'GET', status: 200, json: fixture('credits.json') },
  ]);
  const instance = build({ fetchImpl: scripted.fetchImpl, logger: consoleCapture() });
  const catalog = await instance.catalog();
  assert.deepEqual(catalog.models.map((m) => m.name), ['viduq3-turbo']);
  assert.equal(catalog.balance.credits, 160000);
  assert.equal(catalog.balance.concurrency, 5);
});

test('vidu：配置校验（未知模型拒绝、audio=false+offPeak 矛盾拒绝）', () => {
  const logger = consoleCapture();
  assert.throws(() => driver.create(
    contractChannel({ kind: 'video', driver: 'vidu', modelMap: { video: 'viduq3-pro-fast' } }), { logger },
  ), (error) => error instanceof ProviderError && error.code === 'PROVIDER_CONFIG_INVALID');
  assert.throws(() => driver.create(
    contractChannel({ kind: 'video', driver: 'vidu', modelMap: { video: 'viduq3-turbo' },
      params: { audio: false, offPeak: true } }), { logger },
  ), (error) => error instanceof ProviderError && error.code === 'PROVIDER_CONFIG_INVALID');
});

test('vidu：pickVideoUrl 拒绝非 https 用户名链接', () => {
  assert.equal(pickVideoUrl({ creations: [{ url: 'https://u:p@evil.example/x.mp4' }] }), null);
  assert.equal(pickVideoUrl({ creations: [{ url: 'ftp://x/y.mp4' }] }), null);
  assert.equal(pickVideoUrl({ creations: [{ url: 'https://ok.example/a.mp4' }] }), 'https://ok.example/a.mp4');
});

// ───────── M3-ENG-02：音色码 → voice_id 映射（渠道参数，单说话人由业务层判定） ─────────

const voiceChannel = (voiceIdMap) => contractChannel({
  kind: 'video', driver: 'vidu', modelMap: { video: 'viduq3-turbo' },
  params: { voiceIdMap },
});
const voiceInput = (voiceCode) => ({
  prompt: 'p', imageRefs: ['https://cdn.example.test/a.png'], audioRefs: [],
  durationSeconds: 5, ratio: '9:16', resolution: '480p', ...(voiceCode ? { voiceCode } : {}),
});
/** 建一个注入 scripted fetch 的实例（reference2video 单步回放），submit 后返回请求体。 */
const makeVoice = (voiceIdMap, { endpoint = '/ent/v2/reference2video' } = {}) => {
  const scripted = createScriptedFetch([
    { match: endpoint, method: 'POST', status: 200, json: fixture('submit-accepted.json') },
  ]);
  const logger = consoleCapture();
  const instance = driver.create(voiceChannel(voiceIdMap), { logger, deps: { fetchImpl: scripted.fetchImpl } });
  return {
    instance, scripted, logger,
    async submitBody(prepared) {
      await instance.submit(prepared, {});
      return JSON.parse(scripted.calls[0].body);
    },
  };
};

test('vidu：voiceIdMap 命中 → 参考生请求带 voice_id（映射为厂商音色）', async () => {
  const voice = makeVoice({ vc_childf_sweet: 'vidu_voice_01' });
  const body = await voice.submitBody(voice.instance.prepare(voiceInput('vc_childf_sweet'), {}));
  assert.equal(body.voice_id, 'vidu_voice_01', '音色码映射为厂商 voice_id');
  assert.ok(!JSON.stringify(body).includes('vc_childf_sweet'), '产品音色码不进上游请求');
});

test('vidu：未映射音色码 → 不传 voice_id 交渠道自动分配 + 记日志', async () => {
  const voice = makeVoice({ vc_childf_sweet: 'vidu_voice_01' });
  const body = await voice.submitBody(voice.instance.prepare(voiceInput('vc_unknown'), {}));
  assert.ok(!('voice_id' in body), '未知音色码不透传给上游');
  assert.ok(voice.logger.entries.some((e) => e.event === 'vidu_voice_unmapped' && e.fields.voiceCode === 'vc_unknown'));
});

test('vidu：voiceIdMap 的 "*" 兜底生效；无映射参数时不带 voice_id', async () => {
  const fallback = makeVoice({ '*': 'vidu_default' });
  const body = await fallback.submitBody(fallback.instance.prepare(voiceInput('vc_any'), {}));
  assert.equal(body.voice_id, 'vidu_default');
  const none = makeVoice(undefined);
  const body2 = await none.submitBody(none.instance.prepare(voiceInput('vc_any'), {}));
  assert.ok(!('voice_id' in body2));
});

test('vidu：voice_id 只进参考生接口；文生不带（官方文生页未列该参数）', async () => {
  const voice = makeVoice({ vc_childf_sweet: 'vidu_voice_01' }, { endpoint: '/ent/v2/text2video' });
  const prepared = voice.instance.prepare({
    prompt: 'p', imageRefs: [], audioRefs: [], voiceCode: 'vc_childf_sweet',
    durationSeconds: 5, ratio: '16:9', resolution: '720p',
  }, {});
  const result = await voice.instance.submit(prepared, {});
  assert.equal(result.status, 'running');
  assert.equal(JSON.parse(voice.scripted.calls[0].body).voice_id, undefined, '文生请求不带 voice_id');
});
