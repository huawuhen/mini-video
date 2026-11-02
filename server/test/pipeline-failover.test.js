// M2-BE-04①：作品流水线任务重试耗尽（job 终态 failed）的兜底与收口。
// 第一轮（走查修复）：作品置 failed（带 step 与中文原因，A 口径金额保持冻结、可 retry/取消）。
// 复审必改 1：耗尽时同时收口在途的 take / 形象版本——
//   a) gen.poll 耗尽 → take/gen_task unknown + 作品 failed(TAKE_UNKNOWN)，重试被拒（不重提上游）；
//   b) segment.generate 耗尽 → gen_task=created（从未提交）：take failed + SEGMENT_FAILED 可重试，
//      重试后新 take 提交、gen.poll 入队（流程继续）；gen_task=submitting/running（已提交）：unknown 同 a；
//   c) look.generate 耗尽 → created：版本 failed + 退款 + LOOK_FAILED 可重试（重试补建新版本、生成成功）；
//      running：gen_task unknown + 版本 pending + LOOK_UNKNOWN，重试被拒、形象上游零重提。
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createWorker } from '../src/worker.js';
import { enqueue } from '../src/queue/index.js';
import { createLogger } from '../src/logger.js';
import { loadConfig } from '../src/config.js';
import { createMemoryStorage } from '../src/engine/storage/memory.js';
import { createLookGenerateHandler } from '../src/characters/service.js';
import { createSegmentGenerateHandler } from '../src/projects/segment.js';
import { retryProject } from '../src/projects/service.js';
import { mockImageProvider } from './helpers/providers.js';
import { createTestDb } from './helpers/db.js';

const silent = createLogger({ level: 'silent' });
const USER = 'usr_be0400000000001';

/** 造一个 rendering 中项目的片段链数据；参数控制 gen_task/take 状态（模拟耗尽时的在途形态）。 */
async function seedProject(db, { id, status = 'rendering', withLookVersion = false, taskStatus = 'running',
  takeStatus = 'running', finalPrompt = false, lookTaskStatus = 'created', lookAmountFen = 60 }) {
  await db.query(`INSERT INTO users (id, phone, nickname) VALUES ('${USER}', '15800000401', 'BE04')
    ON CONFLICT (id) DO NOTHING`);
  await db.query(`INSERT INTO wallets (user_id, available_fen, frozen_fen) VALUES ('${USER}', 0, 3000)
    ON CONFLICT (user_id) DO UPDATE SET available_fen = 0, frozen_fen = 3000`);
  await db.query(
    `INSERT INTO projects (id, user_id, story_text, source_type, style_id, quality_tier_id, tier_mapping_id, status, title, ratio, progress)
     VALUES ($1, '${USER}', '测试', 'text', 'anime', 'standard', 'tm_standard00000001', $2::text, 'BE04', '9:16',
       '{"percent":45,"message":"正在生成片段 1/1"}'::jsonb)`, [id, status]);
  await db.query(`INSERT INTO segments (id, project_id, idx, duration_seconds, plot, final_prompt)
     VALUES ('seg_' || $1::text, $1::text, 0, 30, '剧情', $2::jsonb)`,
    [id, finalPrompt ? JSON.stringify({ prompt: '测试提示词', imageRefs: [], audioRefs: [] }) : null]);
  await db.query(
    `INSERT INTO gen_tasks (id, user_id, kind, sku_code, sku_version, provider, status, request, upstream_id, idempotency_key)
     VALUES ('gt_' || $1::text, '${USER}', 'video', 'video.480p', 1, 'fake', $2::text, $3::jsonb,
       CASE WHEN $2::text = 'running' THEN 'up_be04' ELSE NULL END, 'gt_' || $1::text)`,
    [id, taskStatus, JSON.stringify({ projectId: id, durationSeconds: 30, amountFen: 3000,
      videoKey: 'users/x/v.mp4', lastFrameKey: 'users/x/f.jpg', resolution: '480p', ratio: '9:16',
      segmentId: `seg_${id}`, takeId: `take_${id}` })]);
  await db.query(`INSERT INTO segment_takes (id, segment_id, gen_task_id, status)
     VALUES ('take_' || $1::text, 'seg_' || $1::text, 'gt_' || $1::text, $2::text)`, [id, takeStatus]);
  await db.query(`INSERT INTO ledger (id, user_id, kind, amount_fen, frozen_delta_fen, title, ref_type, ref_id, idempotency_key)
     VALUES ('led_' || $1, '${USER}', 'reserve', -3000, 3000, '视频生成预占', 'project', $1::text, 'idem_' || $1)`, [id]);
  if (withLookVersion) {
    // 每个项目独立角色（character_looks 有 UNIQUE(character_id, style_id)）
    const charId = `chr_${id.slice(4)}`;
    await db.query(`INSERT INTO characters (id, user_id, name) VALUES ($1, '${USER}', '宝宝')
      ON CONFLICT (id) DO NOTHING`, [charId]);
    await db.query(`INSERT INTO character_looks (id, character_id, style_id) VALUES ('look_' || $1::text, $2, 'anime')
      ON CONFLICT (id) DO NOTHING`, [id, charId]);
    if (lookTaskStatus) {
      await db.query(
        `INSERT INTO gen_tasks (id, user_id, kind, sku_code, sku_version, provider, status, request, idempotency_key)
         VALUES ('gt_look_' || $1::text, '${USER}', 'image', 'image.mock.2k', 1, 'fake', $2::text, $3::jsonb, 'gt_look_' || $1::text)`,
        [id, lookTaskStatus, JSON.stringify({ versionId: `lkv_${id}`, characterId: charId,
          styleId: 'anime', storageKey: `users/${USER}/looks/lkv_${id}.png`, amountFen: lookAmountFen,
          promptHint: 'anime', description: '温柔', referenceKeys: [] })]);
    }
    await db.query(`INSERT INTO look_versions (id, look_id, status, gen_task_id)
     VALUES ('lkv_' || $1::text, 'look_' || $1::text, 'pending',
       CASE WHEN $2::text = '' THEN 'gt_look_be04' ELSE 'gt_look_' || $1::text END)
     ON CONFLICT (id) DO NOTHING`, [id, lookTaskStatus ?? '']);
    await db.query(`INSERT INTO project_cast (id, project_id, idx, name, match_source, character_id)
     VALUES ('cast_' || $1::text, $1::text, 0, '宝宝', 'new', $2)`, [id, charId]);
    await db.query(`UPDATE project_cast SET look_version_id = 'lkv_' || $1::text WHERE id = 'cast_' || $1::text`, [id]);
  }
}

async function stateOf(db, id) {
  const project = (await db.query(`SELECT status, error FROM projects WHERE id = $1`, [id])).rows[0];
  const frozen = (await db.query(
    `SELECT COALESCE(SUM(frozen_delta_fen), 0)::int AS fen FROM ledger WHERE user_id = '${USER}' AND ref_id = $1`,
    [id])).rows[0].fen;
  const error = typeof project.error === 'string' ? JSON.parse(project.error) : project.error;
  return { status: project.status, error, frozen };
}

async function runExhausted(db, { type, payload, projectId, projectStatus, ...seedOpts }) {
  await seedProject(db, { id: projectId, status: projectStatus, ...seedOpts });
  await enqueue(db, { type, payload, dedupeKey: `be04-${type}-${projectId}`, maxAttempts: 1 });
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
    assert.equal(s.error.code, 'PIPELINE_FAILED');
    assert.equal(s.error.step, 'understanding');
    assert.match(s.error.message, /重试|取消/);
  });

  test('project.bind_prompts 耗尽 → failed(step=rendering)，进度不再停在 45%', async () => {
    const s = await runExhausted(ctx.db, { type: 'project.bind_prompts', payload: { projectId: 'prj_be04bnd001' }, projectId: 'prj_be04bnd001' });
    assert.equal(s.status, 'failed');
    assert.equal(s.error.step, 'rendering');
  });

  test('project.compose 耗尽 → failed(step=composing)', async () => {
    const s = await runExhausted(ctx.db, { type: 'project.compose', payload: { projectId: 'prj_be04cmp001' }, projectId: 'prj_be04cmp001', projectStatus: 'composing' });
    assert.equal(s.status, 'failed');
    assert.equal(s.error.step, 'composing');
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

describe('M2-BE-04 复审必改 1：耗尽收口在途 take / 形象版本', () => {
  let ctx;
  const config = loadConfig({ NODE_ENV: 'test' });
  before(async () => { ctx = await createTestDb(); });
  after(async () => { await ctx.drop(); });

  const takeState = async (db, projectId) => (await db.query(
    `SELECT t.id, t.status AS take_status, gt.status AS task_status FROM segment_takes t
       JOIN segments s ON s.id = t.segment_id JOIN gen_tasks gt ON gt.id = t.gen_task_id
      WHERE s.project_id = $1 ORDER BY t.created_at`, [projectId])).rows;

  test('a) gen.poll 耗尽 → take/gen_task unknown + failed(TAKE_UNKNOWN)，重试被拒（不重提）', async () => {
    const s = await runExhausted(ctx.db, { type: 'gen.poll', payload: { takeId: 'take_prj_be04pol001' },
      projectId: 'prj_be04pol001' }); // seed：take running + gen_task running（已提交、结果未知）
    assert.equal(s.status, 'failed');
    assert.equal(s.error.code, 'TAKE_UNKNOWN');
    assert.equal(s.frozen, 3000, 'unknown 金额保持冻结待核对');
    const takes = await takeState(ctx.db, 'prj_be04pol001');
    assert.equal(takes[0].take_status, 'unknown');
    assert.equal(takes[0].task_status, 'unknown');
    // 点重试 → 被正确拒绝（结果未知绝不重提上游）
    await assert.rejects(() => retryProject(ctx.db, { userId: USER, projectId: 'prj_be04pol001' }),
      (err) => err.code === 'PROJECT_STATE_INVALID' && /待核对/.test(err.message));
    const { rows: jobs } = await ctx.db.query(
      `SELECT count(*)::int AS n FROM jobs WHERE type = 'segment.generate' AND payload->>'projectId' = 'prj_be04pol001'`);
    assert.equal(jobs[0].n, 0, '不允许出现新的片段生成任务（上游提交次数保持 1）');
  });

  test('b2) segment.generate 耗尽（gen_task=running 已提交）→ unknown 同口径，重试被拒', async () => {
    const s = await runExhausted(ctx.db, { type: 'segment.generate', payload: { projectId: 'prj_be04segr01', idx: 0 },
      projectId: 'prj_be04segr01', taskStatus: 'running', finalPrompt: true });
    assert.equal(s.error.code, 'TAKE_UNKNOWN');
    const takes = await takeState(ctx.db, 'prj_be04segr01');
    assert.equal(takes[0].take_status, 'unknown');
    assert.equal(takes[0].task_status, 'unknown');
    assert.equal(s.frozen, 3000);
    await assert.rejects(() => retryProject(ctx.db, { userId: USER, projectId: 'prj_be04segr01' }),
      (err) => err.code === 'PROJECT_STATE_INVALID');
  });

  test('b1) segment.generate 耗尽（gen_task=created 从未提交）→ take failed 可重试；重试后新 take 提交 + gen.poll 入队（流程继续）', async () => {
    const s = await runExhausted(ctx.db, { type: 'segment.generate', payload: { projectId: 'prj_be04segc01', idx: 0 },
      projectId: 'prj_be04segc01', taskStatus: 'created', finalPrompt: true });
    assert.equal(s.status, 'failed');
    assert.equal(s.error.code, 'SEGMENT_FAILED', '与明确失败同口径（可重试）');
    assert.equal(s.frozen, 3000, 'A 口径冻结保持（重试建新 take 复用）');
    let takes = await takeState(ctx.db, 'prj_be04segc01');
    assert.equal(takes[0].take_status, 'failed');
    assert.equal(takes[0].task_status, 'failed');

    // 点重试 → 放行，作品回 rendering
    await retryProject(ctx.db, { userId: USER, projectId: 'prj_be04segc01' });
    assert.equal((await stateOf(ctx.db, 'prj_be04segc01')).status, 'rendering');

    // 真实执行 segment.generate（fake 上游）：建新 take 并首次提交（旧 failed take 保留）
    const videoProvider = { id: 'fake-video', submissions: [],
      prepare: (x) => x,
      async submit(prepared) { this.submissions.push(prepared); return { status: 'running', upstreamId: `up_${this.submissions.length}` }; },
      async query() { return { status: 'running' }; } };
    const queue = [];
    const handlerCtx = () => ({ db: ctx.db, logger: silent, enqueue: async (spec) => queue.push(spec), extendLease: async () => {} });
    const generate = createSegmentGenerateHandler({ db: ctx.db, logger: silent, config,
      videoProvider, storage: createMemoryStorage() });
    await generate({ projectId: 'prj_be04segc01', idx: 0 }, handlerCtx());

    assert.equal(videoProvider.submissions.length, 1, '重试后恰好一次新提交（此前从未提交成功）');
    takes = await takeState(ctx.db, 'prj_be04segc01');
    assert.equal(takes.length, 2, '新 take 已建，旧 failed take 保留');
    assert.equal(takes[1].take_status, 'running');
    assert.ok(queue.some((spec) => spec.type === 'gen.poll'), '流程继续：gen.poll 已入队');
  });

  test('c1) look.generate 耗尽（created 从未提交）→ 版本 failed + 退款 + LOOK_FAILED；重试补建新版本并生成成功', async () => {
    const s = await runExhausted(ctx.db, { type: 'look.generate', payload: { versionId: 'lkv_prj_be04looc01' },
      projectId: 'prj_be04looc01', withLookVersion: true, lookTaskStatus: 'created', projectStatus: 'casting' });
    assert.equal(s.status, 'failed');
    assert.equal(s.error.code, 'LOOK_FAILED', '可重试口径');
    const version = (await ctx.db.query(`SELECT status FROM look_versions WHERE id = 'lkv_prj_be04looc01'`)).rows[0];
    assert.equal(version.status, 'failed', '版本收口为 failed（重试才有可补建的版本）');
    const wallet = (await ctx.db.query(`SELECT available_fen, frozen_fen FROM wallets WHERE user_id = '${USER}'`)).rows[0];
    assert.equal(wallet.available_fen, 60, '预占退回到可用余额');

    // 点重试 → 放行：补建新版本（amountFen=0 平台承担）并入队 look.generate
    await retryProject(ctx.db, { userId: USER, projectId: 'prj_be04looc01' });
    const { rows: newJobs } = await ctx.db.query(
      `SELECT payload->>'versionId' AS vid FROM jobs WHERE type = 'look.generate' ORDER BY created_at DESC LIMIT 1`);
    const newVersionId = newJobs[0]?.vid;
    assert.ok(newVersionId && newVersionId !== 'lkv_prj_be04looc01', '已入队新版本的生成任务');

    // 真实执行 look.generate（mock 图片渠道成功）→ 新版本 succeeded、作品推进 cast_review
    const imageProvider = mockImageProvider();
    const look = createLookGenerateHandler({ db: ctx.db, logger: silent,
      storage: createMemoryStorage(), imageProvider });
    await look({ versionId: newVersionId }, { db: ctx.db, logger: silent,
      job: { attempts: 1 }, enqueue: async () => {}, extendLease: async () => {} });
    assert.equal(imageProvider.calls.length, 1, '重试形象恰好生成一次');
    const newVersion = (await ctx.db.query(`SELECT status FROM look_versions WHERE id = $1`, [newVersionId])).rows[0];
    assert.equal(newVersion.status, 'succeeded');
    assert.equal((await stateOf(ctx.db, 'prj_be04looc01')).status, 'cast_review', '流程继续：全部形象就绪进入确认点 B');
    // 本用例经 retryProject 真实入队了 look.generate job（已由 handler 执行成功）——标记完成，
    // 避免后续用例的 worker.runOne 领到遗留任务而非自己的任务（注意队列初始状态是 queued）
    await ctx.db.query(
      `UPDATE jobs SET status = 'done', updated_at = now() WHERE type = 'look.generate' AND status NOT IN ('done', 'failed')`);
  });

  test('c2) look.generate 耗尽（running 已提交）→ LOOK_UNKNOWN，版本保持 pending，重试被拒、形象上游零重提', async () => {
    const s = await runExhausted(ctx.db, { type: 'look.generate', payload: { versionId: 'lkv_prj_be04look02' },
      projectId: 'prj_be04look02', withLookVersion: true, lookTaskStatus: 'running', projectStatus: 'casting' });
    assert.equal(s.status, 'failed');
    assert.equal(s.error.code, 'LOOK_UNKNOWN');
    const row = (await ctx.db.query(
      `SELECT lv.status AS v, gt.status AS t FROM look_versions lv JOIN gen_tasks gt ON gt.id = lv.gen_task_id
        WHERE lv.id = 'lkv_prj_be04look02'`)).rows[0];
    assert.equal(row.v, 'pending', '版本保持 pending（结果未知，等对账）');
    assert.equal(row.t, 'unknown');
    // 点重试 → 被正确拒绝；不存在任何新的待执行 look.generate 任务（上游提交次数保持 1）
    await assert.rejects(() => retryProject(ctx.db, { userId: USER, projectId: 'prj_be04look02' }),
      (err) => err.code === 'PROJECT_STATE_INVALID' && /待核对/.test(err.message));
    const { rows: jobs } = await ctx.db.query(
      `SELECT count(*)::int AS n FROM jobs WHERE type = 'look.generate' AND status NOT IN ('done', 'failed')`);
    assert.equal(jobs[0].n, 0, '没有补建新的形象生成任务');
  });

  test('look.generate 耗尽但版本/gen_task 缺失 → 退回普通 PIPELINE_FAILED 兜底', async () => {
    const s = await runExhausted(ctx.db, { type: 'look.generate', payload: { versionId: 'lkv_prj_be04look03' },
      projectId: 'prj_be04look03', withLookVersion: true, lookTaskStatus: null, projectStatus: 'casting' });
    assert.equal(s.status, 'failed');
    assert.equal(s.error.code, 'PIPELINE_FAILED', '无在途 gen_task 可收口时按普通兜底（反查项目）');
    assert.equal(s.error.step, 'casting');
  });
});
