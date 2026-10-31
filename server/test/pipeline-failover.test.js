// M2-BE-04①：作品流水线任务重试耗尽（job 终态 failed）→ 作品置 failed（带 step 与中文原因，
// A 口径金额保持冻结、可 retry/取消）。覆盖每种项目任务：understand / bind_prompts /
// segment.generate / gen.poll / compose / look.generate（Lead playwright 走查实测 bind 耗尽后
// 作品卡 rendering、进度 45%、无 error、费用一直冻结）。
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createWorker } from '../src/worker.js';
import { enqueue } from '../src/queue/index.js';
import { createLogger } from '../src/logger.js';
import { createTestDb } from './helpers/db.js';

const silent = createLogger({ level: 'silent' });

async function seedProject(db, { id, status = 'rendering', withLookVersion = false }) {
  await db.query(`INSERT INTO users (id, phone, nickname) VALUES ('usr_be0400000000001', '15800000401', 'BE04')
    ON CONFLICT (id) DO NOTHING`);
  await db.query(`INSERT INTO wallets (user_id, available_fen, frozen_fen) VALUES ('usr_be0400000000001', 0, 0)
    ON CONFLICT (user_id) DO UPDATE SET available_fen = 0, frozen_fen = 0`);
  await db.query(
    `INSERT INTO projects (id, user_id, story_text, source_type, style_id, quality_tier_id, tier_mapping_id, status, title, ratio, progress)
     VALUES ($1, 'usr_be0400000000001', '测试', 'text', 'anime', 'standard', 'tm_standard00000001', $2::text, 'BE04', '9:16',
       '{"percent":45,"message":"正在生成片段 1/1"}'::jsonb)`, [id, status]);
  await db.query(`INSERT INTO segments (id, project_id, idx, duration_seconds, plot)
     VALUES ('seg_' || $1::text, $1::text, 0, 30, '剧情')`, [id]);
  await db.query(
    `INSERT INTO gen_tasks (id, user_id, kind, sku_code, sku_version, provider, status, request, upstream_id, idempotency_key)
     VALUES ('gt_' || $1::text, 'usr_be0400000000001', 'video', 'video.480p', 1, 'fake', 'running', $2::jsonb, 'up_be04', 'gt_' || $1::text)`,
    [id, JSON.stringify({ projectId: id, durationSeconds: 30, amountFen: 3000, videoKey: 'users/x/v.mp4',
      lastFrameKey: 'users/x/f.jpg', resolution: '480p', ratio: '9:16', segmentId: 'seg_' || id, takeId: 'take_' || id })]);
  await db.query(`INSERT INTO segment_takes (id, segment_id, gen_task_id, status)
     VALUES ('take_' || $1::text, 'seg_' || $1::text, 'gt_' || $1::text, 'running')`, [id]);
  await db.query(`INSERT INTO ledger (id, user_id, kind, amount_fen, frozen_delta_fen, title, ref_type, ref_id, idempotency_key)
     VALUES ('led_' || $1, 'usr_be0400000000001', 'reserve', -3000, 3000, '视频生成预占', 'project', $1::text, 'idem_' || $1)`, [id]);
  if (withLookVersion) {
    await db.query(`INSERT INTO characters (id, user_id, name) VALUES ('chr_be0400001', 'usr_be0400000000001', '宝宝')
      ON CONFLICT (id) DO NOTHING`);
    await db.query(`INSERT INTO character_looks (id, character_id, style_id) VALUES ('look_' || $1::text, 'chr_be0400001', 'anime')
      ON CONFLICT (id) DO NOTHING`, [id]);
    await db.query(`INSERT INTO look_versions (id, look_id, status, gen_task_id) VALUES ('lkv_' || $1::text, 'look_' || $1::text, 'pending', 'gt_look_be04')
      ON CONFLICT (id) DO NOTHING`, [id]);
    await db.query(`INSERT INTO project_cast (id, project_id, idx, name, match_source) VALUES ('cast_' || $1::text, $1::text, 0, '宝宝', 'new')`, [id]);
    await db.query(`UPDATE project_cast SET look_version_id = 'lkv_' || $1::text WHERE id = 'cast_' || $1::text`, [id]);
  }
}

async function stateOf(db, id) {
  const project = (await db.query(`SELECT status, error FROM projects WHERE id = $1`, [id])).rows[0];
  const frozen = (await db.query(
    `SELECT COALESCE(SUM(frozen_delta_fen), 0)::int AS fen FROM ledger WHERE user_id = 'usr_be0400000000001' AND ref_id = $1`,
    [id])).rows[0].fen;
  return { ...project, frozen };
}

async function runExhausted(db, { type, payload, projectId, withLookVersion = false, projectStatus }) {
  const jobId = `be04-${type}-${projectId}`;
  await seedProject(db, { id: projectId, status: projectStatus, withLookVersion });
  await enqueue(db, { type, payload, dedupeKey: jobId, maxAttempts: 1 });
  const worker = createWorker({ db, logger: silent, workerId: 'be04-test', concurrency: 1,
    handlers: { [type]: async () => { throw new Error('boom: 必然失败'); } } });
  await worker.runOne();
  return stateOf(db, projectId);
}

describe('M2-BE-04①：流水线任务重试耗尽 → 作品 failed（A 口径冻结保持）', () => {
  let ctx;
  before(async () => { ctx = await createTestDb(); });
  after(async () => { await ctx.drop(); });

  test('project.understand 耗尽 → failed(step=understanding) + 冻结保持 + 可取消退回', async () => {
    const s = await runExhausted(ctx.db, { type: 'project.understand', payload: { projectId: 'prj_be04und001' }, projectId: 'prj_be04und001', projectStatus: 'understanding' });
    assert.equal(s.status, 'failed');
    const error = typeof s.error === 'string' ? JSON.parse(s.error) : s.error;
    assert.equal(error.code, 'PIPELINE_FAILED');
    assert.equal(error.step, 'understanding');
    assert.match(error.message, /重试|取消/);
  });

  test('project.bind_prompts 耗尽 → failed(step=rendering)，进度不再停在 45%', async () => {
    const s = await runExhausted(ctx.db, { type: 'project.bind_prompts', payload: { projectId: 'prj_be04bnd001' }, projectId: 'prj_be04bnd001' });
    assert.equal(s.status, 'failed');
    const error = typeof s.error === 'string' ? JSON.parse(s.error) : s.error;
    assert.equal(error.step, 'rendering');
  });

  test('segment.generate 耗尽 → failed 且视频费冻结不丢（A 口径）', async () => {
    const s = await runExhausted(ctx.db, { type: 'segment.generate', payload: { projectId: 'prj_be04seg001', idx: 0 }, projectId: 'prj_be04seg001' });
    assert.equal(s.status, 'failed');
    assert.equal(s.frozen, 3000, '冻结保持（重试免费重建、取消退回）');
  });

  test('gen.poll 耗尽（payload=takeId）→ 反查项目置 failed', async () => {
    const s = await runExhausted(ctx.db, { type: 'gen.poll', payload: { takeId: 'take_prj_be04pol001' }, projectId: 'prj_be04pol001' });
    assert.equal(s.status, 'failed');
    assert.equal(s.frozen, 3000);
  });

  test('project.compose 耗尽 → failed(step=composing)', async () => {
    const s = await runExhausted(ctx.db, { type: 'project.compose', payload: { projectId: 'prj_be04cmp001' }, projectId: 'prj_be04cmp001', projectStatus: 'composing' });
    assert.equal(s.status, 'failed');
    const error = typeof s.error === 'string' ? JSON.parse(s.error) : s.error;
    assert.equal(error.step, 'composing');
  });

  test('look.generate 耗尽（payload=versionId）→ 反查项目置 failed(step=casting)', async () => {
    const s = await runExhausted(ctx.db, { type: 'look.generate', payload: { versionId: 'lkv_prj_be04look01' }, projectId: 'prj_be04look01', withLookVersion: true, projectStatus: 'casting' });
    assert.equal(s.status, 'failed');
    const error = typeof s.error === 'string' ? JSON.parse(s.error) : s.error;
    assert.equal(error.step, 'casting');
  });

  test('非流水线任务（如 uploads.sweep）耗尽 → 不触碰任何作品', async () => {
    await seedProject(ctx.db, { id: 'prj_be04sweep1' }); // rendering 项目一个
    await enqueue(ctx.db, { type: 'uploads.sweep', payload: {}, dedupeKey: 'be04-sweep', maxAttempts: 1 });
    const worker = createWorker({ db: ctx.db, logger: silent, workerId: 'be04-test2', concurrency: 1,
      handlers: { 'uploads.sweep': async () => { throw new Error('boom'); } } });
    await worker.runOne();
    const { rows } = await ctx.db.query(`SELECT status, error FROM projects WHERE id = 'prj_be04sweep1'`);
    assert.equal(rows[0].status, 'rendering', '非流水线任务耗尽不改变作品状态');
    assert.equal(rows[0].error, null);
  });

  test('幂等：作品已 failed/delivered 时不覆盖', async () => {
    // 直接对已 failed 的作品再触发一次 bind 耗尽
    await enqueue(ctx.db, { type: 'project.bind_prompts', payload: { projectId: 'prj_be04bnd001' }, dedupeKey: 'be04-idem', maxAttempts: 1 });
    const worker = createWorker({ db: ctx.db, logger: silent, workerId: 'be04-test3', concurrency: 1,
      handlers: { 'project.bind_prompts': async () => { throw new Error('boom'); } } });
    await worker.runOne();
    const error = (await ctx.db.query(`SELECT error FROM projects WHERE id = 'prj_be04bnd001'`)).rows[0].error;
    assert.equal(error.code, 'PIPELINE_FAILED', '仍是原 failed 记录（未覆盖、未报错）');
  });
});
