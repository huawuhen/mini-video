// M3-ADM-04 价格锁定（TASKS：改价前必须先补价格锁定）：
// 作品确认点 B 消费报价时把视频单价锁进 projects.video_unit_fen，此后 segment.generate、
// 失败重试、详情 pricing 一律按锁定价——渲染中途改价、重试前改价都按锁定价结算、冻结归零；
// 改价后的新报价用新价，改价前的未消费报价按 M1-BE-02 契约 QUOTE_MISMATCH。
// 用独立测试库 + 合成样片（FFmpeg lavfi），零真实模型费用。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { createMemoryStorage } from '../src/engine/storage/memory.js';
import { createQuote, consumeQuote } from '../src/wallet/pricing.js';
import { createTestDb } from './helpers/db.js';
import { silentLogger } from '../src/logger.js';
import { loadConfig } from '../src/config.js';
import { confirmCast, getProjectDetail, retryProject } from '../src/projects/service.js';
import { createGenPollHandler, createSegmentGenerateHandler } from '../src/projects/segment.js';
import { createRender } from '../src/render/index.js';

const config = loadConfig({ NODE_ENV: 'test' });
const USER = 'usr_user00000001';
const SKU_CODE = 'video.480p'; // 迁移 009 逻辑 SKU：standard 档映射指向它，当前价 100 分/秒

function httpMemoryStorage() {
  const memory = createMemoryStorage();
  return {
    put: memory.put, remove: memory.remove,
    async signedUrl(key, opts) { return `https://signed.example/${key}?ttl=${opts?.ttlSeconds ?? 3600}`; },
  };
}

/** 合成 30 秒样片（inspect 时长偏差 ≤2 秒、有音轨、非全黑）。整个文件共用一份。 */
async function makeSample(name) {
  const dir = join(tmpdir(), 'miv-pricing-lock-samples');
  await mkdir(dir, { recursive: true });
  const file = join(dir, name);
  await new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi',
      '-i', 'testsrc2=size=720x1280:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440',
      '-t', '30', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', file], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { if (stderr.length < 4000) stderr += chunk; });
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(stderr))));
    child.on('error', reject);
  });
  return file;
}

function fakeVideoProvider({ results = [] }) {
  const submissions = [];
  return {
    id: 'fake-video',
    submissions,
    prepare(input) { return input; },
    async submit(prepared) { submissions.push(prepared); return { status: 'running', upstreamId: `up_${submissions.length}` }; },
    // upstreamId up_N = 本实例第 N 次提交；results[N-1] 是它的轮询结果序列，耗尽后维持 running
    async query(upstreamId) {
      const seq = results[Number(String(upstreamId).slice(3)) - 1];
      return seq?.shift() ?? { status: 'running' };
    },
    normalize(raw) { return raw; },
  };
}

/** 改价：为 SKU 插入 version 99（500 分/秒）并下线旧版本（与管理端「新增版本-立即生效」同效果）。 */
async function changePrice(db, priceFen = 500) {
  await db.tx(async (t) => {
    await t.query(
      `INSERT INTO skus (id, sku_code, version, kind, model, channel, resolution, unit, price_fen, cost_fen, durations)
       SELECT 'sku_pricelock0000099', sku_code, 99, kind, model, channel, resolution, unit, $2, cost_fen, durations
         FROM skus WHERE sku_code = $1 ORDER BY version DESC LIMIT 1`, [SKU_CODE, priceFen]);
    await t.query(`UPDATE skus SET status = 'inactive' WHERE sku_code = $1 AND version < 99`, [SKU_CODE]);
  });
}

/** 未来生效改价：插入 version 99（500 分/秒）但 effective_at 在明天——旧版本保持 active。 */
async function futureChangePrice(db) {
  await db.tx(async (t) => {
    await t.query(
      `INSERT INTO skus (id, sku_code, version, kind, model, channel, resolution, unit, price_fen, cost_fen, durations, effective_at)
       SELECT 'sku_pricelock0000099', sku_code, 99, kind, model, channel, resolution, unit, 500, cost_fen, durations,
              now() + interval '1 day'
         FROM skus WHERE sku_code = $1 ORDER BY version DESC LIMIT 1`, [SKU_CODE]);
  });
}

async function wallet(db) {
  const { rows } = await db.query(`SELECT available_fen, frozen_fen FROM wallets WHERE user_id = $1`, [USER]);
  return rows[0];
}

describe('价格锁定（M3-ADM-04）', () => {
  let ctx;
  let sample;
  let seq = 0;

  before(async () => {
    ctx = await createTestDb();
    // 用户与数字资产：已有本风格成功形象（确认点 B 只需角色就绪）
    await ctx.db.query(`INSERT INTO users (id, phone, nickname) VALUES ($1, '15800000001', '用户A')`, [USER]);
    await ctx.db.query(`INSERT INTO wallets (user_id) VALUES ($1)`, [USER]);
    await ctx.db.query(`INSERT INTO characters (id, user_id, name, description)
      VALUES ('chr_baby00000001', $1, '宝宝', '好奇活泼')`, [USER]);
    await ctx.db.query(`INSERT INTO character_looks (id, character_id, style_id)
      VALUES ('look_baby00000001', 'chr_baby00000001', 'anime')`);
    await ctx.db.query(`INSERT INTO look_versions (id, look_id, status, image_key)
      VALUES ('lkv_baby000000001', 'look_baby00000001', 'succeeded', 'users/u/looks/a.png')`);
    await ctx.db.query(`UPDATE character_looks SET selected_version_id = 'lkv_baby000000001' WHERE id = 'look_baby00000001'`);
    sample = await makeSample('sample-30s.mp4');
  });
  after(async () => { await ctx.drop(); });

  beforeEach(async () => {
    // 逐条清理（带参数查询不支持多语句）；本文件的作品 id 统一 prj_lock 前缀
    for (const sql of [
      `DELETE FROM gen_tasks WHERE user_id = '${USER}'`,
      `UPDATE segments SET selected_take_id = NULL WHERE project_id LIKE 'prj_lock%'`,
      `DELETE FROM segment_takes WHERE segment_id IN (SELECT id FROM segments WHERE project_id LIKE 'prj_lock%')`,
      `DELETE FROM segments WHERE project_id LIKE 'prj_lock%'`,
      `DELETE FROM project_cast WHERE project_id LIKE 'prj_lock%'`,
      `DELETE FROM project_events WHERE project_id LIKE 'prj_lock%'`,
      `DELETE FROM project_confirm_log WHERE project_id LIKE 'prj_lock%'`,
      `DELETE FROM quotes WHERE user_id = '${USER}'`,
      `DELETE FROM projects WHERE id LIKE 'prj_lock%'`,
      `DELETE FROM skus WHERE sku_code = '${SKU_CODE}' AND version = 99`,
      `UPDATE skus SET status = 'active' WHERE sku_code = '${SKU_CODE}' AND version < 99`,
      'DELETE FROM jobs',
      'DELETE FROM ledger',
    ]) await ctx.db.query(sql);
    await ctx.db.query(`UPDATE wallets SET available_fen = 10000, frozen_fen = 0 WHERE user_id = $1`, [USER]);
  });

  /** 造一个 cast_review 作品：2 段 × 30 秒、角色形象/声音就绪。 */
  async function makeProject() {
    seq += 1;
    const projectId = `prj_lock${String(seq).padStart(9, '0')}`;
    await ctx.db.query(
      `INSERT INTO projects (id, user_id, story_text, source_type, style_id, quality_tier_id,
                             tier_mapping_id, ratio, status)
       VALUES ($1, $2, '测试故事', 'text', 'anime', 'standard', 'tm_standard00000001', '9:16', 'cast_review')`,
      [projectId, USER]);
    await ctx.db.query(
      `INSERT INTO project_cast (id, project_id, idx, name, character_id, match_source, look_version_id, voice_id, voice_source)
       VALUES ($1, $2, 0, '宝宝', 'chr_baby00000001', 'user', 'lkv_baby000000001', 'vc_childf_sweet', 'user')`,
      [`pc_${projectId}`, projectId]);
    await ctx.db.query(
      `INSERT INTO segments (id, project_id, idx, duration_seconds, plot)
       VALUES ($1, $2, 0, 30, '第一段'), ($3, $2, 1, 30, '第二段')`,
      [`seg_${projectId}_0`, projectId, `seg_${projectId}_1`]);
    // 预置最终提示词（bind_prompts 的产物；本项目直接写库以聚焦价格链路）
    await ctx.db.query(
      `UPDATE segments SET final_prompt = '{"prompt":"test prompt","imageRefs":["users/u/looks/a.png"],"audioRefs":[]}'::jsonb
        WHERE project_id = $1`, [projectId]);
    return projectId;
  }

  /** 确认点 B：报价 → confirmCast（锁定单价 + 预占）。 */
  async function confirm(projectId, idemKey) {
    const { quoteId } = await ctx.db.tx((t) => createQuote(t, { userId: USER,
      request: { kind: 'project_render', projectId } }));
    await confirmCast(ctx.db, { userId: USER, projectId, quoteId, idempotencyKey: idemKey, config });
  }

  /** 跑完整段链：segment.generate → gen.poll 直到成功结算。 */
  async function runSegment(projectId, idx, videoProvider) {
    const storage = httpMemoryStorage();
    const render = createRender({ logger: silentLogger });
    const downloadToTempFile = async (_url, localPath) => { await copyFile(sample, localPath); return localPath; };
    const generate = createSegmentGenerateHandler({ db: ctx.db, logger: silentLogger, config, videoProvider, storage });
    const poll = createGenPollHandler({ db: ctx.db, logger: silentLogger, config, videoProvider, storage, render, downloadToTempFile });
    const jobCtx = { db: ctx.db, logger: silentLogger, enqueue: async () => {}, extendLease: async () => {} };
    await generate({ projectId, idx }, jobCtx);
    let takeId = (await ctx.db.query(
      `SELECT t.id FROM segment_takes t JOIN segments s ON s.id = t.segment_id
        WHERE s.project_id = $1 AND s.idx = $2 ORDER BY t.created_at DESC, t.id DESC LIMIT 1`,
      [projectId, idx])).rows[0].id;
    for (let i = 0; i < 20; i += 1) {
      const { rows: take } = await ctx.db.query(`SELECT status FROM segment_takes WHERE id = $1`, [takeId]);
      if (['succeeded', 'failed', 'unknown'].includes(take[0].status)) return take[0].status;
      await poll({ takeId }, jobCtx);
    }
    const { rows: finalTake } = await ctx.db.query(`SELECT status FROM segment_takes WHERE id = $1`, [takeId]);
    throw new Error(`轮询未收敛：take=${finalTake[0].status}`);
  }

  test('确认点 B 锁定单价：video_unit_fen = 确认时点价格', async () => {
    const projectId = await makeProject();
    await confirm(projectId, 'lock-c1');
    const { rows } = await ctx.db.query(`SELECT video_unit_fen FROM projects WHERE id = $1`, [projectId]);
    assert.equal(rows[0].video_unit_fen, 100, '锁定确认时点的 100 分/秒（迁移 009 逻辑 SKU）');
    assert.equal((await wallet(ctx.db)).frozen_fen, 6000);
  });

  test('渲染中途改价：第 2 段按锁定价下单结算，两段全部结算后冻结归零', async () => {
    const projectId = await makeProject();
    await confirm(projectId, 'lock-c2');
    // 第 1 段按 100 分/秒生成并结算
    const provider1 = fakeVideoProvider({ results: [[{ status: 'succeeded',
      outputs: [{ url: 'https://upstream.example/v1.mp4', kind: 'video' }] }]] });
    assert.equal(await runSegment(projectId, 0, provider1), 'succeeded');
    assert.equal((await wallet(ctx.db)).frozen_fen, 3000, '第 1 段结算 3000');
    // ── 改价：100 → 500 ──
    await changePrice(ctx.db);
    // 第 2 段必须仍按锁定的 100 分/秒下单与结算
    const provider2 = fakeVideoProvider({ results: [[{ status: 'succeeded',
      outputs: [{ url: 'https://upstream.example/v2.mp4', kind: 'video' }] }]] });
    assert.equal(await runSegment(projectId, 1, provider2), 'succeeded');
    const { rows: tasks } = await ctx.db.query(
      `SELECT request FROM gen_tasks ORDER BY created_at`);
    const amountFens = tasks.map((row) => (typeof row.request === 'string' ? JSON.parse(row.request) : row.request).amountFen);
    assert.deepEqual(amountFens, [3000, 3000], '两段下单金额都是锁定价 100×30，不受改价影响');
    const money = (await wallet(ctx.db));
    assert.equal(money.frozen_fen, 0, '两段全部结算，冻结归零');
    assert.equal(money.available_fen, 4000, '可用余额只扣确认时总价 6000');
    const { rows: settles } = await ctx.db.query(
      `SELECT amount_fen, frozen_delta_fen FROM ledger WHERE kind = 'settle' ORDER BY created_at`);
    assert.deepEqual(settles.map((row) => [row.amount_fen, row.frozen_delta_fen]), [[0, -3000], [0, -3000]]);
  });

  test('重试前改价：失败片段重试仍按锁定价结算、冻结归零', async () => {
    const projectId = await makeProject();
    await confirm(projectId, 'lock-c3');
    // 第 1 段上游明确失败 → 作品 failed、冻结保持（A 口径）
    // 提交直接被拒绝（提交前的明确失败路径）：segment.generate 对 failed 提交走 failSegment
    const rejecting = fakeVideoProvider({});
    rejecting.submit = async () => ({ status: 'failed', error: '上游拒绝' });
    const storage = httpMemoryStorage();
    const generate = createSegmentGenerateHandler({ db: ctx.db, logger: silentLogger, config,
      videoProvider: rejecting, storage });
    await generate({ projectId, idx: 0 }, { db: ctx.db, logger: silentLogger, enqueue: async () => {} });
    const { rows: project } = await ctx.db.query(`SELECT status, error FROM projects WHERE id = $1`, [projectId]);
    assert.equal(project[0].status, 'failed');
    assert.equal((await wallet(ctx.db)).frozen_fen, 6000, '失败保持冻结');
    // ── 改价后再重试 ──
    await changePrice(ctx.db);
    await retryProject(ctx.db, { userId: USER, projectId });
    const okProvider = fakeVideoProvider({ results: [
      [{ status: 'succeeded', outputs: [{ url: 'https://upstream.example/v1.mp4', kind: 'video' }] }],
      [{ status: 'succeeded', outputs: [{ url: 'https://upstream.example/v2.mp4', kind: 'video' }] }],
    ] });
    assert.equal(await runSegment(projectId, 0, okProvider), 'succeeded');
    assert.equal(await runSegment(projectId, 1, okProvider), 'succeeded');
    const { rows: tasks } = await ctx.db.query(`SELECT request FROM gen_tasks ORDER BY created_at`);
    const amountFens = tasks.map((row) => (typeof row.request === 'string' ? JSON.parse(row.request) : row.request).amountFen);
    assert.deepEqual(amountFens, [3000, 3000, 3000],
      '失败 take、重试 take、第 2 段都按确认时锁定价下单（改价 500 不生效；失败 take 金额也是下单时写的 3000）');
    const money = (await wallet(ctx.db));
    assert.equal(money.frozen_fen, 0, '冻结归零');
    assert.equal(money.available_fen, 4000);
  });

  test('改价后的报价与展示：新报价用新价；旧报价消费 409 QUOTE_MISMATCH；详情 pricing 按锁定价', async () => {
    await ctx.db.query(`UPDATE wallets SET available_fen = 50000 WHERE user_id = $1`, [USER]); // 新价冻结 30000 需要更高余额
    const projectId = await makeProject();
    // 改价前创建报价（未消费）
    const stale = await ctx.db.tx((t) => createQuote(t, { userId: USER,
      request: { kind: 'project_render', projectId } }));
    await changePrice(ctx.db);
    // 旧报价消费被拒（M1-BE-02 契约：调价后旧报价重算出新价、与原额不一致 → QUOTE_MISMATCH，用户重新取价）
    await assert.rejects(() => consumeQuote(ctx.db, { userId: USER, quoteId: stale.quoteId,
      kind: 'project_render', refType: 'project', refId: projectId }), { code: 'QUOTE_MISMATCH' });
    // 改价后的新报价按新价（500×60）
    const projectId2 = await makeProject();
    const fresh = await ctx.db.tx((t) => createQuote(t, { userId: USER,
      request: { kind: 'project_render', projectId: projectId2 } }));
    assert.equal(fresh.amountFen, 30000);
    await confirmCast(ctx.db, { userId: USER, projectId: projectId2, quoteId: fresh.quoteId,
      idempotencyKey: 'lock-c4-fresh', config });
    const { rows: locked } = await ctx.db.query(`SELECT video_unit_fen FROM projects WHERE id = $1`, [projectId2]);
    assert.equal(locked[0].video_unit_fen, 500, '新作品按确认时点的新价锁定');
    assert.equal((await wallet(ctx.db)).frozen_fen, 30000);
    // 旧价确认的作品：详情 pricing 用锁定价，改价后 videoFen 不变（模拟迁移 016 前已确认的作品）
    const projectIdOld = await makeProject();
    await ctx.db.query(`UPDATE projects SET video_unit_fen = 100 WHERE id = $1`, [projectIdOld]);
    const detail = await getProjectDetail(ctx.db, { userId: USER, projectId: projectIdOld });
    assert.equal(detail.pricing.videoFen, 6000, '详情视频费按锁定价 100×60（当前价已是 500）');
    assert.equal(detail.pricing.frozenFen, 0);
  });

  test('未来生效版本：旧作品回退与详情都按当前价，到点后才切换（复审必改②）', async () => {
    const projectId = await makeProject();
    await confirm(projectId, 'lock-c5');
    await ctx.db.query(`UPDATE projects SET video_unit_fen = NULL WHERE id = $1`, [projectId]);
    // 插入明天生效的 500 分/秒版本（旧版本保持 active）——当前价必须仍是 100
    await futureChangePrice(ctx.db);
    const provider = fakeVideoProvider({ results: [] });
    const storage = httpMemoryStorage();
    const generate = createSegmentGenerateHandler({ db: ctx.db, logger: silentLogger, config, videoProvider: provider, storage });
    await generate({ projectId, idx: 0 }, { db: ctx.db, logger: silentLogger, enqueue: async () => {} });
    const readAmount = async () => {
      const { rows } = await ctx.db.query(`SELECT request FROM gen_tasks ORDER BY created_at DESC LIMIT 1`);
      return (typeof rows[0].request === 'string' ? JSON.parse(rows[0].request) : rows[0].request).amountFen;
    };
    assert.equal(await readAmount(), 3000, '未来版本生效前，NULL 回退按当前价 100×30 下单（不是 15000）');
    // 未确认作品的详情 pricing（回退当前价）同样不受未来版本影响
    const detail = await getProjectDetail(ctx.db, { userId: USER, projectId });
    assert.equal(detail.pricing.videoFen, 6000, '详情 videoFen 按当前价 100×60（不是未来价 500×60）');
    // ── 到点切换：把未来版本的生效时间改到过去，取价应立即用新版本 ──
    await ctx.db.query(`UPDATE skus SET effective_at = now() - interval '1 minute'
      WHERE sku_code = $1 AND version = 99`, [SKU_CODE]);
    // 第 1 段已有 take（created 未提交）——先把它置 failed，再生成第 2 段验证新价
    await ctx.db.query(`UPDATE segment_takes SET status = 'failed' WHERE segment_id = (
      SELECT id FROM segments WHERE project_id = $1 AND idx = 0)`, [projectId]);
    await generate({ projectId, idx: 1 }, { db: ctx.db, logger: silentLogger, enqueue: async () => {} });
    assert.equal(await readAmount(), 15000, '生效时间已过 → 切到 500×30');
  });
});
