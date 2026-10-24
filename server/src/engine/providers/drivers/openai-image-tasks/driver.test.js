// openai-image-tasks 驱动测试：共用契约套件 + 特有场景（站内 content 下载带 Bearer、轮询抖动续轮、超时）。
import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import driver from './index.js';
import { runImageDriverContract, contractChannel, createScriptedFetch, consoleCapture } from '../../contract-test.js';

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

const channel = contractChannel({
  kind: 'image', driver: 'openai-image-tasks',
  modelMap: { image: 'GPT-image-2' },
  params: { requestTimeoutMs: 300, pollIntervalMs: 1, pollTimeoutMs: 2_000 },
});

const downloads = [];
const build = ({ fetchImpl, logger, deps = {} }) => driver.create(channel, {
  logger,
  deps: {
    fetchImpl,
    downloadImage: deps.downloadImage ?? (async (url, headers) => {
      downloads.push({ url, headers });
      return { buffer: TINY_PNG, contentType: 'image/png' };
    }),
  },
});

runImageDriverContract({
  title: 'openai-image-tasks 契约',
  build,
  imageInput: { characterId: 'chr_1', styleId: 'style_cute', promptHint: 'cute 3d', description: 'mother', referenceKeys: [] },
  fixtures: {
    // 本协议成功路径是「提交 → 轮询 pending → 轮询 ready」三步（下载由 deps 完成），按步骤序列回放
    generateAccepted: [
      { match: '/v1/images', method: 'POST', status: 200, json: fixture('generate-accepted-pending.json') },
      { match: '/v1/images/img_', method: 'GET', status: 200, json: fixture('generate-accepted-ready.json') },
    ],
    generateRejected: fixture('generate-rejected.json'),
  },
});

// 契约套件只回放单个响应，本协议是「提交→轮询→下载」三段；直接补齐等价断言：
test('openai-image-tasks：提交 → 轮询 ready → 站内 content 下载带 Bearer', async () => {
  downloads.length = 0;
  const scripted = createScriptedFetch([
    { match: '/v1/images', method: 'POST', status: 200, json: fixture('generate-accepted-pending.json') },
    { match: '/v1/images/img_', method: 'GET', status: 200, json: fixture('generate-accepted-pending.json') },
    { match: '/v1/images/img_', method: 'GET', status: 200, json: fixture('generate-accepted-ready.json') },
  ]);
  const instance = build({ fetchImpl: scripted.fetchImpl, logger: consoleCapture() });
  const result = await instance.generate({ promptHint: 'cute 3d', description: 'mother', referenceKeys: [] });
  assert.equal(result.status, 'succeeded');
  assert.ok(Buffer.isBuffer(result.buffer));
  assert.equal(downloads.length, 1);
  assert.equal(downloads[0].url, 'https://channel.example.test/v1/images/img_20261022_0001/content');
  assert.ok(/Bearer .+/.test(String(downloads[0].headers?.Authorization ?? '')), '站内 content 需带鉴权');
});

test('openai-image-tasks：轮询网络抖动继续轮询不判 unknown', async () => {
  const scripted = createScriptedFetch([
    { match: '/v1/images', method: 'POST', status: 200, json: fixture('generate-accepted-pending.json') },
    { match: '/v1/images/img_', method: 'GET', error: { code: 'ECONNRESET' } },
    { match: '/v1/images/img_', method: 'GET', status: 200, json: fixture('generate-accepted-ready.json') },
  ]);
  const instance = build({ fetchImpl: scripted.fetchImpl, logger: consoleCapture() });
  const result = await instance.generate({ promptHint: 'cute 3d', description: 'mother', referenceKeys: [] });
  assert.equal(result.status, 'succeeded');
});

test('openai-image-tasks：轮询到失败态 → failed', async () => {
  const scripted = createScriptedFetch([
    { match: '/v1/images', method: 'POST', status: 200, json: fixture('generate-accepted-pending.json') },
    { match: '/v1/images/img_', method: 'GET', status: 200,
      json: { id: 'img_x', status: 'failed', error: { message: 'moderation' } } },
  ]);
  const instance = build({ fetchImpl: scripted.fetchImpl, logger: consoleCapture() });
  const result = await instance.generate({ promptHint: 'cute 3d', description: 'mother', referenceKeys: [] });
  assert.equal(result.status, 'failed');
  assert.equal(result.error, '图片生成失败，请修改内容后重试。');
});

test('openai-image-tasks：轮询等待超时 → unknown（任务可能在渠道侧，冻结待对账）', async () => {
  const scripted = createScriptedFetch([
    { match: '/v1/images', method: 'POST', status: 200, json: fixture('generate-accepted-pending.json') },
    { match: '/v1/images/img_', method: 'GET', status: 200, json: fixture('generate-accepted-pending.json') },
    { match: '/v1/images/img_', method: 'GET', status: 200, json: fixture('generate-accepted-pending.json') },
    { match: '/v1/images/img_', method: 'GET', status: 200, json: fixture('generate-accepted-pending.json') },
  ]);
  const instance = driver.create(contractChannel({
    kind: 'image', driver: 'openai-image-tasks', modelMap: { image: 'GPT-image-2' },
    params: { requestTimeoutMs: 300, pollIntervalMs: 1, pollTimeoutMs: 30 },
  }), { logger: consoleCapture(), deps: { fetchImpl: scripted.fetchImpl, downloadImage: async () => ({ buffer: TINY_PNG }) } });
  const result = await instance.generate({ promptHint: 'p', description: 'd', referenceKeys: [] });
  assert.equal(result.status, 'unknown');
});
