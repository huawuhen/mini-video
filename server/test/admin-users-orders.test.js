// 管理端·用户与余额 / 订单与人工退款（M3-ADM-02，API.md §8.1~8.2）：
// 独立会话 + CSRF（writeGuard）、手机号掩码与精确搜索、余额调整走账本（幂等/不可减成负数）、
// 停用删会话与登录拦截（ACCOUNT_DISABLED）、注销清余额删媒体匿名保留、订单查询、
// 手动对账（复用定时对账口径）、记录式退款（校验/幂等/审计）。全部零真实费用。
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import express from 'express';
import { createTestDb } from './helpers/db.js';
import { createLogger } from '../src/logger.js';
import { createMemoryStorage } from '../src/engine/storage/memory.js';
import { hashAdminPassword } from '../src/channels/crypto.js';
import { adminUsersOrdersRoutes } from '../src/api/admin-users-orders.js';
import { adminAuthRoutes } from '../src/api/admin-auth.js';
import { errorHandler, asyncHandler } from '../src/http/middleware.js';
import { appError } from '../src/http/errors.js';
import { newId } from '../src/db/ids.js';

const silentLogger = createLogger({ level: 'silent' });

/** 极简 cookie 会话测试客户端（同 admin-api.test.js）。 */
function clientFor(base) {
  const jars = new Map(); // label → cookie string
  async function call(label, method, path, { body, csrf, origin } = {}) {
    const headers = {};
    const cookie = jars.get(label);
    if (cookie) headers.cookie = cookie;
    if (csrf) headers['x-csrf-token'] = csrf;
    if (origin) headers.origin = origin;
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

/** 假微信查单客户端：按订单号返回预设 trade_state（amount 自动带订单金额的调用方核对口径）。 */
function fakePayClient(stateByOrder) {
  return {
    async query(outTradeNo) {
      const hit = stateByOrder.get(outTradeNo) ?? { trade_state: 'NOTPAY' };
      return { trade_state: hit.trade_state, amount: { total: hit.total ?? 0 },
        transaction_id: hit.transaction_id ?? null, payer: { openid: hit.openid ?? null } };
    },
    async close() {},
  };
}

describe('管理端·用户与订单（M3-ADM-02）', () => {
  let testDb;
  let server;
  let noPayServer;
  let base;
  let noPayBase;
  let client;
  let csrfToken;
  let storage;
  let adminId;

  // 夹具用户
  let u1; let u2; let u3; let u4; // u1 活跃有钱；u2 活跃无钱包；u3 停用；u4 留给注销
  let paidOrder; let createdOrder; let expiredOrder;

  const insertUser = async ({ phone, status = 'active', createdDaysAgo = 1 }) => {
    const id = newId('usr');
    await testDb.db.query(
      `INSERT INTO users (id, phone, nickname, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, now() - make_interval(days => $5), now())`,
      [id, phone, `用户${phone.slice(-4)}`, status, createdDaysAgo]);
    return id;
  };

  before(async () => {
    testDb = await createTestDb();
    const db = testDb.db;
    const mem = createMemoryStorage();
    const removedKeys = [];
    // 记录 remove 调用（memory signedUrl 不校验存在性，删没删只能从 remove 调用断言）
    storage = {
      async put(...args) { return mem.put(...args); },
      async signedUrl(...args) { return mem.signedUrl(...args); },
      async remove(keys) { removedKeys.push(...keys); return mem.remove(keys); },
    };
    testDb.removedKeys = removedKeys;
    adminId = newId('adm');
    await db.query(
      `INSERT INTO admin_users (id, username, password_hash, display_name) VALUES ($1, 'admin', $2, '测试管理员')`,
      [adminId, hashAdminPassword('admin-password-123')]);

    u1 = await insertUser({ phone: '15811110001', createdDaysAgo: 4 });
    u2 = await insertUser({ phone: '15811110002', createdDaysAgo: 3 });
    u3 = await insertUser({ phone: '15811110003', status: 'disabled', createdDaysAgo: 2 });
    u4 = await insertUser({ phone: '15811110004', createdDaysAgo: 1 });

    // u1：钱包 + 各类流水（充值 5000 + 兑换 2000 + 预占/结算 3000 → 余额 4000）
    await db.query(`INSERT INTO wallets (user_id, available_fen, frozen_fen) VALUES ($1, 4000, 0)`, [u1]);
    const ledgerRows = [
      [newId('led'), u1, 'recharge', 5000, 0, '余额充值', 'payment_order', 'po_seed_1', 'seed-led-1'],
      [newId('led'), u1, 'redeem', 2000, 0, '兑换码充值', 'redeem_code', 'hash', 'seed-led-2'],
      [newId('led'), u1, 'reserve', -3000, 3000, '作品预占', 'project', 'prj_seed_1', 'seed-led-3'],
      [newId('led'), u1, 'settle', 0, -3000, '从冻结中扣除', 'project', 'prj_seed_1', 'seed-led-4'],
    ];
    for (const [id, userId, kind, amount, frozen, title, refType, refId, key] of ledgerRows) {
      await db.query(
        `INSERT INTO ledger (id, user_id, kind, amount_fen, frozen_delta_fen, title, ref_type, ref_id, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [id, userId, kind, amount, frozen, title, refType, refId, key]);
    }
    await db.query(
      `INSERT INTO user_consents (id, user_id, kind, version) VALUES ($1, $2, 'terms', 'terms-v1')`, [newId('cns'), u1]);
    await db.query(
      `INSERT INTO user_wechat (user_id, appid, openid) VALUES ($1, 'wx-app', 'openid-u1')`, [u1]);
    // u1 的一部已交付作品（注销用不到：无在途；统计 delivered=1）
    await db.query(
      `INSERT INTO projects (id, user_id, story_text, source_type, style_id, quality_tier_id, tier_mapping_id, status, title)
       SELECT $1, $2, '故事文本', 'text', s.id, q.id, m.id, 'delivered', '已交付作品'
         FROM styles s, quality_tiers q, tier_mappings m
        WHERE s.id = (SELECT id FROM styles LIMIT 1) AND q.id = (SELECT id FROM quality_tiers LIMIT 1)
          AND m.id = (SELECT id FROM tier_mappings LIMIT 1)`, [newId('prj'), u1]);

    // 支付订单：paid / created / expired 各一笔（都是 u1）
    const mkOrder = async ({ id, status, amount, daysAgo }) => {
      await db.query(
        `INSERT INTO payment_orders (id, user_id, out_trade_no, amount_fen, scene, status, expires_at,
            paid_at, transaction_id, credited_ledger_id, notify_count, last_notify, last_notify_at, created_at, updated_at)
         VALUES ($1, $2, $1, $3, 'native', $4, now() + make_interval(mins => 30),
           CASE WHEN $4 = 'paid' THEN now() END,
           CASE WHEN $4 = 'paid' THEN $5::text END,
           CASE WHEN $4 = 'paid' THEN $6::text END,
           CASE WHEN $4 = 'paid' THEN 2 ELSE 0 END,
           CASE WHEN $4 = 'paid' THEN '{}'::jsonb END,
           CASE WHEN $4 = 'paid' THEN now() END,
           now() - make_interval(days => $7::int), now())`,
        [id, u1, amount, status, 'tx_4200001', ledgerRows[0][0], daysAgo]);
    };
    paidOrder = 'po_paid_test_0000001';
    createdOrder = 'po_crea_test_0000001';
    expiredOrder = 'po_expi_test_0000001';
    await mkOrder({ id: paidOrder, status: 'paid', amount: 5000, daysAgo: 2 });
    await mkOrder({ id: createdOrder, status: 'created', amount: 10000, daysAgo: 1 });
    await mkOrder({ id: expiredOrder, status: 'expired', amount: 50000, daysAgo: 3 });

    const config = { cookieSecure: false, sessionTtlDays: 1, allowedOrigins: ['http://localhost:5173'],
      admin: { loginMaxFailures: 5, loginFailWindowSeconds: 600, loginBanSeconds: 7200 } };
    const payClient = fakePayClient(new Map([
      [createdOrder, { trade_state: 'SUCCESS', total: 10000, transaction_id: 'tx_reconcile_1', openid: 'openid-u1' }],
    ]));
    const mount = (extra) => {
      const app = express();
      app.use(express.json({ limit: '100kb' }));
      // 登录入口在生产由 api/admin.js（渠道路由）提供；测试这里按同一实现补一个，
      // 让被测模块专注于 §8.1~8.2（登录本身已在 admin-api.test.js 覆盖）
      app.use('/api/v1', adminAuthRoutes({ db, config }));
      app.use('/api/v1', adminUsersOrdersRoutes({ db, config, logger: silentLogger, storage, ...extra }));
      app.use(errorHandler(silentLogger));
      return app;
    };
    const app = mount({ payments: { payClient } });
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}/api/v1`;
    client = clientFor(base);

    // 第二个实例：未配置支付（payClient=null）→ 手动对账 503
    const noPayApp = mount({ payments: {} });
    noPayServer = noPayApp.listen(0, '127.0.0.1');
    await new Promise((resolve) => noPayServer.once('listening', resolve));
    noPayBase = `http://127.0.0.1:${noPayServer.address().port}/api/v1`;

    const login = await client.call('admin', 'POST', '/admin/auth/login',
      { body: { username: 'admin', password: 'admin-password-123' } });
    assert.equal(login.status, 200);
    csrfToken = login.json.csrfToken;
  });

  after(async () => {
    server.closeAllConnections(); await new Promise((r) => server.close(r));
    noPayServer.closeAllConnections(); await new Promise((r) => noPayServer.close(r));
    await testDb.drop();
  });

  test('未登录 → 401；写操作缺 CSRF 头 → 403 CSRF_INVALID', async () => {
    const anon = clientFor(base);
    const { status, json } = await anon.call('anon', 'GET', '/admin/users');
    assert.equal(status, 401);
    assert.equal(json.code, 'ADMIN_AUTH_REQUIRED');
    const write = await client.call('admin', 'POST', `/admin/users/${u1}/adjust`,
      { body: { amountFen: 100, reason: 'x', idempotencyKey: 'no-csrf' } });
    assert.equal(write.status, 403);
    assert.equal(write.json.code, 'CSRF_INVALID');
    const badOrigin = await client.call('admin', 'POST', `/admin/users/${u1}/adjust`,
      { body: { amountFen: 100, reason: 'x', idempotencyKey: 'no-csrf' }, csrf: csrfToken, origin: 'https://evil.example' });
    assert.equal(badOrigin.status, 403);
    assert.equal(badOrigin.json.code, 'CSRF_INVALID');
    // GET 无需 CSRF 头
    const read = await client.call('admin', 'GET', '/admin/users');
    assert.equal(read.status, 200);
  });

  test('用户列表：注册时间倒序、余额来自钱包、手机号掩码；分页游标可用', async () => {
    const { status, json } = await client.call('admin', 'GET', '/admin/users');
    assert.equal(status, 200);
    assert.equal(json.items.length, 4);
    assert.equal(json.items[0].id, u4, '注册时间倒序（u4 最新）');
    const first = json.items.find((item) => item.id === u1);
    assert.equal(first.phoneMasked, '158****0001');
    assert.equal(first.balanceFen, 4000);
    assert.equal(first.status, 'active');
    assert.equal(first.lastLoginAt, null);
    const page1 = await client.call('admin', 'GET', '/admin/users?limit=2');
    assert.equal(page1.json.items.length, 2);
    assert.ok(page1.json.nextCursor);
    const page2 = await client.call('admin', 'GET', `/admin/users?limit=2&cursor=${encodeURIComponent(page1.json.nextCursor)}`);
    assert.equal(page2.json.items.length, 2);
    assert.ok(!page2.json.nextCursor);
    assert.ok(!page1.json.items.some((a) => page2.json.items.some((b) => b.id === a.id)), '游标翻页无重复');
  });

  test('用户搜索：完整手机号精确匹配（部分/掩码搜不到）、userId 精确、status 过滤；搜索记审计且不落明文手机号', async () => {
    const hit = await client.call('admin', 'GET', '/admin/users?phone=15811110001');
    assert.equal(hit.json.items.length, 1);
    assert.equal(hit.json.items[0].id, u1);
    const partial = await client.call('admin', 'GET', '/admin/users?phone=1581111');
    assert.equal(partial.status, 400, '只支持完整号码精确搜索（部分号码直接拒绝）');
    const masked = await client.call('admin', 'GET', '/admin/users?phone=158****0001');
    assert.equal(masked.status, 400, '掩码串不是合法手机号');
    const byId = await client.call('admin', 'GET', `/admin/users?userId=${u3}`);
    assert.equal(byId.json.items.length, 1);
    assert.equal(byId.json.items[0].status, 'disabled');
    const disabledOnly = await client.call('admin', 'GET', '/admin/users?status=disabled');
    assert.deepEqual(disabledOnly.json.items.map((item) => item.id), [u3]);
    const { rows } = await testDb.db.query(
      `SELECT detail FROM admin_audit_logs WHERE action = 'user.search' ORDER BY id`);
    assert.ok(rows.some((row) => JSON.stringify(row.detail).includes('158****0001')), '审计记掩码');
    assert.ok(!JSON.stringify(rows).includes('15811110001'), '审计不落明文手机号');
  });

  test('用户详情：统计、同意记录、微信绑定；不存在 404 USER_NOT_FOUND', async () => {
    const { status, json } = await client.call('admin', 'GET', `/admin/users/${u1}`);
    assert.equal(status, 200);
    assert.equal(json.stats.projects, 1);
    assert.equal(json.stats.delivered, 1);
    assert.equal(json.stats.rechargedFen, 7000, '充值 5000 + 兑换 2000');
    assert.equal(json.stats.spentFen, 3000, '结算行按 -frozen_delta_fen 求和');
    assert.deepEqual(json.consents, { terms: 'terms-v1', photo: null });
    assert.equal(json.wechatBound, true);
    const missing = await client.call('admin', 'GET', '/admin/users/usr_nonexistent');
    assert.equal(missing.status, 404);
    assert.equal(missing.json.code, 'USER_NOT_FOUND');
  });

  test('余额调整：正负调整、不能减成负数、幂等重放/冲突、原因必填、审计与流水带 reason/adminUsername', async () => {
    const key = 'adm-adjust-0001';
    const ok = await client.call('admin', 'POST', `/admin/users/${u1}/adjust`,
      { body: { amountFen: 500, reason: '补偿活动奖励', idempotencyKey: key }, csrf: csrfToken });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.wallet.availableFen, 4500);
    assert.equal(ok.json.entry.kind, 'adjust');
    assert.equal(ok.json.entry.amountFen, 500);
    const replay = await client.call('admin', 'POST', `/admin/users/${u1}/adjust`,
      { body: { amountFen: 500, reason: '补偿活动奖励', idempotencyKey: key }, csrf: csrfToken });
    assert.equal(replay.status, 200);
    assert.equal(replay.json.entry.id, ok.json.entry.id, '同键重放返回首次流水');
    assert.equal(replay.json.wallet.availableFen, 4500, '重放不重复加钱');
    const conflict = await client.call('admin', 'POST', `/admin/users/${u1}/adjust`,
      { body: { amountFen: 600, reason: '补偿活动奖励', idempotencyKey: key }, csrf: csrfToken });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.json.code, 'IDEMPOTENCY_CONFLICT');

    const tooMuch = await client.call('admin', 'POST', `/admin/users/${u1}/adjust`,
      { body: { amountFen: -999999, reason: '误操作冲正测试', idempotencyKey: 'adm-adjust-0002' }, csrf: csrfToken });
    assert.equal(tooMuch.status, 400);
    assert.equal(tooMuch.json.code, 'ADJUST_EXCEEDS_BALANCE');
    const minusAll = await client.call('admin', 'POST', `/admin/users/${u1}/adjust`,
      { body: { amountFen: -4500, reason: '余额清零核查', idempotencyKey: 'adm-adjust-0003' }, csrf: csrfToken });
    assert.equal(minusAll.status, 200);
    assert.equal(minusAll.json.wallet.availableFen, 0, '恰好减到 0 允许');
    const zero = await client.call('admin', 'POST', `/admin/users/${u1}/adjust`,
      { body: { amountFen: 0, reason: '零', idempotencyKey: 'adm-adjust-0004' }, csrf: csrfToken });
    assert.equal(zero.status, 400);
    const noReason = await client.call('admin', 'POST', `/admin/users/${u1}/adjust`,
      { body: { amountFen: 100, idempotencyKey: 'adm-adjust-0005' }, csrf: csrfToken });
    assert.equal(noReason.status, 400);
    const notFound = await client.call('admin', 'POST', '/admin/users/usr_nonexistent/adjust',
      { body: { amountFen: 100, reason: 'x', idempotencyKey: 'adm-adjust-0006' }, csrf: csrfToken });
    assert.equal(notFound.status, 404);

    // 后台流水带 reason/adminUsername；审计留痕；幂等键带 admin: 前缀（与内部键隔离命名空间）
    const ledger = await client.call('admin', 'GET', `/admin/users/${u1}/ledger`);
    const adjustRow = ledger.json.items.find((item) => item.id === ok.json.entry.id);
    assert.equal(adjustRow.reason, '补偿活动奖励');
    assert.equal(adjustRow.adminUsername, 'admin');
    const keyRow = (await testDb.db.query(
      `SELECT idempotency_key FROM ledger WHERE id = $1`, [ok.json.entry.id])).rows[0];
    assert.equal(keyRow.idempotency_key, 'admin:adjust:adm-adjust-0001');
    const audit = await testDb.db.query(`SELECT action FROM admin_audit_logs WHERE action = 'wallet.adjust'`);
    assert.ok(audit.rowCount >= 3);
    // 加回 4500，后续用例继续用
    const top = await client.call('admin', 'POST', `/admin/users/${u1}/adjust`,
      { body: { amountFen: 4500, reason: '恢复测试余额', idempotencyKey: 'adm-adjust-0007' }, csrf: csrfToken });
    assert.equal(top.status, 200);
    assert.equal(top.json.wallet.availableFen, 4500);
  });

  test('停用：立即删会话；启用可恢复；注销不可启用', async () => {
    // 给 u2 建一个会话，停用后必须被删
    const { createHash } = await import('node:crypto');
    const realHash = createHash('sha256').update('plain-token-1').digest('hex');
    await testDb.db.query(
      `INSERT INTO sessions (token_hash, user_id, csrf_token, expires_at)
       VALUES ($1, $2, 'csrf', now() + interval '1 day')`, [realHash, u2]);
    const disabled = await client.call('admin', 'POST', `/admin/users/${u2}/disable`,
      { body: { reason: '风控暂停' }, csrf: csrfToken });
    assert.equal(disabled.status, 200);
    assert.equal(disabled.json.status, 'disabled');
    const sessions = await testDb.db.query(`SELECT count(*)::int AS n FROM sessions WHERE user_id = $1`, [u2]);
    assert.equal(sessions.rows[0].n, 0, '停用立即删除全部会话');
    const audit = await testDb.db.query(
      `SELECT detail FROM admin_audit_logs WHERE action = 'user.disable' ORDER BY id DESC LIMIT 1`);
    assert.equal(audit.rows[0].detail.reason, '风控暂停');

    const enabled = await client.call('admin', 'POST', `/admin/users/${u2}/enable`,
      { body: { reason: '核实后恢复' }, csrf: csrfToken });
    assert.equal(enabled.json.status, 'active');

    // 已停用的 u3 启用恢复；再手工置为注销 → 启用/停用都被拒
    const enable3 = await client.call('admin', 'POST', `/admin/users/${u3}/enable`,
      { body: { reason: '恢复正常' }, csrf: csrfToken });
    assert.equal(enable3.json.status, 'active');
    await testDb.db.query(`UPDATE users SET status = 'deactivated' WHERE id = $1`, [u3]);
    const enableDeactivated = await client.call('admin', 'POST', `/admin/users/${u3}/enable`,
      { body: { reason: '尝试恢复注销' }, csrf: csrfToken });
    assert.equal(enableDeactivated.status, 400);
    const disableDeactivated = await client.call('admin', 'POST', `/admin/users/${u3}/disable`,
      { body: { reason: 'x' }, csrf: csrfToken });
    assert.equal(disableDeactivated.status, 400);
    await testDb.db.query(`UPDATE users SET status = 'disabled' WHERE id = $1`, [u3]); // 还原夹具
  });

  test('注销：有在途作品 409；成功后清余额（adjust 流水）、删会话/微信绑定、手机号占位、媒体对象删除、记录匿名保留', async () => {
    // u4 先放媒体对象与在途作品 → 409
    await storage.put('uploads/u4-photo.jpg', Buffer.from('photo'), {});
    await testDb.db.query(
      `INSERT INTO uploads (id, user_id, kind, storage_key, mime, size_bytes, referenced_at)
       VALUES ($1, $2, 'image', 'uploads/u4-photo.jpg', 'image/jpeg', 5, now())`, [newId('upl'), u4]);
    const activeProject = newId('prj');
    await testDb.db.query(
      `INSERT INTO projects (id, user_id, story_text, source_type, style_id, quality_tier_id, tier_mapping_id, status, title)
       SELECT $1, $2, '在途故事', 'text', s.id, q.id, m.id, 'rendering', '制作中的作品'
         FROM styles s, quality_tiers q, tier_mappings m
        WHERE s.id = (SELECT id FROM styles LIMIT 1) AND q.id = (SELECT id FROM quality_tiers LIMIT 1)
          AND m.id = (SELECT id FROM tier_mappings LIMIT 1)`, [activeProject, u4]);
    await testDb.db.query(`INSERT INTO wallets (user_id, available_fen) VALUES ($1, 888) ON CONFLICT (user_id) DO NOTHING`, [u4]);
    const blocked = await client.call('admin', 'POST', `/admin/users/${u4}/deactivate`,
      { body: { reason: '用户申请注销', confirm: true }, csrf: csrfToken });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.json.code, 'USER_HAS_ACTIVE_PROJECTS');
    const noConfirm = await client.call('admin', 'POST', `/admin/users/${u4}/deactivate`,
      { body: { reason: '用户申请注销', confirm: false }, csrf: csrfToken });
    assert.equal(noConfirm.status, 400);

    // 在途作品改终态后再试：冻结金额 >0（待核对的费用）同样拦截，检查在注销事务内做
    await testDb.db.query(`UPDATE projects SET status = 'delivered' WHERE id = $1`, [activeProject]);
    await testDb.db.query(`UPDATE wallets SET frozen_fen = 500 WHERE user_id = $1`, [u4]);
    const frozenBlocked = await client.call('admin', 'POST', `/admin/users/${u4}/deactivate`,
      { body: { reason: '用户申请注销', confirm: true }, csrf: csrfToken });
    assert.equal(frozenBlocked.status, 409, '冻结 >0 不能注销');
    assert.equal(frozenBlocked.json.code, 'USER_HAS_ACTIVE_PROJECTS');
    assert.equal(frozenBlocked.json.message, '该用户还有进行中的作品或待核对的费用，暂不能注销');
    await testDb.db.query(`UPDATE wallets SET frozen_fen = 0 WHERE user_id = $1`, [u4]);
    await testDb.db.query(
      `INSERT INTO sessions (token_hash, user_id, csrf_token, expires_at)
       VALUES ($1, $2, 'csrf', now() + interval '1 day')`, ['y'.repeat(64), u4]);
    const done = await client.call('admin', 'POST', `/admin/users/${u4}/deactivate`,
      { body: { reason: '用户申请注销，余额按协议处理', confirm: true }, csrf: csrfToken });
    assert.equal(done.status, 200);
    assert.equal(done.json.status, 'deactivated');
    assert.equal(done.json.phoneMasked, '已注销');
    const row = (await testDb.db.query(`SELECT phone, nickname, status FROM users WHERE id = $1`, [u4])).rows[0];
    assert.equal(row.status, 'deactivated');
    assert.ok(!row.phone.includes('15811110004'), '手机号已改占位');
    assert.equal(row.nickname, '已注销用户');
    const proj = (await testDb.db.query(`SELECT title, story_text FROM projects WHERE id = $1`, [activeProject])).rows[0];
    assert.equal(proj.title, '已注销作品');
    assert.ok(!proj.story_text.includes('在途故事'), '故事文本已匿名');
    const sessions = await testDb.db.query(`SELECT count(*)::int AS n FROM sessions WHERE user_id = $1`, [u4]);
    assert.equal(sessions.rows[0].n, 0);
    const clear = (await testDb.db.query(
      `SELECT available_fen, frozen_fen FROM wallets WHERE user_id = $1`, [u4])).rows[0];
    assert.equal(clear.available_fen, 0, '剩余余额清零');
    const adjustEntry = (await testDb.db.query(
      `SELECT kind, amount_fen, reason, admin_id FROM ledger WHERE user_id = $1 AND kind = 'adjust'`, [u4])).rows[0];
    assert.equal(adjustEntry.amount_fen, -888);
    assert.equal(adjustEntry.reason, '用户申请注销，余额按协议处理');
    assert.equal(adjustEntry.admin_id, adminId);
    assert.ok(testDb.removedKeys.includes('uploads/u4-photo.jpg'), '媒体对象已调用删除');
    const audit = (await testDb.db.query(
      `SELECT detail FROM admin_audit_logs WHERE action = 'user.deactivate' ORDER BY id DESC LIMIT 1`)).rows[0];
    assert.equal(audit.detail.filesFailed, 0);
    assert.equal(audit.detail.balanceClearedFen, 888, '审计记实际清零金额');

    // 已注销账号不能调整余额
    const adjustDeactivated = await client.call('admin', 'POST', `/admin/users/${u4}/adjust`,
      { body: { amountFen: 100, reason: '补偿已注销用户', idempotencyKey: 'adm-adjust-dead' }, csrf: csrfToken });
    assert.equal(adjustDeactivated.status, 400);
    assert.equal(adjustDeactivated.json.message, '该账号已注销，不能调整余额');

    // 幂等重复调用：直接返回当前状态，不再产生新的清零流水
    const again = await client.call('admin', 'POST', `/admin/users/${u4}/deactivate`,
      { body: { reason: '重复请求', confirm: true }, csrf: csrfToken });
    assert.equal(again.status, 200);
    const adjustCount = (await testDb.db.query(
      `SELECT count(*)::int AS n FROM ledger WHERE user_id = $1 AND idempotency_key = 'deactivate:' || $1`, [u4])).rows[0];
    assert.equal(adjustCount.n, 1);
  });

  test('订单列表：倒序与过滤（status/userId/outTradeNo/from/to）、掩码、refundedFen', async () => {
    const all = await client.call('admin', 'GET', '/admin/orders');
    assert.equal(all.status, 200);
    assert.equal(all.json.items.length, 3);
    assert.equal(all.json.items[0].id, createdOrder, '创建时间倒序');
    const paid = all.json.items.find((item) => item.id === paidOrder);
    assert.equal(paid.phoneMasked, '158****0001');
    assert.equal(paid.refundedFen, 0);
    assert.equal(paid.transactionId, 'tx_4200001');
    const byStatus = await client.call('admin', 'GET', '/admin/orders?status=created');
    assert.deepEqual(byStatus.json.items.map((item) => item.id), [createdOrder]);
    const byNo = await client.call('admin', 'GET', `/admin/orders?outTradeNo=${expiredOrder}`);
    assert.deepEqual(byNo.json.items.map((item) => item.id), [expiredOrder]);
    const byUser = await client.call('admin', 'GET', `/admin/orders?userId=${u1}&limit=2`);
    assert.equal(byUser.json.items.length, 2);
    const fromTo = await client.call('admin', 'GET',
      `/admin/orders?from=${encodeURIComponent('2020-01-01T00:00:00Z')}&to=${encodeURIComponent('2020-01-02T00:00:00Z')}`);
    assert.equal(fromTo.json.items.length, 0, '范围过滤生效');
    const badStatus = await client.call('admin', 'GET', '/admin/orders?status=whatever');
    assert.equal(badStatus.status, 400);
  });

  test('订单详情：notifyCount / lastNotifyAt / ledgerId；不存在 404', async () => {
    const { status, json } = await client.call('admin', 'GET', `/admin/orders/${paidOrder}`);
    assert.equal(status, 200);
    assert.equal(json.notifyCount, 2);
    assert.ok(json.lastNotifyAt);
    assert.ok(json.ledgerId);
    assert.equal(json.paidAt !== null, true);
    const missing = await client.call('admin', 'GET', '/admin/orders/po_missing');
    assert.equal(missing.status, 404);
    assert.equal(missing.json.code, 'ORDER_NOT_FOUND');
  });

  test('手动对账：复用定时对账口径（SUCCESS 补入账；未配置支付 503）', async () => {
    const before = (await testDb.db.query(`SELECT available_fen FROM wallets WHERE user_id = $1`, [u1])).rows[0].available_fen;
    const done = await client.call('admin', 'POST', `/admin/orders/${createdOrder}/reconcile`, { csrf: csrfToken });
    assert.equal(done.status, 200);
    assert.equal(done.json.status, 'paid', '查单 SUCCESS → 置 paid');
    const afterRow = (await testDb.db.query(`SELECT available_fen FROM wallets WHERE user_id = $1`, [u1])).rows[0];
    assert.equal(afterRow.available_fen, before + 10000, '补入账 +10000');
    const entry = (await testDb.db.query(
      `SELECT idempotency_key FROM ledger WHERE ref_type = 'payment_order' AND ref_id = $1 AND kind = 'recharge'`,
      [createdOrder])).rows[0];
    assert.equal(entry.idempotency_key, `recharge:${createdOrder}`, '入账幂等键与定时对账一致');
    const audit = await testDb.db.query(`SELECT action FROM admin_audit_logs WHERE action = 'order.reconcile'`);
    assert.ok(audit.rowCount >= 1);

    const noPay = clientFor(noPayBase);
    const login = await noPay.call('np', 'POST', '/admin/auth/login',
      { body: { username: 'admin', password: 'admin-password-123' } });
    const r = await noPay.call('np', 'POST', `/admin/orders/${paidOrder}/reconcile`, { csrf: login.json.csrfToken });
    assert.equal(r.status, 502, 'PAYMENT_UNAVAILABLE 是 502（API.md §7）');
    assert.equal(r.json.code, 'PAYMENT_UNAVAILABLE');
  });

  test('人工退款（记录式）：未支付 409、超订单 400、超余额 400、成功扣余额累加 refunded_fen、幂等、审计', async () => {
    // 注：createdOrder 已在上一用例被手动对账置 paid，这里用 expired 单验证「未支付不能退款」
    const notPaid = await client.call('admin', 'POST', `/admin/orders/${expiredOrder}/refund`,
      { body: { amountFen: 100, reason: 'x', idempotencyKey: 'rf-1' }, csrf: csrfToken });
    assert.equal(notPaid.status, 409);
    assert.equal(notPaid.json.code, 'ORDER_NOT_PAID');

    const balanceBefore = (await testDb.db.query(
      `SELECT available_fen FROM wallets WHERE user_id = $1`, [u1])).rows[0].available_fen;
    // 先把 u1 余额降到低于退款额：退 3000 → 需要 ≥3000
    const ok = await client.call('admin', 'POST', `/admin/orders/${paidOrder}/refund`,
      { body: { amountFen: 3000, reason: '用户申请退款，微信商户平台已退', idempotencyKey: 'rf-2' }, csrf: csrfToken });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.order.refundedFen, 3000);
    assert.equal(ok.json.entry.title, '充值退款');
    assert.equal(ok.json.entry.amountFen, -3000);
    assert.equal(ok.json.entry.refType, 'payment_order');
    assert.equal(ok.json.entry.refId, paidOrder);
    const mid = (await testDb.db.query(`SELECT available_fen FROM wallets WHERE user_id = $1`, [u1])).rows[0].available_fen;
    assert.equal(mid, balanceBefore - 3000);

    const exceedsOrder2 = await client.call('admin', 'POST', `/admin/orders/${paidOrder}/refund`,
      { body: { amountFen: 2001, reason: '超剩余', idempotencyKey: 'rf-3' }, csrf: csrfToken });
    assert.equal(exceedsOrder2.status, 400, '已退 3000，再退 2001 超订单金额');
    assert.equal(exceedsOrder2.json.code, 'REFUND_EXCEEDS_ORDER');

    // 降到余额不足：再退 2000（订单还能退 2000，但把余额先扣掉）
    const drain = await client.call('admin', 'POST', `/admin/users/${u1}/adjust`,
      { body: { amountFen: -(mid - 1500), reason: '测试耗余额', idempotencyKey: 'rf-drain' }, csrf: csrfToken });
    assert.equal(drain.status, 200);
    const exceedsBalance = await client.call('admin', 'POST', `/admin/orders/${paidOrder}/refund`,
      { body: { amountFen: 2000, reason: '余额不足', idempotencyKey: 'rf-4' }, csrf: csrfToken });
    assert.equal(exceedsBalance.status, 400);
    assert.equal(exceedsBalance.json.code, 'REFUND_EXCEEDS_BALANCE');

    // 幂等重放：同键同参返回首次结果，refunded_fen 不重复累计
    const replay = await client.call('admin', 'POST', `/admin/orders/${paidOrder}/refund`,
      { body: { amountFen: 3000, reason: '用户申请退款，微信商户平台已退', idempotencyKey: 'rf-2' }, csrf: csrfToken });
    assert.equal(replay.status, 200);
    assert.equal(replay.json.entry.id, ok.json.entry.id);
    const refunded = (await testDb.db.query(
      `SELECT refunded_fen FROM payment_orders WHERE id = $1`, [paidOrder])).rows[0].refunded_fen;
    assert.equal(Number(refunded), 3000, '重放不重复累加 refunded_fen');
    const audit = await testDb.db.query(`SELECT action FROM admin_audit_logs WHERE action = 'order.refund'`);
    assert.ok(audit.rowCount >= 2);
    const ledgerRow = (await testDb.db.query(
      `SELECT reason, admin_id, idempotency_key FROM ledger WHERE ref_id = $1 AND kind = 'adjust'`, [paidOrder])).rows[0];
    assert.equal(ledgerRow.reason, '用户申请退款，微信商户平台已退');
    assert.equal(ledgerRow.admin_id, adminId);
    assert.equal(ledgerRow.idempotency_key, 'admin:refund:rf-2');
  });
});
