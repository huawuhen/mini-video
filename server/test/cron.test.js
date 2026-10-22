import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { loadConfig } from '../src/config.js';
import { silentLogger } from '../src/logger.js';
import { createScheduler, runAuthSweep, runJobsCleanup, runProjectsExpireSweep, runProjectsFailedSweep,
  runUploadsSweep, windowStart } from '../src/queue/cron.js';
import { createPriceAuditHandler, expectedCostFen } from '../src/queue/price-audit.js';
import { enqueue } from '../src/queue/index.js';
import { buildHandlers, createWorker } from '../src/worker.js';
import { createTestDb } from './helpers/db.js';

function recordingStorage() {
  const removed = [];
  return { removed, async remove(keys) { removed.push(...keys); } };
}

const insertUser = (db, id) => db.query(`INSERT INTO users (id, phone, nickname) VALUES ($1, $2, '定时任务测试')`, [id, '159' + id.slice(-8)]);

// —— projects.expire_sweep 的 fixture 助手（多个用例共用）——
const insertProject = (db, id, status, expiresAt) => db.query(
  `INSERT INTO projects (id, user_id, story_text, source_type, style_id, quality_tier_id, tier_mapping_id, status, delivered_at, expires_at)
   VALUES ($1, 'usr_cron00000001', '测试故事', 'text', 'realistic', 'standard', 'tm_standard00000001', $2,
           CASE WHEN $2 = 'delivered' THEN now() END, $3)`,
  [id, status, expiresAt],
);
const insertRender = (db, id, projectId, videoKey, coverKey) => db.query(
  `INSERT INTO renders (id, project_id, takes_snapshot, status, video_key, cover_key) VALUES ($1, $2, '[]', 'succeeded', $3, $4)`,
  [id, projectId, videoKey, coverKey],
);
const insertSegment = (db, id, projectId, idx) => db.query(
  `INSERT INTO segments (id, project_id, idx, duration_seconds, plot) VALUES ($1, $2, $3, 10, '剧情')`,
  [id, projectId, idx],
);
const insertTake = (db, id, projectId, videoKey) => db.query(
  `INSERT INTO segment_takes (id, segment_id, status, video_key, poster_key, last_frame_key)
   VALUES ($1, (SELECT id FROM segments WHERE project_id = $2 LIMIT 1), 'succeeded', $3, $4, $5)`,
  [id, projectId, videoKey, `posters/${id}.jpg`, `frames/${id}.jpg`],
);

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
      ['projects.failed_sweep', 1],   // M2-BE-01
      ['providers.price_audit', 1],   // M2-BE-01
      ['uploads.sweep', 1],
    ]);
    // 同窗口内再次调度（含另一个调度器）不再新增
    await s2.tick();
    const again = await ctx.db.query(`SELECT count(*)::int AS n FROM jobs WHERE dedupe_key LIKE 'cron:%'`);
    assert.equal(again.rows[0].n, 6);
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

  test('uploads.sweep 防御（§6 审查 1）：仍被 character_photos 引用的行跳过不删、不报外键错误', async () => {
    const db = ctx.db;
    await db.query(
      `INSERT INTO uploads (id, user_id, kind, storage_key, mime, size_bytes, created_at)
       VALUES ('upl_skip', 'usr_cron00000001', 'image', 'uploads/skip.jpg', 'image/jpeg', 1, now() - interval '2 days')`,
    );
    await db.query(`INSERT INTO characters (id, user_id, name) VALUES ('chr_skip', 'usr_cron00000001', 'C')`);
    await db.query(`INSERT INTO character_photos (id, character_id, upload_id) VALUES ('cph_skip', 'chr_skip', 'upl_skip')`);

    const result = await runUploadsSweep(db, { storage, batchSize: 10 }); // 不得抛 23503
    assert.equal(result.uploads, 0);
    assert.equal((await db.query(`SELECT count(*)::int AS n FROM uploads WHERE id = 'upl_skip'`)).rows[0].n, 1, '异常数据跳过不删');
    assert.ok(!storage.removed.includes('uploads/skip.jpg'), '对象不被删除');
  });

  test('projects.expire_sweep：到期作品改 expired、写事件、删视频对象、清 video_key，封面与记录保留（要点 e/g）', async () => {
    const db = ctx.db;
    const local = recordingStorage(); // 独立记录器，避免被前面用例的删除记录干扰

    // p1：已到期 → 处理；p2：未到期 → 不动；p3：已 expired 但视频 key 未清（模拟上次中断）→ 补偿清理
    await insertProject(db, 'prj_c1', 'delivered', new Date(Date.now() - 86_400_000));
    await insertSegment(db, 'seg_c1', 'prj_c1', 0);
    await insertRender(db, 'rnd_c1', 'prj_c1', 'videos/rnd_c1.mp4', 'covers/rnd_c1.jpg');
    await insertTake(db, 'take_c1', 'prj_c1', 'videos/take_c1.mp4');
    await insertProject(db, 'prj_c2', 'delivered', new Date(Date.now() + 86_400_000));
    await insertRender(db, 'rnd_c2', 'prj_c2', 'videos/rnd_c2.mp4', 'covers/rnd_c2.jpg');
    await insertProject(db, 'prj_c3', 'expired', null);
    await insertRender(db, 'rnd_c3', 'prj_c3', 'videos/rnd_c3.mp4', 'covers/rnd_c3.jpg');

    const result = await runProjectsExpireSweep(db, { storage: local, logger: silentLogger, batchSize: 2 });
    assert.deepEqual(result, { expired: 1, clearedKeys: 3 }); // p1 的成片 + 片段 2 个 key，p3 补偿 1 个

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
    const second = await runProjectsExpireSweep(db, { storage: local, logger: silentLogger, batchSize: 2 });
    assert.deepEqual(second, { expired: 0, clearedKeys: 0 });
  });

  test('expire_sweep 漏删修复（§6 审查 2）：无成片记录也删片段视频；多成片版本全清不重复', async () => {
    const db = ctx.db;
    const local = recordingStorage();
    // prj_c4：只有片段视频，没有 renders 行（旧实现以 renders 为起点会漏删它）
    await insertProject(db, 'prj_c4', 'delivered', new Date(Date.now() - 86_400_000));
    await insertSegment(db, 'seg_c4', 'prj_c4', 0);
    await db.query(`INSERT INTO segment_takes (id, segment_id, status, video_key) VALUES ('take_c4', 'seg_c4', 'succeeded', 'videos/take_c4.mp4')`);
    // prj_c5：多成片版本（重新拼接场景），旧实现笛卡尔积会重复删除
    await insertProject(db, 'prj_c5', 'delivered', new Date(Date.now() - 86_400_000));
    await insertRender(db, 'rnd_c5a', 'prj_c5', 'videos/rnd_c5a.mp4', 'covers/rnd_c5a.jpg');
    await insertRender(db, 'rnd_c5b', 'prj_c5', 'videos/rnd_c5b.mp4', 'covers/rnd_c5b.jpg');

    const result = await runProjectsExpireSweep(db, { storage: local, logger: silentLogger, batchSize: 2 });
    assert.deepEqual(result, { expired: 2, clearedKeys: 3 });

    assert.equal((await db.query(`SELECT video_key FROM segment_takes WHERE id = 'take_c4'`)).rows[0].video_key, null, '无成片记录的片段视频 key 也被清空');
    assert.equal((await db.query(`SELECT count(*)::int AS n FROM renders WHERE project_id = 'prj_c5' AND video_key IS NOT NULL`)).rows[0].n, 0);
    assert.deepEqual(local.removed.sort(), ['videos/rnd_c5a.mp4', 'videos/rnd_c5b.mp4', 'videos/take_c4.mp4'], '每个对象只删一次');
    assert.equal((await db.query(`SELECT count(*)::int AS n FROM renders WHERE project_id = 'prj_c5' AND cover_key IS NOT NULL`)).rows[0].n, 2, '封面保留');
  });

  test('uploads.sweep 认领式删除（§6 审查 1）：清理期间被引用的上传不会被误删', async () => {
    const db = ctx.db;
    const removed = [];
    const raceStorage = {
      async remove(keys) {
        // 模拟：删第一批对象期间，数字人创建引用了尚未清理的 upl_r3（BE-04 的条件引用 UPDATE）
        if (keys.includes('uploads/upl_r1.jpg')) {
          await db.query(`UPDATE uploads SET referenced_at = now() WHERE id = 'upl_r3'`);
        }
        removed.push(...keys);
      },
    };
    for (const id of ['upl_r1', 'upl_r2', 'upl_r3']) {
      await db.query(
        `INSERT INTO uploads (id, user_id, kind, storage_key, mime, size_bytes, created_at)
         VALUES ($1, 'usr_cron00000001', 'image', $2, 'image/jpeg', 100, now() - interval '2 days')`,
        [id, `uploads/${id}.jpg`],
      );
    }
    const result = await runUploadsSweep(db, { storage: raceStorage, logger: silentLogger, batchSize: 1 });
    assert.equal(result.uploads, 2, '被引用的 upl_r3 认领不到、不再删除');
    assert.deepEqual(removed.sort(), ['uploads/upl_r1.jpg', 'uploads/upl_r2.jpg'], '被引用照片的对象不会被删除');
    const r3 = (await db.query(`SELECT referenced_at FROM uploads WHERE id = 'upl_r3'`)).rows[0];
    assert.ok(r3.referenced_at, 'upl_r3 行保留且已标记引用，数字人照片不受影响');
  });

  test('生产配置未注入存储时 buildHandlers 启动报错（§6 审查 3）', () => {
    const prodConfig = loadConfig({ NODE_ENV: 'production', DATABASE_URL: 'postgres://x/y', ALLOWED_ORIGINS: 'https://miv.example', SMS_PROVIDER: 'real' });
    // M1-ENG-03 后：未注入 → 按 config.storage.driver 解析，生产默认 qiniu 但密钥缺失 → 配置错误
    assert.throws(() => buildHandlers({ config: prodConfig, db: ctx.db, logger: silentLogger }), /存储配置不完整|对象存储/);
    // 非生产环境缺省内存实现可用；M1-BE-05 起注册 project.understand（开发用确定性 story 桩）
    const dev = buildHandlers({ config, db: ctx.db, logger: silentLogger });
    assert.deepEqual(Object.keys(dev).sort(),
      ['auth.sweep', 'gen.poll', 'jobs.cleanup', 'look.generate', 'project.bind_prompts', 'project.compose', 'project.understand', 'projects.expire_sweep', 'projects.failed_sweep', 'providers.price_audit', 'segment.generate', 'uploads.sweep']);
  });

  test('projects.failed_sweep：failed 超 7 天自动取消并退款（M2-BE-01），未到期不动、重复执行幂等', async () => {
    const db = ctx.db;
    await db.query(
      `INSERT INTO wallets (user_id, available_fen, frozen_fen) VALUES ('usr_cron00000001', 10000, 4800)
        ON CONFLICT (user_id) DO UPDATE SET available_fen = 10000, frozen_fen = 4800`);
    // f1：失败已 8 天 → 自动取消并退回冻结；f2：刚失败 → 不动
    await insertProject(db, 'prj_f1', 'failed', null);
    await db.query(`UPDATE projects SET updated_at = now() - interval '8 days' WHERE id = 'prj_f1'`);
    await insertProject(db, 'prj_f2', 'failed', null);
    const insertReserve = (ledgerId, projectId) => db.query(
      `INSERT INTO ledger (id, user_id, kind, amount_fen, frozen_delta_fen, title, ref_type, ref_id, idempotency_key)
       VALUES ($1, 'usr_cron00000001', 'reserve', -2400, 2400, '视频生成预占', 'project', $2, $3)`,
      [ledgerId, projectId, `test:${ledgerId}`],
    );
    await insertReserve('led_f1', 'prj_f1');
    await insertReserve('led_f2', 'prj_f2');

    const result = await runProjectsFailedSweep(db, { cancelDays: 7, batchSize: 10, logger: silentLogger });
    assert.deepEqual(result, { canceled: 1 });
    assert.equal((await db.query(`SELECT status FROM projects WHERE id = 'prj_f1'`)).rows[0].status, 'canceled');
    assert.ok((await db.query(
      `SELECT 1 FROM project_events WHERE project_id = 'prj_f1' AND status = 'canceled'`)).rowCount,
      '写了 canceled 事件');
    const wallet = (await db.query(
      `SELECT available_fen, frozen_fen FROM wallets WHERE user_id = 'usr_cron00000001'`)).rows[0];
    assert.equal(Number(wallet.available_fen), 12400, '冻结退回可用');
    assert.equal(Number(wallet.frozen_fen), 2400, '未到期作品的冻结保留');
    assert.equal((await db.query(`SELECT status FROM projects WHERE id = 'prj_f2'`)).rows[0].status, 'failed');

    const again = await runProjectsFailedSweep(db, { cancelDays: 7, batchSize: 10, logger: silentLogger });
    assert.deepEqual(again, { canceled: 0 }, '已取消的作品不再重复处理（幂等）');
    // 删除留下的大额钱包状态，避免影响其他用例
    await db.query(`DELETE FROM ledger WHERE id IN ('led_f1', 'led_f2', (
      SELECT id FROM ledger WHERE ref_id = 'prj_f1' AND kind = 'refund' LIMIT 1))`);
    await db.query(`DELETE FROM project_events WHERE project_id IN ('prj_f1', 'prj_f2')`);
    await db.query(`DELETE FROM wallets WHERE user_id = 'usr_cron00000001'`);
    await db.query(`DELETE FROM projects WHERE id IN ('prj_f1', 'prj_f2')`);
  });

  test('providers.price_audit：mock 跳过；real 模式目录一致不报、漂移报警（M2-BE-01）', async () => {
    const events = [];
    const logger = { info: (msg, meta) => events.push(['info', msg, meta]),
      warn: (msg, meta) => events.push(['warn', msg, meta]), error: (msg, meta) => events.push(['error', msg, meta]),
      child: () => logger };
    let fetches = 0;
    const mockConfig = loadConfig({ NODE_ENV: 'test' });
    const mockHandler = createPriceAuditHandler({ db: ctx.db, logger, config: mockConfig,
      fetchCatalog: async () => { fetches += 1; return { data: [] }; } });
    await mockHandler();
    assert.equal(fetches, 0, 'mock 模式不拉目录');
    assert.ok(events.some(([, msg]) => msg === 'price_audit_skip_mock'));

    // 真实 SKU（迁移 004+005：图片 = gpt-image-2 1k/medium 成本 21）与目录一致 → price_audit_ok
    const catalog = { data: [
      { id: 'seedance-2.5', pricing: { kind: 'per_second_range', resolutions: {
        '480p': { min: 39, max: 39 }, '720p': { min: 47, max: 47 } } } },
      { id: 'gpt-image-2', pricing: { kind: 'per_image', prices: { '1k': { medium: 21 } } } },
    ] };
    const realConfig = loadConfig({ NODE_ENV: 'test', GEN_UPSTREAMS: 'real' });
    const realHandler = createPriceAuditHandler({ db: ctx.db, logger, config: realConfig,
      fetchCatalog: async () => { fetches += 1; return catalog; } });
    await realHandler();
    assert.equal(fetches, 1);
    assert.ok(events.some(([, msg]) => msg === 'price_audit_ok'), '成本与目录一致时不报警');

    // 渠道调价：480p 39 → 45
    const drifted = { data: [
      { id: 'seedance-2.5', pricing: { resolutions: { '480p': { min: 45, max: 45 } } } },
      { id: 'gpt-image-2', pricing: { prices: { '1k': { medium: 21 } } } },
    ] };
    await createPriceAuditHandler({ db: ctx.db, logger, config: realConfig,
      fetchCatalog: async () => drifted })();
    const drift = events.find(([, msg]) => msg === 'provider_price_drift');
    assert.ok(drift, '成本漂移记 error 日志');
    assert.ok(JSON.stringify(drift[2]).includes('video.seedance.480p'), '报警指明 SKU');

    // 纯函数：模型缺失 / 分辨率缺失
    assert.equal(expectedCostFen({ kind: 'video', model: 'ghost', resolution: '480p', cost_fen: 39 },
      new Map(), {}).ok, false);
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
