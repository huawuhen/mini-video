// M2-WEB-01 复审必改 1 回归测试：生产装配路径的两个真 bug 不再回归。
// ① worker ctx.enqueue 单参收口——此前透传两参 queue 函数，真实 worker 下处理器入队必炸
//   （测试/e2e 都自造 ctx 从未暴露）；用真实 createWorker 驱动一个调用 ctx.enqueue 的处理器。
// ② app 主入口 urlFor——曾漏传导致详情/列表媒体签名链接全缺失；抽成 buildUrlFor 并在
//   真实 createApp HTTP 栈上断言交付作品详情返回 videoUrl。
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createApp, buildUrlFor } from '../src/app.js';
import { createWorker, } from '../src/worker.js';
import { enqueue } from '../src/queue/index.js';
import { createMemoryStorage } from '../src/engine/storage/memory.js';
import { createLogger } from '../src/logger.js';
import { loadConfig } from '../src/config.js';
import { createTestDb } from './helpers/db.js';

const silent = createLogger({ level: 'silent' });

describe('生产装配回归（M2-WEB-01 复审必改 1）', () => {
  // ctx.enqueue：用真实 createWorker.runOne 驱动调用 ctx.enqueue(spec) 的处理器，
  // 断言任务落队——签名错配（透传两参 queue 函数）时该处理器抛
  // "Cannot destructure property 'type' of 'undefined"，任务永远不会出现。
  let ctx;
  before(async () => { ctx = await createTestDb(); });
  after(async () => { await ctx.drop(); });

  test('处理器内 ctx.enqueue({type,payload,dedupeKey}) → 队列出现该任务', async () => {
    await enqueue(ctx.db, { type: 'test.chain', payload: { n: 1 }, dedupeKey: 'wiring-chain-2' });
    const seen = [];
    const worker = createWorker({
      db: ctx.db, logger: silent, workerId: 'wiring-test-2', concurrency: 1,
      handlers: {
        'test.chain': async (_payload, jobCtx) => {
          await jobCtx.enqueue({ type: 'test.follow', payload: { ok: 1 }, dedupeKey: 'wiring-follow-2' });
          seen.push('ran');
        },
      },
    });
    await worker.runOne();
    assert.equal(seen.length, 1, '处理器已执行');
    const { rows } = await ctx.db.query(`SELECT id, status, payload FROM jobs WHERE type = 'test.follow'`);
    assert.equal(rows.length, 1, 'ctx.enqueue 单参调用必须把任务写进队列');
    assert.equal(typeof rows[0].payload, 'object');
  });
});

describe('buildUrlFor（媒体签名链接装配）', () => {
  let ctx;
  before(async () => { ctx = await createTestDb(); });
  after(async () => { await ctx.drop(); });

  test('处理器内 ctx.enqueue({type,payload,dedupeKey}) → 队列出现该任务', async () => {
    await enqueue(ctx.db, { type: 'test.chain', payload: { n: 1 }, dedupeKey: 'wiring-chain-2' });
    const seen = [];
    const worker = createWorker({
      db: ctx.db, logger: silent, workerId: 'wiring-test-2', concurrency: 1,
      handlers: {
        'test.chain': async (_payload, jobCtx) => {
          await jobCtx.enqueue({ type: 'test.follow', payload: { ok: 1 }, dedupeKey: 'wiring-follow-2' });
          seen.push('ran');
        },
      },
    });
    await worker.runOne();
    assert.equal(seen.length, 1, '处理器已执行');
    const { rows } = await ctx.db.query(`SELECT id, status, payload FROM jobs WHERE type = 'test.follow'`);
    assert.equal(rows.length, 1, 'ctx.enqueue 单参调用必须把任务写进队列');
    assert.deepEqual(typeof rows[0].payload, 'object');
  });
});

describe('buildUrlFor（媒体签名链接装配）', () => {
  test('同步签名正常透传；async 签名/异常/缺省安全返回 undefined（契约要求同步，仅 qiniu 满足）', () => {
    const syncStorage = { signedUrl: (key, opts) => `https://media.example/${key}?ttl=${opts?.ttlSeconds}` };
    assert.equal(buildUrlFor(syncStorage, 3600)('a.mp4'), 'https://media.example/a.mp4?ttl=3600');
    assert.equal(buildUrlFor(createMemoryStorage(), 3600)('a.mp4'), undefined, 'memory 的 async signedUrl 不可用');
    const throwing = { signedUrl: () => { throw new Error('boom'); } };
    assert.equal(buildUrlFor(throwing, 3600)('k'), undefined);
    assert.equal(buildUrlFor({}, 3600)('k'), undefined);
    assert.equal(buildUrlFor(undefined, 3600)('k'), undefined);
  });

  test('真实 createApp：交付作品详情返回 render.videoUrl（urlFor 装配不再缺失）', async () => {
    const ctx2 = await createTestDb();
    const config = loadConfig({ NODE_ENV: 'test' });
    const sms = { id: 'test-capture', lastCode: null, async send({ code }) { this.lastCode = code; } };
    const storage = { put: async () => {}, remove: async () => {},
      signedUrl: (key) => `https://media.example/${key}` }; // 同步签名（qiniu 语义）
    const app = createApp({ config, db: ctx2.db, logger: silent, storage,
      urlFor: buildUrlFor(storage, config.storage.signedUrlTtlSeconds), smsProvider: sms });
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}/api/v1`;
    try {
      await fetch(`${base}/auth/sms`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: '15800000099' }) });
      const login = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: '15800000099', code: sms.lastCode, agreeTerms: true }) });
      const { user } = await login.json();
      const cookie = (login.headers.getSetCookie().find((c) => c.startsWith('miv_sid=')) ?? '').split(';')[0];

      // 直接落一个已交付作品（流程正确性由 project-api 套件覆盖，这里只验装配）
      const projectId = 'prj_wiring000001';
      await ctx2.db.query(
        `INSERT INTO projects (id, user_id, story_text, source_type, style_id, quality_tier_id, tier_mapping_id,
           status, title, ratio, story, progress)
         VALUES ($1, $2, '测试', 'text', 'anime', 'standard', 'tm_standard00000001',
           'delivered', '装配测试', '9:16', '{}'::jsonb, '{"percent":100,"message":"已完成"}'::jsonb)`,
        [projectId, user.id]);
      const segId = 'seg_wiring000001';
      await ctx2.db.query(
        `INSERT INTO segments (id, project_id, idx, duration_seconds, plot)
         VALUES ($1, $2, 0, 30, '剧情')`, [segId, projectId]);
      const takeId = 'take_wiring0001';
      await ctx2.db.query(
        `INSERT INTO segment_takes (id, segment_id, status, video_key, last_frame_key)
         VALUES ($1, $2, 'succeeded', 'users/u/wiring/take.mp4', 'users/u/wiring/f.jpg')`, [takeId, segId]);
      await ctx2.db.query(`UPDATE segments SET selected_take_id = $1 WHERE id = $2`, [takeId, segId]);
      await ctx2.db.query(
        `INSERT INTO renders (id, project_id, status, video_key, duration_seconds, takes_snapshot)
         VALUES ('rnd_wiring000001', $1, 'succeeded', 'users/u/wiring/render.mp4', 30, '[]'::jsonb)`, [projectId]);

      const detail = await (await fetch(`${base}/projects/${projectId}`, { headers: { Cookie: cookie } })).json();
      assert.equal(detail.render?.status, 'succeeded');
      assert.ok(detail.render?.videoUrl, `详情必须带 render.videoUrl（urlFor 装配缺失会返回 undefined）：${JSON.stringify(detail.render)}`);
      assert.ok(String(detail.render.videoUrl).includes('users/u/wiring/render.mp4'));
      // 片段候选的视频链接同样来自 urlFor
      assert.ok(detail.segments[0].takes[0].videoUrl, 'take 视频链接同样装配');
    } finally {
      await new Promise((resolve) => server.close(resolve));
      await ctx2.drop();
    }
  });
});
