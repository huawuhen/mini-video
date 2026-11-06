// 管理端·作品与失败/待核对处理（M3-ADM-03，API.md §8.3，2026-11-05 判定新规则）：
// 列表过滤（含只看待核对）、详情（金额聚合、take 冻结取下单金额 gen_tasks.request.amountFen）、
// 判定两种结论**都不向用户结算**（上游已扣费由平台承担）——可重试作品保持冻结、
// redelivery / 已取消过期当场退回；判定后重试复用冻结正常结算、不动其他作品的钱；
// 改价后判定仍按下单金额；同键不同结论 409、重放不重复写审计、后台取消。全部零真实费用。
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import express from 'express';
import { createTestDb } from './helpers/db.js';
import { createLogger } from '../src/logger.js';
import { hashAdminPassword, encryptCredential } from '../src/channels/crypto.js';
import { createAdminAuth } from '../src/channels/admin-auth.js';
import { adminProjectsRoutes } from '../src/api/admin-projects.js';
import { retryProject, cancelProject } from '../src/projects/service.js';
import { settleSegment } from '../src/projects/money.js';
import { errorHandler, asyncHandler } from '../src/http/middleware.js';
import { appError } from '../src/http/errors.js';
import { newId } from '../src/db/ids.js';

const silentLogger = createLogger({ level: 'silent' });

function clientFor(base) {
  const jars = new Map();
  async function call(label, method, path, { body, csrf } = {}) {
    const headers = {};
    const cookie = jars.get(label);
    if (cookie) headers.cookie = cookie;
    if (csrf) headers['x-csrf-token'] = csrf;
    const response = await fetch(`${base}${path}`, {
      method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) jars.set(label, setCookie.split(';')[0]);
    const text = await response.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
    return { status: response.status, json };
  }
  return { call };
}

describe('管理端·作品与待核对（M3-ADM-03）', () => {
  let testDb;
  let server;
  let base;
  let client;
  let csrfToken;
  let adminId;
  let u1;
  let prjX; // failed（可重试）：take1 unknown（下单 3000）+ take2 succeeded（已结算 3000）
  let prjD; // delivered：redelivery unknown take（下单 2500）
  let prjC; // canceled：unknown take（下单 1800）
  let prjY; // rendering：无 unknown（冻结 2000，取消测试）
  let prjE; // composing：unknown take（下单 900）+ 其他冻结 1100（取消测试）
  let unknownTakeId;
  let redeliveryTakeId;
  let canceledTakeId;
  let succeededTakeId;
  let composeTakeId;
  let gtUnknownId;

  const wallet = async () => (await testDb.db.query(
    `SELECT available_fen, frozen_fen FROM wallets WHERE user_id = $1`, [u1])).rows[0];
  const take = async (id) => (await testDb.db.query(`SELECT * FROM segment_takes WHERE id = $1`, [id])).rows[0];
  const ledgerByKey = async (key) => (await testDb.db.query(
    `SELECT kind, amount_fen, frozen_delta_fen, title FROM ledger WHERE idempotency_key = $1`, [key])).rows[0] ?? null;

  before(async () => {
    testDb = await createTestDb();
    const db = testDb.db;
    adminId = newId('adm');
    await db.query(
      `INSERT INTO admin_users (id, username, password_hash, display_name) VALUES ($1, 'admin', $2, '测试管理员')`,
      [adminId, hashAdminPassword('admin-password-123')]);

    u1 = newId('usr');
    await db.query(`INSERT INTO users (id, phone, nickname) VALUES ($1, '15922220001', '测试用户')`, [u1]);
    await db.query(`INSERT INTO wallets (user_id, available_fen, frozen_fen) VALUES ($1, 10000, 0)`, [u1]);
    const { rows: tm } = await db.query(`SELECT id FROM tier_mappings ORDER BY id LIMIT 1`);
    const tierMappingId = tm[0].id;
    const { rows: styles } = await db.query(`SELECT id FROM styles ORDER BY id LIMIT 1`);
    const { rows: tiers } = await db.query(`SELECT id FROM quality_tiers ORDER BY id LIMIT 1`);
    // 渠道记录不在迁移里播种（009）——测试自插（凭证 AES-GCM，与生产同构）
    const channelId = newId('pch');
    await db.query(
      `INSERT INTO provider_channels (id, kind, name, driver, base_url, credential_enc)
       VALUES ($1, 'video', 'test-channel', 'local-mock', 'https://channel.test', $2)`,
      [channelId, encryptCredential('k'.repeat(48), 'channel-secret-0001')]);

    const mkProject = async ({ id, status, daysAgo, error = null }) => {
      await db.query(
        `INSERT INTO projects (id, user_id, story_text, source_type, style_id, quality_tier_id, tier_mapping_id, status, title, error, created_at, updated_at)
         VALUES ($1, $2, '测试故事', 'text', $3, $4, $5, $6, $7, $8, now() - make_interval(days => $9), now())`,
        [id, u1, styles[0].id, tiers[0].id, tierMappingId, status, `作品${id.slice(-4)}`,
          error ? JSON.stringify(error) : null, daysAgo]);
    };
    const mkSegment = async ({ id, projectId, idx, seconds }) => {
      await db.query(
        `INSERT INTO segments (id, project_id, idx, duration_seconds, plot) VALUES ($1, $2, $3, $4, '剧情')`,
        [id, projectId, idx, seconds]);
    };
    const mkGenTask = async ({ id, request, status = 'unknown' }) => {
      await db.query(
        `INSERT INTO gen_tasks (id, user_id, kind, provider, upstream_id, status, request, idempotency_key, channel_id)
         VALUES ($1, $2, 'video', 'test-provider', $3, $4, $5, $6, $7)`,
        [id, u1, `up_${id}`, status, JSON.stringify(request), `gt-${id}`, channelId]);
    };
    const mkTake = async ({ id, segmentId, status, genTaskId }) => {
      await db.query(
        `INSERT INTO segment_takes (id, segment_id, status, gen_task_id) VALUES ($1, $2, $3, $4)`,
        [id, segmentId, status, genTaskId]);
    };
    const mkLedger = async ({ key, kind, amountFen, frozenDeltaFen, refId, title = '夹具' }) => {
      await db.query(
        `INSERT INTO ledger (id, user_id, kind, amount_fen, frozen_delta_fen, title, ref_type, ref_id, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, 'project', $7, $8)`,
        [newId('led'), u1, kind, amountFen, frozenDeltaFen, title, refId, key]);
    };

    // prjX（failed，可重试）：seg1 unknown 下单 3000；seg2 succeeded 已结算 3000 → 冻结 3000 = take1 下单金额
    prjX = newId('prj');
    await mkProject({ id: prjX, status: 'failed', daysAgo: 4, error: { code: 'TAKE_UNKNOWN', step: 'rendering', message: '待核对' } });
    const seg1 = newId('seg');
    const seg2 = newId('seg');
    await mkSegment({ id: seg1, projectId: prjX, idx: 0, seconds: 30 });
    await mkSegment({ id: seg2, projectId: prjX, idx: 1, seconds: 30 });
    const gtUnknown = newId('gt');
    const gtOk = newId('gt');
    gtUnknownId = gtUnknown;
    unknownTakeId = newId('take');
    succeededTakeId = newId('take');
    await mkGenTask({ id: gtUnknown, request: { takeId: unknownTakeId, projectId: prjX, amountFen: 3000 } });
    await mkGenTask({ id: gtOk, request: { takeId: succeededTakeId, projectId: prjX, amountFen: 3000 }, status: 'succeeded' });
    await mkTake({ id: unknownTakeId, segmentId: seg1, status: 'unknown', genTaskId: gtUnknown });
    await mkTake({ id: succeededTakeId, segmentId: seg2, status: 'succeeded', genTaskId: gtOk });
    await mkLedger({ key: 'fx-reserve-x', kind: 'reserve', amountFen: -6000, frozenDeltaFen: 6000, refId: prjX, title: '视频生成预占' });
    await mkLedger({ key: 'fx-settle-x', kind: 'settle', amountFen: 0, frozenDeltaFen: -3000, refId: prjX, title: '片段生成结算' });

    // prjD（delivered）：redelivery unknown take，下单 2500（该笔预占独立账本）
    prjD = newId('prj');
    await mkProject({ id: prjD, status: 'delivered', daysAgo: 2 });
    const segD = newId('seg');
    await mkSegment({ id: segD, projectId: prjD, idx: 0, seconds: 25 });
    const gtD = newId('gt');
    redeliveryTakeId = newId('take');
    await mkGenTask({ id: gtD, request: { takeId: redeliveryTakeId, projectId: prjD, amountFen: 2500, redelivery: true } });
    await mkTake({ id: redeliveryTakeId, segmentId: segD, status: 'unknown', genTaskId: gtD });
    await mkLedger({ key: `project:${prjD}:video:retake:${redeliveryTakeId}:reserve`,
      kind: 'reserve', amountFen: -2500, frozenDeltaFen: 2500, refId: prjD, title: '视频生成预占' });

    // prjC（canceled）：unknown take 下单 1800（取消时保留冻结，判定后当场退回）
    prjC = newId('prj');
    await mkProject({ id: prjC, status: 'canceled', daysAgo: 3 });
    const segC = newId('seg');
    await mkSegment({ id: segC, projectId: prjC, idx: 0, seconds: 18 });
    const gtC = newId('gt');
    canceledTakeId = newId('take');
    await mkGenTask({ id: gtC, request: { takeId: canceledTakeId, projectId: prjC, amountFen: 1800 } });
    await mkTake({ id: canceledTakeId, segmentId: segC, status: 'unknown', genTaskId: gtC });
    await mkLedger({ key: 'fx-reserve-c', kind: 'reserve', amountFen: -1800, frozenDeltaFen: 1800, refId: prjC, title: '视频生成预占' });

    // prjY（rendering，无 unknown）：冻结 2000 全部可退（取消测试基线）
    prjY = newId('prj');
    await mkProject({ id: prjY, status: 'rendering', daysAgo: 0 });
    await mkLedger({ key: 'fx-reserve-y', kind: 'reserve', amountFen: -2000, frozenDeltaFen: 2000, refId: prjY, title: '视频生成预占' });

    // prjE（composing）：unknown take 下单 900 + 其他冻结 1100 → 取消退 1100、保留 900
    prjE = newId('prj');
    await mkProject({ id: prjE, status: 'composing', daysAgo: 1 });
    const segE = newId('seg');
    await mkSegment({ id: segE, projectId: prjE, idx: 0, seconds: 9 });
    const gtE = newId('gt');
    composeTakeId = newId('take');
    await mkGenTask({ id: gtE, request: { takeId: composeTakeId, projectId: prjE, amountFen: 900 } });
    await mkTake({ id: composeTakeId, segmentId: segE, status: 'unknown', genTaskId: gtE });
    await mkLedger({ key: 'fx-reserve-e', kind: 'reserve', amountFen: -2000, frozenDeltaFen: 2000, refId: prjE, title: '视频生成预占' });

    // 钱包冻结 = 3000 + 2500 + 1800 + 2000 + 2000 = 11300
    await db.query(`UPDATE wallets SET frozen_fen = $2 WHERE user_id = $1`, [u1, 11300]);

    const config = { cookieSecure: false, sessionTtlDays: 1, allowedOrigins: [],
      admin: { loginMaxFailures: 5, loginFailWindowSeconds: 600, loginBanSeconds: 7200 } };
    const mount = () => {
      const app = express();
      app.use(express.json({ limit: '100kb' }));
      const auth = createAdminAuth({ config, db });
      app.post('/api/v1/admin/auth/login', asyncHandler(async (req, res) => {
        const session = await auth.login({ username: req.body?.username, password: req.body?.password, ip: req.ip });
        if (!session) throw appError('ADMIN_AUTH_REQUIRED', '用户名或密码不正确');
        auth.setCookie(res, session.token);
        res.json({ admin: session.admin, csrfToken: session.csrfToken });
      }));
      app.use('/api/v1', adminProjectsRoutes({ db, config, logger: silentLogger }));
      app.use(errorHandler(silentLogger));
      return app;
    };
    server = mount().listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}/api/v1`;
    client = clientFor(base);
    const login = await client.call('admin', 'POST', '/admin/auth/login',
      { body: { username: 'admin', password: 'admin-password-123' } });
    csrfToken = login.json.csrfToken;
  });

  after(async () => {
    server.closeAllConnections(); await new Promise((r) => server.close(r));
    await testDb.drop();
  });

  test('未登录 401；写操作缺 CSRF 403', async () => {
    const anon = clientFor(base);
    const { status, json } = await anon.call('a', 'GET', '/admin/projects');
    assert.equal(status, 401);
    assert.equal(json.code, 'ADMIN_AUTH_REQUIRED');
    const write = await client.call('admin', 'POST', `/admin/takes/${unknownTakeId}/resolve`,
      { body: { outcome: 'not_charged', note: 'x', idempotencyKey: 'k' } });
    assert.equal(write.status, 403);
    assert.equal(write.json.code, 'CSRF_INVALID');
  });

  test('列表：创建时间倒序；status/userId 过滤；hasUnknown 只列有待核对作品并带计数', async () => {
    const all = await client.call('admin', 'GET', '/admin/projects');
    assert.equal(all.status, 200);
    assert.deepEqual(all.json.items.map((item) => item.id), [prjY, prjE, prjD, prjC, prjX], '创建时间倒序');
    const counts = Object.fromEntries(all.json.items.map((item) => [item.id, item.unknownTakes]));
    assert.deepEqual(counts, { [prjY]: 0, [prjE]: 1, [prjD]: 1, [prjC]: 1, [prjX]: 1 });
    assert.equal(all.json.items[4].phoneMasked, '159****0001');
    const byStatus = await client.call('admin', 'GET', '/admin/projects?status=failed');
    assert.deepEqual(byStatus.json.items.map((item) => item.id), [prjX]);
    const canceled = await client.call('admin', 'GET', '/admin/projects?status=canceled');
    assert.deepEqual(canceled.json.items.map((item) => item.id), [prjC]);
    const byUser = await client.call('admin', 'GET', `/admin/projects?userId=${u1}`);
    assert.equal(byUser.json.items.length, 5);
    const unknownOnly = await client.call('admin', 'GET', '/admin/projects?hasUnknown=true');
    assert.deepEqual(unknownOnly.json.items.map((item) => item.id), [prjE, prjD, prjC, prjX]);
    const page1 = await client.call('admin', 'GET', '/admin/projects?limit=2');
    assert.ok(page1.json.nextCursor);
    const page2 = await client.call('admin', 'GET', `/admin/projects?limit=2&cursor=${encodeURIComponent(page1.json.nextCursor)}`);
    assert.equal(page2.json.items.length, 2);
    assert.ok(!page2.json.items.some((a) => page1.json.items.some((b) => b.id === a.id)));
    const badStatus = await client.call('admin', 'GET', '/admin/projects?status=nope');
    assert.equal(badStatus.status, 400);
  });

  test('详情：金额聚合；take 冻结取下单金额（改价后仍不变）；不存在 404 PROJECT_NOT_FOUND', async () => {
    const { status, json } = await client.call('admin', 'GET', `/admin/projects/${prjX}`);
    assert.equal(status, 200);
    assert.deepEqual(json.money, { reservedFen: 6000, settledFen: 3000, refundedFen: 0, frozenFen: 3000 });
    const unknown = json.segments.flatMap((seg) => seg.takes).find((tk) => tk.id === unknownTakeId);
    assert.equal(unknown.frozenFen, 3000, 'take 下单金额 3000');
    assert.equal(unknown.genTaskStatus, 'unknown');
    assert.ok(unknown.channel, '渠道名来自 gen_tasks.channel_id');
    assert.equal(unknown.upstreamTaskId, `up_${gtUnknownId}`);
    // 改价：插一个更高价的新版本 SKU（同 sku_code、version 99、price 500）→ 详情 frozenFen 仍取下单金额
    const { rows: skuRows } = await testDb.db.query(
      `SELECT s.* FROM tier_mappings tm JOIN skus s ON s.sku_code = tm.video_sku_code AND s.kind = 'video' AND s.status = 'active'
        WHERE tm.id = $1 ORDER BY s.version DESC LIMIT 1`, [(await testDb.db.query(`SELECT id FROM tier_mappings ORDER BY id LIMIT 1`)).rows[0].id]);
    await testDb.db.query(
      `INSERT INTO skus (id, sku_code, version, kind, model, channel, resolution, unit, price_fen, cost_fen, durations, with_audio, audio_ref)
       VALUES ('sku_test_newprice1', $1, 99, 'video', $2, $3, $4, $5, 500, $6, $7, $8, $9)`,
      [skuRows[0].sku_code, skuRows[0].model, skuRows[0].channel, skuRows[0].resolution, skuRows[0].unit,
        skuRows[0].cost_fen, skuRows[0].durations, skuRows[0].with_audio, skuRows[0].audio_ref]);
    const after = await client.call('admin', 'GET', `/admin/projects/${prjX}`);
    const unknownAfter = after.json.segments.flatMap((seg) => seg.takes).find((tk) => tk.id === unknownTakeId);
    assert.equal(unknownAfter.frozenFen, 3000, '改价后仍按下单金额（不按当前价 500/s 重算）');
    const missing = await client.call('admin', 'GET', '/admin/projects/prj_missing');
    assert.equal(missing.status, 404);
    assert.equal(missing.json.code, 'PROJECT_NOT_FOUND');
  });

  test('unknown 挡重试；判定（可重试作品）不向用户结算、保持冻结、时间线统一文案、同键换结论 409、重放不重复写审计', async () => {
    const beforeWallet = await wallet();
    assert.deepEqual([beforeWallet.available_fen, beforeWallet.frozen_fen], [10000, 11300]);
    // unknown 存在时重试被拒
    await assert.rejects(
      retryProject(testDb.db, { userId: u1, projectId: prjX }),
      (err) => err.code === 'PROJECT_STATE_INVALID');
    const done = await client.call('admin', 'POST', `/admin/takes/${unknownTakeId}/resolve`,
      { body: { outcome: 'not_charged', note: '渠道后台确认未扣费', idempotencyKey: 'resolve-001' }, csrf: csrfToken });
    assert.equal(done.status, 200);
    // 两种结论对用户资金相同：可重试作品保持冻结（不退不结）
    const afterWallet = await wallet();
    assert.deepEqual([afterWallet.available_fen, afterWallet.frozen_fen], [10000, 11300], '保持冻结');
    assert.equal(await ledgerByKey(`admin:resolve:${unknownTakeId}:refund`), null, '不产生退回流水');
    assert.equal(await ledgerByKey(`admin:resolve:${unknownTakeId}:settle`), null, '不产生结算流水');
    const takeRow = await take(unknownTakeId);
    assert.equal(takeRow.status, 'failed');
    assert.equal(takeRow.resolved_outcome, 'not_charged');
    assert.equal(takeRow.resolved_key, 'admin:resolve:resolve-001');
    assert.equal(takeRow.resolved_by, adminId);
    const event = done.json.events[0];
    assert.equal(event.progress.message, '已核对：该片段生成失败，费用未扣除');
    assert.equal(done.json.unknownTakes, 0);
    const auditRows = await testDb.db.query(`SELECT action, detail FROM admin_audit_logs WHERE action = 'take.resolve'`);
    assert.equal(auditRows.rowCount, 1);
    assert.equal(auditRows.rows[0].detail.outcome, 'not_charged');
    assert.equal(auditRows.rows[0].detail.refundedFen, 0);

    // 重放（同键同结论）：返回首次结果、审计不重复
    const replay = await client.call('admin', 'POST', `/admin/takes/${unknownTakeId}/resolve`,
      { body: { outcome: 'not_charged', note: '渠道后台确认未扣费', idempotencyKey: 'resolve-001' }, csrf: csrfToken });
    assert.equal(replay.status, 200);
    const auditsAfterReplay = await testDb.db.query(`SELECT id FROM admin_audit_logs WHERE action = 'take.resolve'`);
    assert.equal(auditsAfterReplay.rowCount, 1, '重放不重复写审计');
    // 同键不同结论：409 IDEMPOTENCY_CONFLICT
    const flip = await client.call('admin', 'POST', `/admin/takes/${unknownTakeId}/resolve`,
      { body: { outcome: 'charged', note: '换结论', idempotencyKey: 'resolve-001' }, csrf: csrfToken });
    assert.equal(flip.status, 409);
    assert.equal(flip.json.code, 'IDEMPOTENCY_CONFLICT');
    // 换键重判：409 TAKE_ALREADY_RESOLVED
    const again = await client.call('admin', 'POST', `/admin/takes/${unknownTakeId}/resolve`,
      { body: { outcome: 'charged', note: '再判', idempotencyKey: 'resolve-002' }, csrf: csrfToken });
    assert.equal(again.status, 409);
    assert.equal(again.json.code, 'TAKE_ALREADY_RESOLVED');
  });

  test('判定 → 重试闭环：新 take 成功结算下单金额，不动同一用户其他作品的冻结', async () => {
    const beforeWallet = await wallet();
    const retry = await retryProject(testDb.db, { userId: u1, projectId: prjX });
    assert.equal(retry.ok, true, '判定（take 已 failed）后重试放行');
    const project = (await testDb.db.query(`SELECT status FROM projects WHERE id = $1`, [prjX])).rows[0];
    assert.equal(project.status, 'rendering');
    // 模拟重试生成成功：seg1 建 take_new + gen_task（下单 3000）→ 走真实 settleSegment
    const seg1 = (await testDb.db.query(
      `SELECT id FROM segments WHERE project_id = $1 ORDER BY idx LIMIT 1`, [prjX])).rows[0].id;
    const newTakeId = newId('take');
    const newGt = newId('gt');
    await testDb.db.query(
      `INSERT INTO gen_tasks (id, user_id, kind, provider, status, request, idempotency_key)
       VALUES ($1, $2, 'video', 'test-provider', 'succeeded', $3, $4)`,
      [newGt, u1, JSON.stringify({ takeId: newTakeId, projectId: prjX, amountFen: 3000 }), `gt-${newGt}`]);
    await testDb.db.query(
      `INSERT INTO segment_takes (id, segment_id, status, gen_task_id) VALUES ($1, $2, 'succeeded', $3)`,
      [newTakeId, seg1, newGt]);
    await testDb.db.tx((t) => settleSegment(t, { userId: u1, projectId: prjX, takeId: newTakeId, amountFen: 3000 }));
    const afterWallet = await wallet();
    // 只结算本段下单金额 3000；prjD/prjC/prjY/prjE 的冻结分毫不动（2500+1800+2000+2000=8300）
    assert.deepEqual([afterWallet.available_fen, afterWallet.frozen_fen], [10000, 8300]);
    const settleRow = (await testDb.db.query(
      `SELECT frozen_delta_fen FROM ledger WHERE idempotency_key = $1`,
      [`project:${prjX}:video:${newTakeId}:settle`])).rows[0];
    assert.equal(Number(settleRow.frozen_delta_fen), -3000);
    void beforeWallet;
  });

  test('redelivery take 判定：当场退回下单金额（not_charged 也不留冻结）', async () => {
    const beforeWallet = await wallet();
    const done = await client.call('admin', 'POST', `/admin/takes/${redeliveryTakeId}/resolve`,
      { body: { outcome: 'not_charged', note: '上游未扣费且无重试入口', idempotencyKey: 'resolve-003' }, csrf: csrfToken });
    assert.equal(done.status, 200);
    const afterWallet = await wallet();
    assert.equal(afterWallet.frozen_fen, beforeWallet.frozen_fen - 2500, '当场退回 2500');
    assert.equal(afterWallet.available_fen, beforeWallet.available_fen + 2500);
    const ledger = await ledgerByKey(`admin:resolve:${redeliveryTakeId}:refund`);
    assert.equal(ledger.title, '待核对退回');
    assert.equal(Number(ledger.amount_fen), 2500);
    assert.equal(done.json.events[0].progress.message, '已核对：该片段生成失败，费用未扣除');
  });

  test('已取消作品的 unknown 判定：当场退回；charged 只记录不向用户结算', async () => {
    const beforeWallet = await wallet();
    const done = await client.call('admin', 'POST', `/admin/takes/${canceledTakeId}/resolve`,
      { body: { outcome: 'charged', note: '上游账单显示已扣费，平台承担', idempotencyKey: 'resolve-004' }, csrf: csrfToken });
    assert.equal(done.status, 200);
    const afterWallet = await wallet();
    assert.equal(afterWallet.frozen_fen, beforeWallet.frozen_fen - 1800, '已取消作品当场退回');
    assert.equal(afterWallet.available_fen - beforeWallet.available_fen, 1800, 'charged 不向用户结算（只退不减）');
    const takeRow = await take(canceledTakeId);
    assert.equal(takeRow.status, 'failed');
    assert.equal(takeRow.resolved_outcome, 'charged');
    assert.equal(done.json.events[0].progress.message, '已核对：该片段生成失败，费用未扣除', '用户可见文案统一');
  });

  test('非 unknown 409 TAKE_NOT_UNKNOWN；缺失 take 404；参数校验', async () => {
    const notUnknown = await client.call('admin', 'POST', `/admin/takes/${succeededTakeId}/resolve`,
      { body: { outcome: 'not_charged', note: 'x', idempotencyKey: 'resolve-005' }, csrf: csrfToken });
    assert.equal(notUnknown.status, 409);
    assert.equal(notUnknown.json.code, 'TAKE_NOT_UNKNOWN');
    const missing = await client.call('admin', 'POST', '/admin/takes/take_missing/resolve',
      { body: { outcome: 'not_charged', note: 'x', idempotencyKey: 'resolve-006' }, csrf: csrfToken });
    assert.equal(missing.status, 404);
    const badOutcome = await client.call('admin', 'POST', `/admin/takes/${succeededTakeId}/resolve`,
      { body: { outcome: 'whatever', note: 'x', idempotencyKey: 'resolve-007' }, csrf: csrfToken });
    assert.equal(badOutcome.status, 400);
    const noNote = await client.call('admin', 'POST', `/admin/takes/${succeededTakeId}/resolve`,
      { body: { outcome: 'not_charged', idempotencyKey: 'resolve-008' }, csrf: csrfToken });
    assert.equal(noNote.status, 400);
  });

  test('后台取消：无 unknown 退全部冻结；有 unknown 只退差额（保留金额=下单金额）；审计与守卫', async () => {
    // prjY：无 unknown → 退 2000
    const done = await client.call('admin', 'POST', `/admin/projects/${prjY}/cancel`,
      { body: { reason: '用户诉求，后台核实后取消' }, csrf: csrfToken });
    assert.equal(done.status, 200);
    assert.equal(done.json.status, 'canceled');
    assert.equal(done.json.money.refundedFen, 2000);
    // prjE：unknown（下单 900）保留、退差额 1100 —— 保留金额取 gen_tasks.request.amountFen
    const doneE = await client.call('admin', 'POST', `/admin/projects/${prjE}/cancel`,
      { body: { reason: '渠道不可用取消' }, csrf: csrfToken });
    assert.equal(doneE.status, 200);
    assert.equal(doneE.json.money.frozenFen, 900, 'unknown 保留冻结=下单金额 900');
    assert.equal(doneE.json.money.refundedFen, 1100);
    const afterWallet = await wallet();
    assert.equal(afterWallet.frozen_fen, 900, '钱包只剩 prjE 的 unknown 冻结');
    const audit = (await testDb.db.query(
      `SELECT detail FROM admin_audit_logs WHERE action = 'project.cancel' ORDER BY id DESC LIMIT 1`)).rows[0];
    assert.equal(audit.detail.reason, '渠道不可用取消');
    assert.equal(audit.detail.refundedFen, 1100);
    assert.equal(audit.detail.frozenFen, 900);
    // 重复取消：状态守卫 409
    const again = await client.call('admin', 'POST', `/admin/projects/${prjE}/cancel`,
      { body: { reason: '再取消' }, csrf: csrfToken });
    assert.equal(again.status, 409);
    assert.equal(again.json.code, 'PROJECT_STATE_INVALID');
    const noReason = await client.call('admin', 'POST', `/admin/projects/${prjE}/cancel`, { body: {}, csrf: csrfToken });
    assert.equal(noReason.status, 400);
    const missing = await client.call('admin', 'POST', '/admin/projects/prj_missing/cancel',
      { body: { reason: 'x' }, csrf: csrfToken });
    assert.equal(missing.status, 404);
    assert.equal(missing.json.code, 'PROJECT_NOT_FOUND');
    // 复审建议 a：userId 缺省且未显式 asAdmin → 显式报错（不再是静默管理员视角）
    await assert.rejects(
      cancelProject(testDb.db, { projectId: prjE }),
      (err) => err.code === 'INTERNAL');
  });
});
