// 管理员登录 IP 限流（M2-BE-03 审查必改，用户 2026-10-24 裁决）：失败窗口内满 5 次封禁 120 分钟；
// 封禁期间正确密码也拒绝；窗口外失败不累计；不同 IP 互不影响；封禁到期恢复。
// 服务层直调 createAdminAuth().login（可控 ip）；另补 HTTP 层封禁 429 / 到期恢复。
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import express from 'express';
import { createTestDb } from '../helpers/db.js';
import { createLogger } from '../../src/logger.js';
import { loadConfig } from '../../src/config.js';
import { createAdminAuth } from '../../src/channels/admin-auth.js';
import { hashAdminPassword } from '../../src/channels/crypto.js';
import { adminRoutes } from '../../src/api/admin.js';
import { loadDriverRegistry } from '../../src/engine/providers/index.js';
import { createChannelService } from '../../src/channels/service.js';
import { newId } from '../../src/db/ids.js';
import { errorHandler } from '../../src/http/middleware.js';

const silent = createLogger({ level: 'silent' });
const USERNAME = 'ratelimit-admin';
const PASSWORD = 'ratelimit-pass-123';

describe('管理员登录 IP 限流（M2-BE-03 审查必改）', () => {
  let testDb;
  let db;
  let auth;
  // 缩短窗口便于测试：失败窗口 600s 对齐整窗不可控 → 测试直接操作 rate_counters 行控制窗口位置；
  // 配置保持生产默认（5 次 / 600s / 7200s）以验证真实口径。
  const config = loadConfig({ NODE_ENV: 'test' });

  before(async () => {
    testDb = await createTestDb();
    db = testDb.db;
    await db.query(
      `INSERT INTO admin_users (id, username, password_hash, display_name) VALUES ($1, $2, $3, '限流测试')`,
      [newId('adm'), USERNAME, hashAdminPassword(PASSWORD)]);
    auth = createAdminAuth({ config, db });
  });
  after(async () => { await testDb.drop(); });

  const failOnce = async (ip) => auth.login({ username: USERNAME, password: 'wrong-password-x', ip });
  const tryLogin = async (ip) => auth.login({ username: USERNAME, password: PASSWORD, ip });
  const backdateFailWindow = async (ip, seconds) => db.query(
    `UPDATE rate_counters SET window_start = window_start - make_interval(secs => $2) WHERE key = $1`,
    [`admin:login:fail:${ip}`, seconds]);
  const backdateBan = async (ip, seconds) => db.query(
    `UPDATE rate_counters SET window_start = window_start - make_interval(secs => $2) WHERE key = $1`,
    [`admin:login:ban:${ip}`, seconds]);

  test('失败 4 次后第 5 次仍可登录（正确密码成功，不封禁）', async () => {
    const ip = '10.1.0.1';
    for (let i = 0; i < 4; i += 1) assert.equal(await failOnce(ip), null, `第 ${i + 1} 次失败返回 null`);
    const session = await tryLogin(ip);
    assert.ok(session && session.admin.username === USERNAME, '第 5 次尝试正确密码 → 登录成功');
    const { rows: [ban] } = await db.query(
      `SELECT count(*)::int AS n FROM rate_counters WHERE key = $1`, [`admin:login:ban:${ip}`]);
    assert.equal(ban.n, 0, '未触发封禁');
  });

  test('第 5 次失败进入封禁；封禁期间正确密码被拒（429）', async () => {
    const ip = '10.1.0.2';
    for (let i = 0; i < 5; i += 1) assert.equal(await failOnce(ip), null, `第 ${i + 1} 次失败返回 null`);
    const { rows: [ban] } = await db.query(
      `SELECT count(*)::int AS n FROM rate_counters WHERE key = $1`, [`admin:login:ban:${ip}`]);
    assert.equal(ban.n, 1, '第 5 次失败写入封禁行');
    await assert.rejects(tryLogin(ip), (error) => {
      assert.equal(error.status, 429);
      assert.equal(error.code, 'RATE_LIMITED');
      assert.equal(error.details.retryAfterSeconds, config.admin.loginBanSeconds);
      return true;
    });
    // 错误密码同样拒绝且不新增计数
    const before = (await db.query(
      `SELECT count FROM rate_counters WHERE key = $1`, [`admin:login:fail:${ip}`])).rows[0].count;
    await assert.rejects(failOnce(ip), (error) => error.status === 429);
    const after = (await db.query(
      `SELECT count FROM rate_counters WHERE key = $1`, [`admin:login:fail:${ip}`])).rows[0].count;
    assert.equal(after, before, '封禁期间的尝试不再累计失败计数');
  });

  test('封禁到期后恢复登录', async () => {
    const ip = '10.1.0.3';
    for (let i = 0; i < 5; i += 1) await failOnce(ip);
    await assert.rejects(tryLogin(ip), (error) => error.status === 429);
    await backdateBan(ip, config.admin.loginBanSeconds + 1); // 封禁期整体回拨到期
    const session = await tryLogin(ip);
    assert.ok(session && session.admin.username === USERNAME, '封禁到期后正确密码恢复登录');
  });

  test('不同 IP 互不影响', async () => {
    const banned = '10.1.0.4';
    const other = '10.1.0.5';
    for (let i = 0; i < 5; i += 1) await failOnce(banned);
    await assert.rejects(tryLogin(banned), (error) => error.status === 429);
    const session = await tryLogin(other);
    assert.ok(session && session.admin.username === USERNAME, '另一 IP 不受封禁影响');
  });

  test('失败计数窗口外的旧失败不累计（固定窗口口径）', async () => {
    const ip = '10.1.0.6';
    for (let i = 0; i < 4; i += 1) await failOnce(ip);
    // 旧窗口整体移出失败计数窗口：新窗口从 0 数起
    await backdateFailWindow(ip, config.admin.loginFailWindowSeconds + 1);
    const session = await tryLogin(ip);
    assert.ok(session, '旧窗口 4 次失败过期后，新窗口第 1 次尝试（成功）不受影响');
    // 新窗口内 4 次失败 + 成功 → 仍不封禁
    for (let i = 0; i < 4; i += 1) await failOnce(ip);
    const { rows: [ban] } = await db.query(
      `SELECT count(*)::int AS n FROM rate_counters WHERE key = $1`, [`admin:login:ban:${ip}`]);
    assert.equal(ban.n, 0, '跨窗口的失败不累计到封禁阈值');
  });

  test('封禁触发写审计（auth.login_banned），普通失败写 auth.login_failed', async () => {
    const ip = '10.1.0.7';
    await failOnce(ip);
    const { rows: actions } = await db.query(
      `SELECT action FROM admin_audit_logs WHERE detail->>'ip' = $1 ORDER BY id`, [ip]);
    assert.ok(actions.some((row) => row.action === 'auth.login_failed'));
    for (let i = 0; i < 4; i += 1) await failOnce(ip); // 共 5 次
    const { rows: after } = await db.query(
      `SELECT action FROM admin_audit_logs WHERE detail->>'ip' = $1 ORDER BY id`, [ip]);
    assert.ok(after.some((row) => row.action === 'auth.login_banned'), '第 5 次失败记 login_banned 审计');
  });

  // ── HTTP 层：封禁 429 / 到期恢复 200 ──
  describe('HTTP 层', () => {
    let server;
    let port;
    const cookie = { value: null, csrf: null };

    before(async () => {
      const registry = await loadDriverRegistry({ logger: silent });
      const service = createChannelService({ db, secretKey: 'z'.repeat(40), registry, logger: silent });
      const app = express();
      app.use(express.json());
      app.use('/api/v1', adminRoutes({ db, config, logger: silent, service, registry, secretKey: 'z'.repeat(40) }));
      app.use(errorHandler(silent));
      await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
      port = server.address().port;
    });
    after(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); });

    const post = (body) => fetch(`http://127.0.0.1:${port}/api/v1/admin/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

    test('本机 IP 被封禁后 HTTP 登录 429；回拨封禁期后 200', async () => {
      const ip = '127.0.0.1';
      // 服务层把本机 IP 打入封禁（直调，避免测试依赖真实 5 次往返）
      for (let i = 0; i < 5; i += 1) await auth.login({ username: USERNAME, password: 'wrong-x', ip });
      const banned = await post({ username: USERNAME, password: PASSWORD });
      assert.equal(banned.status, 429);
      const body = await banned.json();
      assert.equal(body.code, 'RATE_LIMITED');

      await db.query(
        `UPDATE rate_counters SET window_start = window_start - make_interval(secs => $2) WHERE key = $1`,
        [`admin:login:ban:${ip}`, config.admin.loginBanSeconds + 1]);
      // 失败计数也已 5 次（直调制造封禁时累计）——一并回拨，恢复干净窗口
      await db.query(
        `UPDATE rate_counters SET window_start = window_start - make_interval(secs => $2) WHERE key = $1`,
        [`admin:login:fail:${ip}`, config.admin.loginFailWindowSeconds + 1]);
      const ok = await post({ username: USERNAME, password: PASSWORD });
      assert.equal(ok.status, 200);
      const session = await ok.json();
      assert.ok(session.csrfToken);
      cookie.value = ok.headers.get('set-cookie').split(';')[0];
      cookie.csrf = session.csrfToken;
    });
  });
});
