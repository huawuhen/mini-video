import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { loadConfig } from '../src/config.js';
import { silentLogger } from '../src/logger.js';
import { createScheduler, runAuthSweep, runJobsCleanup, runProjectsExpireSweep, runUploadsSweep, windowStart } from '../src/queue/cron.js';
import { enqueue } from '../src/queue/index.js';
import { buildHandlers, createWorker } from '../src/worker.js';
import { createTestDb } from './helpers/db.js';

function recordingStorage() {
  const removed = [];
  return { removed, async remove(keys) { removed.push(...keys); } };
}

const insertUser = (db, id) => db.query(`INSERT INTO users (id, phone, nickname) VALUES ($1, $2, '定时任务测试')`, [id, '159' + id.slice(-8)]);

describe('cron（M1-BE-03）', () => {
  let ctx;
  let config;
  let storage;
  before(async () => {
    ctx = await createTestDb();
    config = loadConfig({ NODE_ENV: 'test' });
    storage = recordingStorage();
    await insertUser(ctx.db, 'usr_cron00000001');
  });
  after(async () => ctx.drop());

  test('调度：两个调度器并发 tick 只入队一次；窗口起点对齐（要点 a/g）', async () => {
    assert.equal(windowStart(3600, Date.UTC(2026, 0, 1, 3, 24, 15)).toISOString(), '2026-01-01T03:00:00.000Z');
    assert.equal(windowStart(300, Date.UTC(2026, 0, 1, 3, 24, 15)).toISOString(), '2026-01-01T03:20:00.000Z');

    const s1 = createScheduler({ config, db: ctx.db, logger: silentLogger });
    const s2 = createScheduler({ config, db: ctx.db, logger: silentLogger });
    await Promise.all([s1.tick(), s2.tick()]);
    const { rows } = await ctx.db.query(
      `SELECT type, count(*)::int AS n FROM jobs WHERE dedupe_key LIKE 'cron:%' GROUP BY type ORDER BY type`,
    );
    assert.deepEqual(rows.map((r) => [r.type, r.n]), [
      ['auth.sweep', 1],
      ['jobs.cleanup', 1],
      ['projects.expire_sweep', 1],
      ['uploads.sweep', 1],
    ]);
    // 同窗口内再次调度（含另一个调度器）不再新增
    await s2.tick();
    const again = await ctx.db.query(`SELECT count(*)::int AS n FROM jobs WHERE dedupe_key LIKE 'cron:%'`);
    assert.equal(again.rows[0].n, 4);
  });

  test('auth.sweep：清理过期限流窗口、作废/过期超 1 天的验证码、过期会话；可重复执行（要点 c）', async () => {
    const db = ctx.db;
    await db.query(
      `INSERT INTO rate_counters (key, window_start, count) VALUES
         ('sms:daily:13800000001', now() - interval '3 days', 5),
         ('sms:daily:13800000002', now() - interval '1 hour', 1)`,
    );
    await db.query(
      `INSERT INTO sms_codes (phone, code_hash, expires_at, consumed_at, created_at) VALUES
         ('13800000001', 'h1', now() - interval '5 minutes', now() - interval '2 days', now() - interval '2 days'),
         ('13800000002', 'h2', now() - interval '2 days', NULL, now() - interval '2 days'),
         ('13800000003', 'h3', now() + interval '5 minutes', now() - interval '1 hour', now() - interval '1 hour'),
         ('13800000004', 'h4', now() + interval '10 minutes', NULL, now())`,
    );
    await db.query(
      `INSERT INTO sessions (token_hash, user_id, csrf_token, expires_at) VALUES
         ('old', 'usr_cron00000001', 'c1', now() - interval '1 hour'),
         ('live', 'usr_cron00000001', 'c2', now() + interval '10 days')`,
    );

    const first = await runAuthSweep(db, { batchSize: 2 });
    assert.deepEqual(first, { rateCounters: 1, smsCodes: 2, sessions: 1 });
    assert.equal((await db.query(`SELECT count(*)::int AS n FROM rate_counters WHERE key = 'sms:daily:13800000001'`)).rows[0].n, 0);
    assert.equal((await db.query(`SELECT count(*)::int AS n FROM sms_codes WHERE phone = '13800000001'`)).rows[0].n, 0);
    assert.equal((await db.query(`SELECT count(*)::int AS n FROM sms_codes WHERE phone = '13800000003'`)).rows[0].n, 1, '1 小时前作废的保留');
    assert.equal((await db.query(`SELECT count(*)::int AS n FROM sms_codes WHERE phone = '13800000004'`)).rows[0].n, 1, '未过期保留');
    assert.equal((await db.query(`SELECT count(*)::int AS n FROM sessions WHERE token_hash = 'old'`)).rows[0].n, 0);
    assert.equal((await db.query(`SELECT count(*)::int AS n FROM sessions WHERE token_hash = 'live'`)).rows[0].n, 1);

    // 可重复执行：第二次全部为 0（要点 b/g）
    const second = await runAuthSweep(db, { batchSize: 2 });
    assert.deepEqual(second, { rateCounters: 0, smsCodes: 0, sessions: 0 });
  });

  test('uploads.sweep：先删对象再删行、分批边界、已引用与新鲜上传保留（要点 d/b/g）', async () => {
    const db = ctx.db;
    const old = (id, referenced) => db.query(
      `INSERT INTO uploads (id, user_id, kind, storage_key, mime, size_bytes, referenced_at, created_at)
       VALUES ($1, 'usr_cron00000001', 'image', $2, 'image/jpeg', 100, $3, now() - interval '2 days')`,
      [id, `uploads/${id}.jpg`, referenced ? new Date() : null],
    );
    for (const id of ['upl_1', 'upl_2', 'upl_3', 'upl_4', 'upl_5']) await old(id, false);
    await old('upl_ref', true);
    await db.query(
      `INSERT INTO uploads (id, user_id, kind, storage_key, mime, size_bytes, created_at)
       VALUES ('upl_new', 'usr_cron00000001', 'image', 'uploads/upl_new.jpg', 'image/jpeg', 100, now())`,
    );

    const first = await runUploadsSweep(db, { storage, batchSize: 2 });
    assert.deepEqual(first, { uploads: 5 });
    assert.equal((await db.query(`SELECT count(*)::int AS n FROM uploads WHERE id LIKE 'upl\\_%' AND id NOT IN ('upl_ref', 'upl_new')`)).rows[0].n, 0);
    assert.equal(storage.removed.length, 5);
    assert.ok(storage.removed.includes('uploads/upl_3.jpg'));
    assert.ok(!storage.removed.includes('uploads/upl_ref.jpg'), '已引用的不删');
    assert.ok(!storage.removed.includes('uploads/upl_new.jpg'), '24 小时内的不删');

    // 可重复执行
    const second = await runUploadsSweep(db, { storage, batchSize: 2 });
    assert.deepEqual(second, { uploads: 0 });
  });

  test('projects.expire_sweep：到期作品改 expired、写事件、删视频对象、清 video_key，封面与记录保留（要点 e/g）', async () => {
    const db = ctx.db;
    const local = recordingStorage(); // 独立记录器，避免被前面用例的删除记录干扰
    const insertProject = (id, status, expiresAt) => db.query(
      `INSERT INTO projects (id, user_id, story_text, source_type, style_id, quality_tier_id, tier_mapping_id, status, delivered_at, expires_at)
       VALUES ($1, 'usr_cron00000001', '测试故事', 'text', 'realistic', 'standard', 'tm_standard00000001', $2,
               CASE WHEN $2 = 'delivered' THEN now() END, $3)`,
      [id, status, expiresAt],
    );
    const insertRender = (id, projectId, videoKey, coverKey) => db.query(
      `INSERT INTO renders (id, project_id, takes_snapshot, status, video_key, cover_key) VALUES ($1, $2, '[]', 'succeeded', $3, $4)`,
      [id, projectId, videoKey, coverKey],
    );
    const insertTake = (id, projectId, videoKey) => db.query(
      `INSERT INTO segment_takes (id, segment_id, status, video_key, poster_key, last_frame_key)
       VALUES ($1, (SELECT id FROM segments WHERE project_id = $2 LIMIT 1), 'succeeded', $3, $4, $5)`,
      [id, projectId, videoKey, `posters/${id}.jpg`, `frames/${id}.jpg`],
    );
    const insertSegment = (id, projectId, idx) => db.query(
      `INSERT INTO segments (id, project_id, idx, duration_seconds, plot) VALUES ($1, $2, $3, 10, '剧情')`,
      [id, projectId, idx],
    );

    // p1：已到期 → 处理；p2：未到期 → 不动；p3：已 expired 但视频 key 未清（模拟上次中断）→ 补偿清理
    await insertProject('prj_c1', 'delivered', new Date(Date.now() - 86_400_000));
    await insertSegment('seg_c1', 'prj_c1', 0);
    await insertRender('rnd_c1', 'prj_c1', 'videos/rnd_c1.mp4', 'covers/rnd_c1.jpg');
    await insertTake('take_c1', 'prj_c1', 'videos/take_c1.mp4');
    await insertProject('prj_c2', 'delivered', new Date(Date.now() + 86_400_000));
    await insertRender('rnd_c2', 'prj_c2', 'videos/rnd_c2.mp4', 'covers/rnd_c2.jpg');
    await insertProject('prj_c3', 'expired', null);
    await insertRender('rnd_c3', 'prj_c3', 'videos/rnd_c3.mp4', 'covers/rnd_c3.jpg');

    const result = await runProjectsExpireSweep(db, { storage: local, batchSize: 2 });
    assert.deepEqual(result, { expired: 1, cleared: 1 });

    const p1 = (await db.query(`SELECT status FROM projects WHERE id = 'prj_c1'`)).rows[0];
    assert.equal(p1.status, 'expired', '作品记录保留、状态已过期');
    const event = (await db.query(`SELECT status FROM project_events WHERE project_id = 'prj_c1' AND status = 'expired'`)).rows[0];
    assert.ok(event, '写了 project_events');
    const p1Keys = (await db.query(
      `SELECT (SELECT video_key FROM renders WHERE id = 'rnd_c1') AS render_key,
              (SELECT video_key FROM segment_takes WHERE id = 'take_c1') AS take_key,
              (SELECT cover_key FROM renders WHERE id = 'rnd_c1') AS cover_key,
              (SELECT poster_key FROM segment_takes WHERE id = 'take_c1') AS poster_key,
              (SELECT last_frame_key FROM segment_takes WHERE id = 'take_c1') AS last_frame_key`,
    )).rows[0];
    assert.equal(p1Keys.render_key, null, '成片 video_key 已清空');
    assert.equal(p1Keys.take_key, null, '片段 video_key 已清空');
    assert.equal(p1Keys.cover_key, 'covers/rnd_c1.jpg', '封面保留');
    assert.equal(p1Keys.poster_key, 'posters/take_c1.jpg', '海报保留');
    assert.equal(p1Keys.last_frame_key, 'frames/take_c1.jpg', '尾帧保留');

    assert.equal((await db.query(`SELECT status FROM projects WHERE id = 'prj_c2'`)).rows[0].status, 'delivered', '未到期不动');
    assert.equal((await db.query(`SELECT video_key FROM renders WHERE id = 'rnd_c2'`)).rows[0].video_key, 'videos/rnd_c2.mp4');
    assert.equal((await db.query(`SELECT video_key FROM renders WHERE id = 'rnd_c3'`)).rows[0].video_key, null, '补偿路径清空遗留 key');

    assert.deepEqual(local.removed.sort(), ['videos/rnd_c1.mp4', 'videos/rnd_c3.mp4', 'videos/take_c1.mp4']);
    assert.ok(!local.removed.includes('covers/rnd_c1.jpg'), '封面对象保留');

    // 可重复执行
    const second = await runProjectsExpireSweep(db, { storage: local, batchSize: 2 });
    assert.deepEqual(second, { expired: 0, cleared: 0 });
  });

  test('jobs.cleanup：只清理超过保留期的 done 行（要点 f/g）', async () => {
    const db = ctx.db;
    const insertJob = (status, ageDays) => db.query(
      `INSERT INTO jobs (type, status, updated_at) VALUES ('test.job', $1, now() - make_interval(days => $2))`,
      [status, ageDays],
    );
    for (let i = 0; i < 3; i += 1) await insertJob('done', 31);
    await db.query(`INSERT INTO jobs (type, status, updated_at) VALUES ('test.job', 'done', now())`);
    await db.query(`INSERT INTO jobs (type, status, updated_at) VALUES ('test.job', 'failed', now() - interval '40 days')`);
    await db.query(`INSERT INTO jobs (type, status, updated_at) VALUES ('test.job', 'queued', now() - interval '40 days')`);

    const first = await runJobsCleanup(db, { batchSize: 2, retentionDays: 30 });
    assert.deepEqual(first, { doneJobs: 3 });
    assert.equal((await db.query(`SELECT count(*)::int AS n FROM jobs WHERE type = 'test.job' AND status = 'done' AND updated_at < now() - interval '30 days'`)).rows[0].n, 0);
    assert.equal((await db.query(`SELECT count(*)::int AS n FROM jobs WHERE type = 'test.job' AND status = 'failed'`)).rows[0].n, 1, 'failed 不删');
    assert.equal((await db.query(`SELECT count(*)::int AS n FROM jobs WHERE type = 'test.job' AND status = 'queued'`)).rows[0].n, 1, 'queued 不删');

    const second = await runJobsCleanup(db, { batchSize: 2, retentionDays: 30 });
    assert.deepEqual(second, { doneJobs: 0 });
  });

  test('端到端：调度入队 → Worker 按 buildHandlers 注册的处理器执行成功（要点 a）', async () => {
    await ctx.db.query(`DELETE FROM jobs`);
    const scheduler = createScheduler({ config, db: ctx.db, logger: silentLogger });
    await scheduler.tick();
    const worker = createWorker({
      db: ctx.db,
      logger: silentLogger,
      handlers: buildHandlers({ config, db: ctx.db, logger: silentLogger, storage }),
      workerId: 'worker-test',
      concurrency: 1,
    });
    const ran = await worker.runOne();
    assert.ok(ran, '领取到一个 cron job');
    const { rows } = await ctx.db.query(`SELECT type, status FROM jobs WHERE dedupe_key LIKE 'cron:%' AND status = 'done'`);
    assert.equal(rows.length, 1);
  });
});
