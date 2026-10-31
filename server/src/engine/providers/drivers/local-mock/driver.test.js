// local-mock 驱动测试（M2-WEB-01 零费用联调）：三种能力各跑共用契约套件（scripted fetch 回放），
// 行为场景走真实进程内模拟服务（含 ffmpeg 生成样片/图片——与 render 测试同环境前提），
// 以及 devOnly 生产拒绝（registry 不注册 + create 拒绝）与 seedMockChannels 生产拒绝（见 test/channels）。
import assert from 'node:assert/strict';
import test from 'node:test';
import driver, { MOCK_PLAN, MOCK_TIMELINES, MOCK_EXPAND } from './index.js';
import {
  runVideoDriverContract, runImageDriverContract, runLlmDriverContract,
  contractChannel, createScriptedFetch, consoleCapture,
} from '../../contract-test.js';

const TINY_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const fakeStorage = () => {
  const puts = [];
  return {
    puts,
    async put(key, buffer) { puts.push({ key, size: buffer.length }); },
    async signedUrl(key) { return `https://mock.example.test/${key}`; },
  };
};

const build = ({ fetchImpl, logger, deps = {} }) => driver.create(
  contractChannel({ kind: 'video', driver: 'local-mock', credential: 'sk-local-mock-test-0000',
    params: { requestTimeoutMs: 400 } }), // 契约 hang 场景按短超时快速失败
  { logger, deps: { fetchImpl, storage: deps.storage ?? fakeStorage() } });

runVideoDriverContract({
  title: 'local-mock/video 契约',
  build,
  fixtures: {
    submitAccepted: { task_id: 't_contract_1' },
    submitRejected: { error: { message: '模拟：渠道拒绝了这次视频生成请求' } },
    queryRunning: { status: 'running' },
    querySucceeded: { status: 'succeeded', video_b64: Buffer.from('fake-mp4-bytes').toString('base64'),
      usage: { total_tokens: 5000 } },
    queryFailed: { status: 'failed', error: { message: '模拟：视频生成失败' } },
  },
});

runImageDriverContract({
  title: 'local-mock/image 契约',
  build: ({ fetchImpl, logger }) => driver.create(
    contractChannel({ kind: 'image', driver: 'local-mock', params: { requestTimeoutMs: 400 } }), { logger, deps: { fetchImpl } }),
  fixtures: {
    generateAccepted: { b64_png: TINY_PNG_B64 },
    generateRejected: { error: { message: '模拟：渠道拒绝了这次图片生成请求' } },
  },
});

runLlmDriverContract({
  title: 'local-mock/llm 契约',
  build: ({ fetchImpl, logger }) => driver.create(
    contractChannel({ kind: 'llm', driver: 'local-mock', params: { requestTimeoutMs: 400 } }), { logger, deps: { fetchImpl } }),
  fixtures: {
    completeAccepted: { choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 1, completion_tokens: 2 } },
  },
});

// ───────── 行为场景（真实进程内模拟服务；fetchImpl 用全局 fetch）─────────

const channelOf = (kind, params = {}) => ({
  ...contractChannel({ kind, driver: 'local-mock' }),
  params: { delayMs: 20, minRunningMs: 250, ...params },
});

test('local-mock/video：prepare 必须同步返回对象（契约：调用方不 await）', () => {
  const instance = driver.create(contractChannel({ kind: 'video', driver: 'local-mock' }), { logger: consoleCapture(), deps: {} });
  const prepared = instance.prepare({ prompt: 'p', durationSeconds: 30, ratio: '9:16', resolution: '480p' }, {});
  assert.ok(typeof prepared === 'object' && !(prepared instanceof Promise), '不得返回 Promise');
  assert.equal(prepared.durationSeconds, 30);
});

test('local-mock/video：异步语义——提交 running → 排队期 running → 出片经存储签名链接（幂等上传一次）', async () => {
  const storage = fakeStorage();
  const instance = driver.create(channelOf('video'), { logger: consoleCapture(), deps: { storage } });
  const prepared = instance.prepare({ prompt: 'p', imageRefs: [], audioRefs: [],
    durationSeconds: 5, ratio: '9:16', resolution: '480p' }, { resolution: '480p' });
  const submitted = await instance.submit(prepared, {});
  assert.equal(submitted.status, 'running');
  assert.ok(submitted.upstreamId);
  assert.equal((await instance.query(submitted.upstreamId)).status, 'running'); // 排队期内
  await new Promise((resolve) => setTimeout(resolve, 350));
  const done = await instance.query(submitted.upstreamId);
  assert.equal(done.status, 'succeeded');
  assert.match(done.outputs[0].url, /^https:\/\/mock\.example\.test\/mock\/videos\//);
  assert.equal(done.usage.total_tokens, 5000); // 1000 tokens/秒 × 5 秒
  await instance.query(submitted.upstreamId); // 再次轮询：不重复上传
  assert.equal(storage.puts.length, 1);
});

test('local-mock/video：failRate=1 → 明确失败（中文提示）；unknownRate=1 → 结果未知', async () => {
  const failing = driver.create(channelOf('video', { failRate: 1 }), { logger: consoleCapture(), deps: { storage: fakeStorage() } });
  const failed = await failing.submit(instance0Input(), {});
  assert.equal(failed.status, 'failed');
  assert.ok(/被渠道拒绝/.test(failed.error), '业务中文口径（与真实驱动一致），不带模拟字样');
  assert.ok(String(failed.providerMessage ?? '').includes('local-mock'), '模拟标记只进 providerMessage');
  const unknown = driver.create(channelOf('video', { unknownRate: 1 }), { logger: consoleCapture(), deps: { storage: fakeStorage() } });
  assert.equal((await unknown.submit(instance0Input(), {})).status, 'unknown');
});
const instance0Input = () => ({ prompt: 'p', durationSeconds: 5, ratio: '9:16', resolution: '480p' });

test('local-mock/image：生成 PNG buffer（ffmpeg 渐变图，按 characterId 取色）', async () => {
  const instance = driver.create(channelOf('image'), { logger: consoleCapture(), deps: {} });
  const result = await instance.generate({ characterId: 'chr_mock0001', promptHint: '可爱', referenceKeys: [] });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.contentType, 'image/png');
  assert.ok(result.buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'PNG 魔数');
});

test('local-mock/llm：按提示词返回固定合法 JSON——规划（STORY_EXAMPLE 同源）/ 扩写 / 镜头时间线', async () => {
  const instance = driver.create(channelOf('llm'), { logger: consoleCapture(), deps: {} });
  const plan = JSON.parse((await instance.complete({
    system: '你是家庭影像的编剧与导演。输出 cast/segments/castIndexes…',
    messages: [{ role: 'user', content: '周末去公园野餐的故事' }] })).text);
  assert.equal(plan.segments.length, 2);
  assert.deepEqual(plan.segments.map((s) => s.durationSeconds), [30, 30]);
  assert.equal(plan.segments[1].transition, 'prev_tail');
  const expand = JSON.parse((await instance.complete({
    system: '你是家庭影像的编剧。把用户的一句话想法扩写成可拍摄的中文短剧剧本，只返回 JSON。',
    messages: [{ role: 'user', content: '想法' }] })).text);
  assert.equal(expand.title, MOCK_EXPAND.title);
  assert.ok(expand.script.length > 20);
  // 回归：understand 的提示词可能提到「扩写」二字，但不是扩写调用——必须返回规划
  const notExpand = JSON.parse((await instance.complete({
    system: '你是家庭影像的编剧与导演。一句话想法会先扩写成剧本，现在请理解以下剧本并规划。',
    messages: [{ role: 'user', content: '公园的下午剧本全文' }] })).text);
  assert.equal(notExpand.title, MOCK_PLAN.title);
  assert.ok(Array.isArray(notExpand.cast));
  const timelineA = JSON.parse((await instance.complete({
    system: '你是参考生视频的分镜导演…镜头时间线…shots…', messages: [{ role: 'user', content: '剧情对白：「慢一点，看看树叶。」该片段时长 30 秒' }] })).text);
  assert.equal(timelineA.shots.length, 4);
  assert.deepEqual(timelineA.shots.map((s) => [s.start, s.end]), [[0, 7], [7, 14], [14, 21], [21, 30]]);
  assert.equal(timelineA.shots.at(-1).dialogue[0].line, '慢一点，看看树叶。'); // 逐字一致（skill 校验）
  assert.equal(timelineA.shots.at(-1).end - timelineA.shots.at(-1).start, 9); // 9 秒镜头必须带对白（上限 10）
  const timelineB = JSON.parse((await instance.complete({
    system: '你是参考生视频的分镜导演…镜头时间线…', messages: [{ role: 'user', content: '剧情对白：「这个苹果真甜！」' }] })).text);
  assert.equal(timelineB.shots.at(-1).dialogue[0].line, '这个苹果真甜！');
  assert.deepEqual(timelineA.avoid, []);
});

test('local-mock/llm：failRate=1 → 抛错（story agent 进入修复重试/兜底）', async () => {
  const instance = driver.create(channelOf('llm', { failRate: 1 }), { logger: consoleCapture(), deps: {} });
  await assert.rejects(instance.complete({ system: 's', messages: [{ role: 'user', content: 'x' }] }));
});

// ───────── devOnly：生产环境拒绝 ─────────

test('local-mock：NODE_ENV=production 时 create 拒绝、registry 不注册；恢复后正常', async () => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    assert.throws(() => driver.create(contractChannel({ kind: 'video', driver: 'local-mock' }), {}),
      /禁止在生产环境使用/);
    const { loadDriverRegistry } = await import('../../registry.js');
    const registry = await loadDriverRegistry({ logger: consoleCapture() });
    assert.equal(registry.has('local-mock'), false, '生产环境不得注册 local-mock');
    assert.equal(registry.has('aiide-ark'), true, '真实驱动不受影响');
  } finally {
    process.env.NODE_ENV = previous;
  }
  const { loadDriverRegistry } = await import('../../registry.js');
  const registry = await loadDriverRegistry({ logger: consoleCapture() });
  assert.equal(registry.has('local-mock'), true, '非生产环境正常注册');
});
