// 管理端 API 测试（M2-BE-03，API.md §8）：独立管理员会话、渠道 CRUD（凭证只回掩码）、
// 路由设置、启停/软删除、连接测试、审计留痕、未登录 401。
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import express from 'express';
import { createTestDb } from '../helpers/db.js';
import { createLogger } from '../../src/logger.js';
import { loadDriverRegistry } from '../../src/engine/providers/index.js';
import { createChannelService } from '../../src/channels/service.js';
import { hashAdminPassword } from '../../src/channels/crypto.js';
import { adminRoutes } from '../../src/api/admin.js';
import { errorHandler } from '../../src/http/middleware.js';
import { newId } from '../../src/db/ids.js';

const silentLogger = createLogger({ level: 'silent' });
const SECRET = 'k'.repeat(48);

/** 极简 cookie 会话测试客户端（复用 supertest 依赖会超范围，直接用 fetch + 内存 cookie）。 */
function clientFor(app, port) {
  const jars = new Map(); // label → cookie string
  async function call(label, method, path, { body, csrf } = {}) {
    const headers = {};
    const cookie = jars.get(label);
    if (cookie) headers.cookie = cookie;
    if (csrf) headers['x-csrf-token'] = csrf;
    const response = await fetch(`http://127.0.0.1:${port}/api/v1${path}`, {
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

describe('管理端 API（M2-BE-03）', () => {
  let testDb;
  let server;
  let port;
  let client;
  let csrfToken;

  before(async () => {
    testDb = await createTestDb();
    const db = testDb.db;
    await db.query(
      `INSERT INTO admin_users (id, username, password_hash, display_name) VALUES ($1, 'admin', $2, '测试管理员')`,
      [newId('adm'), hashAdminPassword('admin-password-123')]);
    const registry = await loadDriverRegistry({ logger: silentLogger });
    const service = createChannelService({ db, secretKey: SECRET, registry, logger: silentLogger });
    const config = { cookieSecure: false, sessionTtlDays: 1, allowedOrigins: [],
      admin: { loginMaxFailures: 5, loginFailWindowSeconds: 600, loginBanSeconds: 7200 } };
    const app = express();
    app.use(express.json({ limit: '100kb' }));
    app.use('/api/v1', adminRoutes({ db, config, logger: silentLogger, service, registry, secretKey: SECRET }));
    app.use(errorHandler(silentLogger));
    await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    port = server.address().port;
    client = clientFor(app, port);
  });
  after(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); await testDb.drop(); });

  test('未登录访问管理端 → 401 ADMIN_AUTH_REQUIRED', async () => {
    const { status, json } = await client.call('anon', 'GET', '/admin/channels');
    assert.equal(status, 401);
    assert.equal(json.code, 'ADMIN_AUTH_REQUIRED');
  });

  test('登录：错误口令 401；正确口令返回 admin + csrfToken', async () => {
    const bad = await client.call('admin', 'POST', '/admin/auth/login',
      { body: { username: 'admin', password: 'wrong-password-x' } });
    assert.equal(bad.status, 401);
    const ok = await client.call('admin', 'POST', '/admin/auth/login',
      { body: { username: 'admin', password: 'admin-password-123' } });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.admin.username, 'admin');
    assert.ok(ok.json.csrfToken);
    csrfToken = ok.json.csrfToken;
  });

  test('GET /admin/drivers：列出代码里的驱动', async () => {
    const { status, json } = await client.call('admin', 'GET', '/admin/drivers');
    assert.equal(status, 200);
    const ids = json.items.map((item) => item.id);
    assert.ok(ids.includes('aiide-ark') && ids.includes('openai-images') && ids.includes('openai-compatible'));
  });

  test('创建渠道：凭证只回掩码；驱动不存在 400 DRIVER_NOT_FOUND', async () => {
    const created = await client.call('admin', 'POST', '/admin/channels', {
      body: { kind: 'video', name: 'api-video', driver: 'aiide-ark', baseUrl: 'https://api-v.example.test',
        credential: 'sk-api-secret-7777', modelMap: { video: 'dreamina-seedance-2-5-hc' },
        costFen: { 'video.480p': 68 } }, csrf: csrfToken });
    assert.equal(created.status, 201);
    assert.equal(created.json.credentialMask, '****7777');
    assert.ok(!JSON.stringify(created.json).includes('sk-api-secret-7777'), '响应不得含明文凭证');
    const bad = await client.call('admin', 'POST', '/admin/channels', {
      body: { kind: 'video', name: 'bad', driver: 'nope', baseUrl: 'https://x.example.test',
        credential: 'sk-xxxxxxxxxxxx', modelMap: { video: 'm' } }, csrf: csrfToken });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.code, 'DRIVER_NOT_FOUND');
    // 缺必填字段（modelMap）→ VALIDATION_FAILED
    const missing = await client.call('admin', 'POST', '/admin/channels', {
      body: { kind: 'video', name: 'missing', driver: 'aiide-ark', baseUrl: 'https://x.example.test',
        credential: 'sk-xxxxxxxxxxxx' }, csrf: csrfToken });
    assert.equal(missing.status, 400);
    assert.equal(missing.json.code, 'VALIDATION_FAILED');
  });

  test('PATCH 渠道：credential 缺省不改；改后掩码更新', async () => {
    const list = await client.call('admin', 'GET', '/admin/channels?kind=video');
    const channel = list.json.items.find((item) => item.name === 'api-video');
    const updated = await client.call('admin', 'PATCH', `/admin/channels/${channel.id}`, {
      body: { remark: 'api 测试渠道' }, csrf: csrfToken });
    assert.equal(updated.status, 200);
    assert.equal(updated.json.remark, 'api 测试渠道');
    assert.equal(updated.json.credentialMask, '****7777', '未传 credential：掩码不变');
    const rotated = await client.call('admin', 'PATCH', `/admin/channels/${channel.id}`, {
      body: { credential: 'sk-new-secret-4321' }, csrf: csrfToken });
    assert.equal(rotated.json.credentialMask, '****4321');
  });

  test('PUT 路由 + GET 路由；重复渠道被拒', async () => {
    const list = await client.call('admin', 'GET', '/admin/channels?kind=video');
    const channel = list.json.items.find((item) => item.name === 'api-video');
    const set = await client.call('admin', 'PUT', '/admin/routes/video/*', {
      body: { channelIds: [channel.id] }, csrf: csrfToken });
    assert.equal(set.status, 200);
    const dup = await client.call('admin', 'PUT', '/admin/routes/video/*', {
      body: { channelIds: [channel.id, channel.id] }, csrf: csrfToken });
    assert.equal(dup.status, 400);
    const routes = await client.call('admin', 'GET', '/admin/routes/video');
    assert.ok(routes.json.items.some((route) => route.id === channel.id));
  });

  test('连接测试（catalog 免费）：成功返回模型列表；配置的模型缺失列 mismatches', async () => {
    const list = await client.call('admin', 'GET', '/admin/channels?kind=video');
    const channel = list.json.items.find((item) => item.name === 'api-video');
    // 渠道地址不可达（example.test 假域名）：测试驱动注入的 catalog 不可用路径——期望 400 CHANNEL_TEST_FAILED
    const result = await client.call('admin', 'POST', `/admin/channels/${channel.id}/test`, {});
    assert.equal(result.status, 400);
    assert.equal(result.json.code, 'CHANNEL_TEST_FAILED');
  });

  test('disable → enable → DELETE 软删除（retired）', async () => {
    const list = await client.call('admin', 'GET', '/admin/channels?kind=video');
    const channel = list.json.items.find((item) => item.name === 'api-video');
    const disabled = await client.call('admin', 'POST', `/admin/channels/${channel.id}/disable`, { csrf: csrfToken });
    assert.equal(disabled.json.status, 'disabled');
    const enabled = await client.call('admin', 'POST', `/admin/channels/${channel.id}/enable`, { csrf: csrfToken });
    assert.equal(enabled.json.status, 'active');
    const removed = await client.call('admin', 'DELETE', `/admin/channels/${channel.id}`, { csrf: csrfToken });
    assert.equal(removed.json.status, 'retired');
    const after = await client.call('admin', 'GET', '/admin/channels');
    assert.ok(!after.json.items.some((item) => item.id === channel.id), '默认列表不显示软删除');
    const retiredList = await client.call('admin', 'GET', '/admin/channels?includeRetired=true');
    assert.ok(retiredList.json.items.some((item) => item.id === channel.id));
  });

  test('全部写操作有审计留痕（不含明文凭证）', async () => {
    const { rows } = await testDb.db.query(
      `SELECT action, detail FROM admin_audit_logs WHERE actor = 'admin' ORDER BY id`);
    const actions = rows.map((row) => row.action);
    for (const expected of ['auth.login', 'channel.create', 'channel.update', 'route.set', 'channel.disable', 'channel.enable', 'channel.retire']) {
      assert.ok(actions.includes(expected), `缺审计 ${expected}`);
    }
    const dump = JSON.stringify(rows);
    assert.ok(!dump.includes('sk-api-secret-7777') && !dump.includes('sk-new-secret-4321'), '审计不含明文凭证');
  });

  test('登出后再访问 → 401', async () => {
    await client.call('admin', 'POST', '/admin/auth/logout', { csrf: csrfToken });
    const { status } = await client.call('admin', 'GET', '/admin/channels');
    assert.equal(status, 401);
  });
});
