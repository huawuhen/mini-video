// 管理端·作品与失败/待核对处理（M3-ADM-03，API.md §8.3）：作品列表过滤（含只看待核对）、
// 详情（片段/take/gen_task/渠道/上游任务 ID/金额聚合/事件时间线）、待核对两种判定
// （not_charged 退回 / charged 结算，金额=段时长×锁定单价，只判定一次，幂等重放）、
// 后台取消（unknown 保持冻结）。全部零真实费用。
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import express from 'express';
import { createTestDb } from './helpers/db.js';
import { createLogger } from '../src/logger.js';
import { hashAdminPassword } from '../src/channels/crypto.js';
import { createAdminAuth } from '../src/channels/admin-auth.js';
import { adminProjectsRoutes } from '../src/api/admin-projects.js';
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
  let prjX; // failed，含 1 个 unknown take（30s）+ 1 个 succeeded take（30s，已结算）
  let prjY; // rendering，冻结 2000 全部可退（delivered 不可取消——与用户侧同状态守卫）
  let unknownTakeId;
  let unknownTake2Id;
  let succeededTakeId;
  let unit; // 锁定档位的视频单价（分/秒），夹具金额按它推导

  const wallet = async () => (await testDb.db.query(
    `SELECT available_fen, frozen_fen FROM wallets WHERE user_id = $1`, [u1])).rows[0];
  const project = async (id) => (await testDb.db.query(`SELECT * FROM projects WHERE id = $1`, [id])).rows[0];
  const take = async (id) => (await testDb.db.query(`SELECT * FROM segment_takes WHERE id = $1`, [id])).rows[0];

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
    // 渠道记录不在迁移里播种（009）——测试自己插一条（凭证 AES-GCM 加密，与生产同构）
    const { encryptCredential } = await import('../src/channels/crypto.js');
    const channelId = newId('pch');
    await db.query(
      `INSERT INTO provider_channels (id, kind, name, driver, base_url, credential_enc)
       VALUES ($1, 'video', 'test-channel', 'local-mock', 'https://channel.test', $2)`,
      [channelId, encryptCredential('k'.repeat(48), 'channel-secret-0001')]);
    testDb.channelId = channelId;
    const { rows: tm } = await db.query(`SELECT id FROM tier_mappings ORDER BY id LIMIT 1`);
    const tierMappingId = tm[0].id;
    const { videoUnitFen } = await import('../src/projects/money.js');
    unit = Number(await videoUnitFen(db, tierMappingId)); // 夹具金额全部由单价推导
    const { rows: styles } = await db.query(`SELECT id FROM styles ORDER BY id LIMIT 1`);
    const { rows: tiers } = await db.query(`SELECT id FROM quality_tiers ORDER BY id LIMIT 1`);

    const mkProject = async ({ id, status, daysAgo }) => {
      await db.query(
        `INSERT INTO projects (id, user_id, story_text, source_type, style_id, quality_tier_id, tier_mapping_id, status, title, created_at, updated_at)
         VALUES ($1, $2, '测试故事', 'text', $3, $4, $5, $6, $7, now() - make_interval(days => $8), now())`,
        [id, u1, styles[0].id, tiers[0].id, tierMappingId, status, `作品${id.slice(-4)}`, daysAgo]);
    };
    const mkSegment = async ({ id, projectId, idx, seconds }) => {
      await db.query(
        `INSERT INTO segments (id, project_id, idx, duration_seconds, plot) VALUES ($1, $2, $3, $4, '剧情')`,
        [id, projectId, idx, seconds]);
    };
    // gen_task 绑定上面插入的测试渠道
    const mkGenTask = async ({ id, status, upstreamId, ch }) => {
      await db.query(
        `INSERT INTO gen_tasks (id, user_id, kind, provider, upstream_id, status, request, idempotency_key, channel_id)
         VALUES ($1, $2, 'video', 'test-provider', $3, $4, '{}', $5, $6)`,
        [id, u1, upstreamId, status, `gt-${id}`, ch]);
    };
    const mkTake = async ({ id, segmentId, status, genTaskId }) => {
      await db.query(
        `INSERT INTO segment_takes (id, segment_id, status, gen_task_id) VALUES ($1, $2, $3, $4)`,
        [id, segmentId, status, genTaskId]);
    };

    // prjX（failed）：seg1 30s unknown（gen_task unknown，channel 绑定）；seg2 30s succeeded（已结算）
    prjX = newId('prj');
    await mkProject({ id: prjX, status: 'failed', daysAgo: 3 });
    const seg1 = newId('seg');
    const seg2 = newId('seg');
    await mkSegment({ id: seg1, projectId: prjX, idx: 0, seconds: 30 });
    await mkSegment({ id: seg2, projectId: prjX, idx: 1, seconds: 30 });
    const gtUnknown = newId('gt');
    const gtOk = newId('gt');
    await mkGenTask({ id: gtUnknown, status: 'unknown', upstreamId: 'up_unknown_001', ch: channelId });
    await mkGenTask({ id: gtOk, status: 'succeeded', upstreamId: 'up_ok_001', ch: channelId });
    unknownTakeId = newId('take');
    succeededTakeId = newId('take');
    await mkTake({ id: unknownTakeId, segmentId: seg1, status: 'unknown', genTaskId: gtUnknown });
    await mkTake({ id: succeededTakeId, segmentId: seg2, status: 'succeeded', genTaskId: gtOk });
    // 账本：预占 60×unit（两段 30s），seg2 已结算 30×unit → 冻结 30×unit（unknown 段）+ 20×unit（seg3）
    await db.query(
      `INSERT INTO ledger (id, user_id, kind, amount_fen, frozen_delta_fen, title, ref_type, ref_id, idempotency_key)
       VALUES ($1, $2, 'reserve', $4, $5, '视频生成预占', 'project', $3, 'fx-reserve-x')`,
      [newId('led'), u1, prjX, -60 * unit, 60 * unit]);
    await db.query(
      `INSERT INTO ledger (id, user_id, kind, amount_fen, frozen_delta_fen, title, ref_type, ref_id, idempotency_key)
       VALUES ($1, $2, 'settle', 0, $4, '片段生成结算', 'project', $3, 'fx-settle-x')`,
      [newId('led'), u1, prjX, -30 * unit]);

    // prjX 再加一个 unknown take（20s，charged 判定用）：预占合计 8000 → 冻结 5000 = 30s+20s
    const seg3 = newId('seg');
    await mkSegment({ id: seg3, projectId: prjX, idx: 2, seconds: 20 });
    const gtUnknown2 = newId('gt');
    await mkGenTask({ id: gtUnknown2, status: 'unknown', upstreamId: 'up_unknown_002', ch: channelId });
    unknownTake2Id = newId('take');
    await mkTake({ id: unknownTake2Id, segmentId: seg3, status: 'unknown', genTaskId: gtUnknown2 });
    await db.query(
      `INSERT INTO ledger (id, user_id, kind, amount_fen, frozen_delta_fen, title, ref_type, ref_id, idempotency_key)
       VALUES ($1, $2, 'reserve', $4, $5, '视频生成预占', 'project', $3, 'fx-reserve-x2')`,
      [newId('led'), u1, prjX, -20 * unit, 20 * unit]);
    await db.query(`UPDATE wallets SET frozen_fen = $2 WHERE user_id = $1`, [u1, 50 * unit + 2000]);

    // prjY（delivered，1 天前）：冻结 2000 全部可退（无 unknown）
    prjY = newId('prj');
    await mkProject({ id: prjY, status: 'rendering', daysAgo: 1 });
    await db.query(
      `INSERT INTO ledger (id, user_id, kind, amount_fen, frozen_delta_fen, title, ref_type, ref_id, idempotency_key)
       VALUES ($1, $2, 'reserve', -2000, 2000, '视频生成预占', 'project', $3, 'fx-reserve-y')`,
      [newId('led'), u1, prjY]);
    await db.query(`UPDATE wallets SET frozen_fen = $2 WHERE user_id = $1`, [u1, 50 * unit + 2000]);

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

  test('列表：创建时间倒序；status/userId 过滤；hasUnknown=true 只列有待核对作品并带计数', async () => {
    const all = await client.call('admin', 'GET', '/admin/projects');
    assert.equal(all.status, 200);
    assert.deepEqual(all.json.items.map((item) => item.id), [prjY, prjX], '创建时间倒序');
    assert.equal(all.json.items[1].unknownTakes, 2);
    assert.equal(all.json.items[1].phoneMasked, '159****0001');
    const byStatus = await client.call('admin', 'GET', '/admin/projects?status=failed');
    assert.deepEqual(byStatus.json.items.map((item) => item.id), [prjX]);
    const byUser = await client.call('admin', 'GET', `/admin/projects?userId=${u1}`);
    assert.equal(byUser.json.items.length, 2);
    const unknownOnly = await client.call('admin', 'GET', '/admin/projects?hasUnknown=true');
    assert.deepEqual(unknownOnly.json.items.map((item) => item.id), [prjX]);
    assert.equal(unknownOnly.json.items[0].unknownTakes, 2);
    // 游标翻页无重复
    const page1 = await client.call('admin', 'GET', '/admin/projects?limit=1');
    assert.ok(page1.json.nextCursor);
    const page2 = await client.call('admin', 'GET', `/admin/projects?limit=1&cursor=${encodeURIComponent(page1.json.nextCursor)}`);
    assert.equal(page2.json.items.length, 1);
    assert.notEqual(page2.json.items[0].id, page1.json.items[0].id);
    const badStatus = await client.call('admin', 'GET', '/admin/projects?status=nope');
    assert.equal(badStatus.status, 400);
  });

  test('详情：金额聚合、片段/take 树（gen_task 状态、渠道、上游 ID、待核对冻结额）；不存在 404', async () => {
    const { status, json } = await client.call('admin', 'GET', `/admin/projects/${prjX}`);
    assert.equal(status, 200);
    assert.deepEqual(json.money, { reservedFen: 80 * unit, settledFen: 30 * unit, refundedFen: 0, frozenFen: 50 * unit });
    assert.equal(json.segments.length, 3);
    const seg1 = json.segments.find((seg) => seg.takes.some((tk) => tk.id === unknownTakeId));
    const unknown = seg1.takes.find((tk) => tk.id === unknownTakeId);
    assert.equal(unknown.status, 'unknown');
    assert.equal(unknown.genTaskStatus, 'unknown');
    assert.ok(unknown.channel, '渠道名来自 gen_tasks.channel_id');
    assert.equal(unknown.upstreamTaskId, 'up_unknown_001');
    assert.equal(unknown.frozenFen, 30 * unit, '30s × 锁定档位单价');
    const okTake = json.segments.flatMap((seg) => seg.takes).find((tk) => tk.id === succeededTakeId);
    assert.equal(okTake.frozenFen, 0, '非 unknown 不计待核对冻结');
    const missing = await client.call('admin', 'GET', '/admin/projects/prj_missing');
    assert.equal(missing.status, 404);
    assert.equal(missing.json.code, 'PROJECT_NOT_FOUND');
  });

  test('判定 not_charged：退回冻结、take 标 failed、时间线写核对结论、审计、同键重放、换键 409', async () => {
    const beforeWallet = await wallet();
    assert.deepEqual([beforeWallet.available_fen, beforeWallet.frozen_fen], [10000, 50 * unit + 2000]);
    const done = await client.call('admin', 'POST', `/admin/takes/${unknownTakeId}/resolve`,
      { body: { outcome: 'not_charged', note: '渠道后台确认未扣费', idempotencyKey: 'resolve-001' }, csrf: csrfToken });
    assert.equal(done.status, 200);
    assert.equal(done.json.segments.flatMap((s) => s.takes).find((tk) => tk.id === unknownTakeId).status, 'failed');
    const afterWallet = await wallet();
    assert.equal(afterWallet.available_fen, 10000 + 30 * unit, '退回 unknown 段冻结');
    assert.equal(afterWallet.frozen_fen, 20 * unit + 2000);
    const ledger = (await testDb.db.query(
      `SELECT kind, amount_fen, frozen_delta_fen, title, idempotency_key FROM ledger WHERE idempotency_key = $1`,
      [`admin:resolve:${unknownTakeId}:refund`])).rows[0];
    assert.equal(ledger.kind, 'refund');
    assert.equal(Number(ledger.amount_fen), 30 * unit);
    assert.equal(Number(ledger.frozen_delta_fen), -30 * unit);
    assert.equal(ledger.title, '待核对退回');
    const takeRow = await take(unknownTakeId);
    assert.equal(takeRow.resolved_outcome, 'not_charged');
    assert.equal(takeRow.resolved_note, '渠道后台确认未扣费');
    assert.equal(takeRow.resolved_key, 'admin:resolve:resolve-001');
    assert.equal(takeRow.resolved_by, adminId);
    const detail = done.json;
    const event = detail.events[0];
    assert.equal(event.progress.message, '已核对：上游未扣费，费用已退回');
    const audit = await testDb.db.query(`SELECT action, detail FROM admin_audit_logs WHERE action = 'take.resolve'`);
    assert.equal(audit.rowCount, 1);
    assert.equal(audit.rows[0].detail.outcome, 'not_charged');

    // 同键重放：返回同一详情，不再退钱
    const replay = await client.call('admin', 'POST', `/admin/takes/${unknownTakeId}/resolve`,
      { body: { outcome: 'not_charged', note: '渠道后台确认未扣费', idempotencyKey: 'resolve-001' }, csrf: csrfToken });
    assert.equal(replay.status, 200);
    const walletAfterReplay = await wallet();
    assert.equal(walletAfterReplay.available_fen, 10000 + 30 * unit, '重放不重复退回');
    // 换键重判已判定 take：409
    const again = await client.call('admin', 'POST', `/admin/takes/${unknownTakeId}/resolve`,
      { body: { outcome: 'charged', note: '换结论', idempotencyKey: 'resolve-002' }, csrf: csrfToken });
    assert.equal(again.status, 409);
    assert.equal(again.json.code, 'TAKE_ALREADY_RESOLVED');
  });

  test('判定 charged：按原价结算、时间线「已核对：上游已计费」', async () => {
    const beforeWallet = await wallet();
    const done = await client.call('admin', 'POST', `/admin/takes/${unknownTake2Id}/resolve`,
      { body: { outcome: 'charged', note: '上游账单显示已扣费', idempotencyKey: 'resolve-003' }, csrf: csrfToken });
    assert.equal(done.status, 200);
    const afterWallet = await wallet();
    assert.equal(afterWallet.available_fen, beforeWallet.available_fen, '结算不动可用余额');
    assert.equal(afterWallet.frozen_fen, beforeWallet.frozen_fen - 20 * unit);
    const ledger = (await testDb.db.query(
      `SELECT kind, amount_fen, frozen_delta_fen, title FROM ledger WHERE idempotency_key = $1`,
      [`admin:resolve:${unknownTake2Id}:settle`])).rows[0];
    assert.equal(ledger.kind, 'settle');
    assert.equal(Number(ledger.frozen_delta_fen), -20 * unit);
    assert.equal(ledger.title, '待核对结算');
    assert.equal(done.json.events[0].progress.message, '已核对：上游已计费');
    const tk = await take(unknownTake2Id);
    assert.equal(tk.status, 'failed');
    assert.equal(tk.resolved_outcome, 'charged');
    const detail = done.json;
    assert.equal(detail.unknownTakes, 0);
    assert.equal(detail.money.frozenFen, 0);
  });

  test('非 unknown 409 TAKE_NOT_UNKNOWN；缺失 take 404；校验 outcome/note', async () => {
    const notUnknown = await client.call('admin', 'POST', `/admin/takes/${succeededTakeId}/resolve`,
      { body: { outcome: 'not_charged', note: 'x', idempotencyKey: 'resolve-004' }, csrf: csrfToken });
    assert.equal(notUnknown.status, 409);
    assert.equal(notUnknown.json.code, 'TAKE_NOT_UNKNOWN');
    const missing = await client.call('admin', 'POST', '/admin/takes/take_missing/resolve',
      { body: { outcome: 'not_charged', note: 'x', idempotencyKey: 'resolve-005' }, csrf: csrfToken });
    assert.equal(missing.status, 404);
    const badOutcome = await client.call('admin', 'POST', `/admin/takes/${succeededTakeId}/resolve`,
      { body: { outcome: 'whatever', note: 'x', idempotencyKey: 'resolve-006' }, csrf: csrfToken });
    assert.equal(badOutcome.status, 400);
    const noNote = await client.call('admin', 'POST', `/admin/takes/${succeededTakeId}/resolve`,
      { body: { outcome: 'not_charged', idempotencyKey: 'resolve-007' }, csrf: csrfToken });
    assert.equal(noNote.status, 400);
  });

  test('后台取消：退还非 unknown 冻结、状态 canceled、审计带 reason；unknown 已清零时无额外退款', async () => {
    const beforeWallet = await wallet();
    assert.equal(beforeWallet.frozen_fen, 2000, '判定后只剩 prjY 的冻结');
    const done = await client.call('admin', 'POST', `/admin/projects/${prjY}/cancel`,
      { body: { reason: '用户诉求，后台核实后取消' }, csrf: csrfToken });
    assert.equal(done.status, 200);
    assert.equal(done.json.status, 'canceled');
    const afterWallet = await wallet();
    assert.equal(afterWallet.available_fen, beforeWallet.available_fen + 2000, '退还 prjY 冻结 2000');
    const ledger = (await testDb.db.query(
      `SELECT amount_fen FROM ledger WHERE ref_type = 'project' AND ref_id = $1 AND kind = 'refund'
        AND idempotency_key = $2`, [prjY, `project:${prjY}:refund:cancel`])).rows[0];
    assert.equal(Number(ledger.amount_fen), 2000);
    const audit = (await testDb.db.query(
      `SELECT detail FROM admin_audit_logs WHERE action = 'project.cancel' ORDER BY id DESC LIMIT 1`)).rows[0];
    assert.equal(audit.detail.reason, '用户诉求，后台核实后取消');
    assert.equal(audit.detail.refundedFen, 2000);
    assert.equal(audit.detail.frozenFen, 0);
    // 重复取消：状态守卫 409
    const again = await client.call('admin', 'POST', `/admin/projects/${prjY}/cancel`,
      { body: { reason: '再取消' }, csrf: csrfToken });
    assert.equal(again.status, 409);
    assert.equal(again.json.code, 'PROJECT_STATE_INVALID');
    // 缺 reason 400
    const noReason = await client.call('admin', 'POST', `/admin/projects/${prjY}/cancel`, { body: {}, csrf: csrfToken });
    assert.equal(noReason.status, 400);
    // 取消不存在的作品 → PROJECT_NOT_FOUND
    const missing = await client.call('admin', 'POST', '/admin/projects/prj_missing/cancel',
      { body: { reason: 'x' }, csrf: csrfToken });
    assert.equal(missing.status, 404);
    assert.equal(missing.json.code, 'PROJECT_NOT_FOUND');
  });
});
