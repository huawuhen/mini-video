// openai-videos 驱动测试：共用契约套件 + 特有场景（未知字段拒绝、相对路径补全、prepare 字段白名单）。
import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import driver from './index.js';
import { runVideoDriverContract, contractChannel, createScriptedFetch, consoleCapture } from '../../contract-test.js';
import { ProviderError } from '../../contract.js';

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

const channel = contractChannel({
  kind: 'video', driver: 'openai-videos',
  modelMap: { video: 'seedance-2.5-deal' },
  params: { requestTimeoutMs: 300 },
});

const build = ({ fetchImpl, logger }) => driver.create(channel, { logger, deps: { fetchImpl } });

runVideoDriverContract({
  title: 'openai-videos 契约',
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

test('openai-videos：prepare 只保留协议字段（未知字段上游 400）', () => {
  const instance = build({ fetchImpl: createScriptedFetch([]).fetchImpl, logger: consoleCapture() });
  const prepared = instance.prepare({
    prompt: 'wave', imageRefs: ['https://cdn.example.test/a.png', 'not-a-url'],
    audioRefs: [], durationSeconds: 5, ratio: '9:16', resolution: '480p',
  });
  assert.deepEqual(Object.keys(prepared).sort(),
    ['image_urls', 'model', 'prompt', 'ratio', 'resolution', 'seconds']);
  assert.deepEqual(prepared.image_urls, ['https://cdn.example.test/a.png']);
});

test('openai-videos：完成态站内相对路径补全为绝对地址', async () => {
  const scripted = createScriptedFetch([{ match: '', method: 'GET', status: 200,
    json: { id: 'vid_1', status: 'completed', video_url: '/files/rel-out.mp4' } }]);
  const instance = build({ fetchImpl: scripted.fetchImpl, logger: consoleCapture() });
  const result = await instance.query('vid_1');
  assert.equal(result.status, 'succeeded');
  assert.equal(result.outputs[0].url, 'https://channel.example.test/files/rel-out.mp4');
});

test('openai-videos：完成态无地址 → unknown（冻结待对账）', async () => {
  const scripted = createScriptedFetch([{ match: '', method: 'GET', status: 200, json: { id: 'vid_2', status: 'completed' } }]);
  const instance = build({ fetchImpl: scripted.fetchImpl, logger: consoleCapture() });
  assert.equal((await instance.query('vid_2')).status, 'unknown');
});

test('openai-videos：任务 404 → failed', async () => {
  const scripted = createScriptedFetch([{ match: '', method: 'GET', status: 404, json: { error: 'not found' } }]);
  const instance = build({ fetchImpl: scripted.fetchImpl, logger: consoleCapture() });
  const result = await instance.query('gone');
  assert.equal(result.status, 'failed');
  assert.equal(result.error, '视频任务不存在或已过期。');
});

test('openai-videos：prepare 校验', () => {
  const instance = build({ fetchImpl: createScriptedFetch([]).fetchImpl, logger: consoleCapture() });
  assert.throws(() => instance.prepare({ prompt: '', durationSeconds: 5, ratio: '9:16', resolution: '480p' }), ProviderError);
  assert.throws(() => instance.prepare({ prompt: 'p', durationSeconds: 7, ratio: '9:16', resolution: '480p' }, { durations: [5] }), ProviderError);
  assert.throws(() => instance.prepare({ prompt: 'p', durationSeconds: 5, ratio: '', resolution: '480p' }), ProviderError);
});
