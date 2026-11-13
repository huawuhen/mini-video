// 管理端·价格与配置 / 审计测试（M3-ADM-04，API.md §8.4~8.5）：
// SKU 新增版本（立即生效换价、未来生效不抢跑、幂等、LLM 价格为 0）、档位与映射版本、
// 风格/音色管理与下架、运营参数白名单（外键/越界 400）、审计只读列表（过滤/ip/操作人）、
// 管理端上传（图片/音频识别、5MB 上限）与引用标记。独立测试库，零真实费用。
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import express from 'express';
import { createTestDb } from './helpers/db.js';
import { createLogger } from '../src/logger.js';
import { createMemoryStorage } from '../src/engine/storage/memory.js';
import { hashAdminPassword } from '../src/channels/crypto.js';
import { getCatalog } from '../src/catalog/service.js';
import { adminAuthRoutes } from '../src/api/admin-auth.js';
import { adminConfigRoutes } from '../src/api/admin-config.js';
import { errorHandler } from '../src/http/middleware.js';
import { newId } from '../src/db/ids.js';

const silentLogger = createLogger({ level: 'silent' });

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3]);
const MP3 = Buffer.concat([Buffer.from('ID3', 'latin1'), Buffer.alloc(16, 1)]);

function clientFor(app, port) {
  const jars = new Map();
  async function call(label, method, path, { body, csrf, formData } = {}) {
    const headers = {};
    const cookie = jars.get(label);
    if (cookie) headers.cookie = cookie;
    if (csrf) headers['x-csrf-token'] = csrf;
    let payload;
    if (formData) payload = formData;
    else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
    const response = await fetch(`http://127.0.0.1:${port}/api/v1${path}`, { method, headers, body: payload });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) jars.set(label, setCookie.split(';')[0]);
    const text = await response.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
    return { status: response.status, json };
  }
  return { call };
}

describe('管理端 价格与配置/审计（M3-ADM-04）', () => {
  let testDb;
  let server;
  let client;
  let csrf;
  let storage;

  before(async () => {
    testDb = await createTestDb();
    const db = testDb.db;
    await db.query(`INSERT INTO admin_users (id, username, password_hash, display_name)
      VALUES ($1, 'admin', $2, '测试管理员')`, [newId('adm'), hashAdminPassword('admin-password-123')]);
    await db.query(`INSERT INTO users (id, phone, nickname) VALUES ('usr_user00000001', '15800000001', '用户A')`);
    await db.query(`INSERT INTO wallets (user_id) VALUES ('usr_user00000001')`);
    storage = createMemoryStorage();
    const config = { cookieSecure: false, sessionTtlDays: 1, allowedOrigins: [],
      admin: { loginMaxFailures: 5, loginFailWindowSeconds: 600, loginBanSeconds: 7200 } };
    const app = express();
    app.use(express.json({ limit: '200kb' }));
    app.use('/api/v1', adminAuthRoutes({ db, config }));
    app.use('/api/v1', adminConfigRoutes({ db, config, logger: silentLogger, storage, urlFor: () => undefined }));
    app.use(errorHandler(silentLogger));
    await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    client = clientFor(app, server.address().port);
    const login = await client.call('admin', 'POST', '/admin/auth/login',
      { body: { username: 'admin', password: 'admin-password-123' } });
    csrf = login.json.csrfToken;
    assert.ok(csrf, '登录失败');
  });
  after(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); await testDb.drop(); });

  test('未登录访问 → 401', async () => {
    const { status, json } = await client.call('anon', 'GET', '/admin/skus');
    assert.equal(status, 401);
    assert.equal(json.code, 'ADMIN_AUTH_REQUIRED');
  });

  test('SKU 列表：每个 skuCode 当前生效版本 + 历史版本数', async () => {
    const { status, json } = await client.call('admin', 'GET', '/admin/skus', { csrf });
    assert.equal(status, 200);
    const video480 = json.items.find((item) => item.skuCode === 'video.480p');
    assert.equal(video480.priceFen, 100, '迁移 009 逻辑 SKU 当前价');
    assert.equal(video480.versions, 1);
    assert.equal(video480.marginRate, 1, 'cost 0 → 毛利率 1');
    const look = json.items.find((item) => item.skuCode === 'image.look');
    assert.equal(look.priceFen, 60);
  });

  test('新增版本立即生效：报价用新价、旧版本下线、历史保留', async () => {
    const { status, json } = await client.call('admin', 'POST', '/admin/skus/video.480p/versions',
      { body: { priceFen: 120, idempotencyKey: 'cfg-v2' }, csrf });
    assert.equal(status, 200);
    assert.equal(json.version, 2);
    assert.equal(json.priceFen, 120);
    assert.equal(json.versions, 2);
    // 旧版本 inactive、新版本生效
    const { rows } = await testDb.db.query(
      `SELECT version, status FROM skus WHERE sku_code = 'video.480p' ORDER BY version`);
    assert.deepEqual(rows, [{ version: 1, status: 'inactive' }, { version: 2, status: 'active' }]);
    // 改价后的报价用新价（完整资金链路由 pricing-lock.test.js 覆盖）
    const list = await client.call('admin', 'GET', '/admin/skus', { csrf });
    assert.equal(list.json.items.find((item) => item.skuCode === 'video.480p').priceFen, 120);
    // 审计已留痕
    const audit = await client.call('admin', 'GET', '/admin/audit?action=sku', { csrf });
    const entry = audit.json.items.find((item) => item.action === 'sku.version.create');
    assert.ok(entry, '审计记录存在');
    assert.equal(entry.adminUsername, 'admin');
    assert.equal(entry.targetType, 'sku');
    assert.ok(entry.ip, '审计记录请求 IP');
    assert.equal(entry.detail.priceFen, 120);
  });

  test('未来生效的版本：当前价不变、版本数 +1（到点由取价按 version 自动切换）', async () => {
    const future = new Date(Date.now() + 3600_000).toISOString();
    const { status, json } = await client.call('admin', 'POST', '/admin/skus/video.480p/versions',
      { body: { priceFen: 200, effectiveAt: future, idempotencyKey: 'cfg-v3' }, csrf });
    assert.equal(status, 200);
    assert.equal(json.version, 3);
    assert.equal(json.priceFen, 200, '响应展示新版本本身');
    const list = await client.call('admin', 'GET', '/admin/skus', { csrf });
    assert.equal(list.json.items.find((item) => item.skuCode === 'video.480p').priceFen, 120, '未到生效时间，当前价仍 120');
    assert.equal(list.json.items.find((item) => item.skuCode === 'video.480p').versions, 3);
    // 旧版本保持 active（提前置 inactive 会在生效前出现「无可用价格」）
    const { rows } = await testDb.db.query(`SELECT status FROM skus WHERE sku_code = 'video.480p' AND version = 2`);
    assert.equal(rows[0].status, 'active');
    // 用户端目录的档位价同样取当前生效版本（复审必改②：全链路口径一致）
    const catalog = await getCatalog(testDb.db);
    const standardTier = catalog.qualityTiers.find((tier) => tier.id === 'standard');
    assert.equal(standardTier.pricePer30sFen, 120 * 30, '未来版本生效前目录档位价不变');
  });

  test('新增版本幂等：同键同参重放返回首次结果；同键不同参 409；缺幂等键 400', async () => {
    const replay = await client.call('admin', 'POST', '/admin/skus/video.480p/versions',
      { body: { priceFen: 200, idempotencyKey: 'cfg-v3' }, csrf });
    assert.equal(replay.status, 200);
    assert.equal(replay.json.version, 3, '同键同参重放');
    const conflict = await client.call('admin', 'POST', '/admin/skus/video.480p/versions',
      { body: { priceFen: 999, idempotencyKey: 'cfg-v3' }, csrf });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.json.code, 'IDEMPOTENCY_CONFLICT');
    const missing = await client.call('admin', 'POST', '/admin/skus/video.480p/versions',
      { body: { priceFen: 150 }, csrf });
    assert.equal(missing.status, 400);
    const notFound = await client.call('admin', 'POST', '/admin/skus/video.nope/versions',
      { body: { priceFen: 100, idempotencyKey: 'cfg-vx' }, csrf });
    assert.equal(notFound.status, 404);
  });

  test('LLM SKU 用户价必须为 0', async () => {
    await testDb.db.query(
      `INSERT INTO skus (id, sku_code, version, kind, model, channel, unit, price_fen, cost_fen, durations)
       VALUES ('sku_llmtest00000001', 'llm.test', 1, 'llm', '', 'logical', 'ktoken', 0, 0, '{}')`);
    const { status, json } = await client.call('admin', 'POST', '/admin/skus/llm.test/versions',
      { body: { priceFen: 10, idempotencyKey: 'cfg-llm' }, csrf });
    assert.equal(status, 400);
    assert.equal(json.code, 'VALIDATION_FAILED');
  });

  test('档位：列表含当前映射；PATCH 更新；新增映射版本不覆盖历史；坏 SKU 400', async () => {
    const list = await client.call('admin', 'GET', '/admin/tiers', { csrf });
    const standard = list.json.items.find((tier) => tier.id === 'standard');
    assert.equal(standard.currentMapping.videoSkuCode, 'video.480p');
    const patched = await client.call('admin', 'PATCH', '/admin/tiers/standard',
      { body: { note: '清晰流畅（新）', sort: 15 }, csrf });
    assert.equal(patched.status, 200);
    assert.equal(patched.json.note, '清晰流畅（新）');
    const mapping = await client.call('admin', 'POST', '/admin/tiers/standard/mappings',
      { body: { videoSkuCode: 'video.720p' }, csrf });
    assert.equal(mapping.status, 200);
    assert.ok(mapping.json.version >= 6, '映射版本号递增');
    const after = await client.call('admin', 'GET', '/admin/tiers', { csrf });
    assert.equal(after.json.items.find((tier) => tier.id === 'standard').currentMapping.videoSkuCode, 'video.720p');
    // 历史映射行保留（不覆盖）
    const { rows } = await testDb.db.query(`SELECT count(*)::int AS n FROM tier_mappings WHERE tier_id = 'standard'`);
    assert.ok(rows[0].n >= 2);
    const badSku = await client.call('admin', 'POST', '/admin/tiers/standard/mappings',
      { body: { videoSkuCode: 'video.nope' }, csrf });
    assert.equal(badSku.status, 400);
    const badTier = await client.call('admin', 'POST', '/admin/tiers/tier_nope/mappings',
      { body: { videoSkuCode: 'video.480p' }, csrf });
    assert.equal(badTier.status, 404);
  });

  test('风格：管理端上传封面 → 新增 → 下架后用户目录不可见', async () => {
    const up = await client.call('admin', 'POST', '/admin/uploads',
      { formData: pngForm('cover.png'), csrf });
    assert.equal(up.status, 200, `上传封面：${JSON.stringify(up.json)}`);
    const created = await client.call('admin', 'POST', '/admin/styles',
      { body: { name: '测试风格', description: '测试用', coverUploadId: up.json.uploadId, promptHint: 'test style', sort: 99 }, csrf });
    assert.equal(created.status, 200);
    const list = await client.call('admin', 'GET', '/admin/styles', { csrf });
    const style = list.json.items.find((item) => item.name === '测试风格');
    assert.equal(style.coverUploadId, up.json.uploadId);
    assert.equal(style.status, 'active');
    // 上传已被引用（避开 uploads.sweep）
    const { rows } = await testDb.db.query(`SELECT referenced_at FROM uploads WHERE id = $1`, [up.json.uploadId]);
    assert.ok(rows[0].referenced_at, '引用后置 referenced_at');
    // 下架 → 用户目录不可见
    await client.call('admin', 'PATCH', `/admin/styles/${style.id}`, { body: { status: 'inactive' }, csrf });
    const catalog = await getCatalog(testDb.db);
    assert.ok(!catalog.styles.some((item) => item.id === style.id));
    const list2 = await client.call('admin', 'GET', '/admin/styles', { csrf });
    assert.equal(list2.json.items.find((item) => item.id === style.id).status, 'inactive', '后台仍可见（下架不删除）');
  });

  test('音色：新增（试听/参考音频上传）→ 更新 → 下架', async () => {
    const sample = await client.call('admin', 'POST', '/admin/uploads',
      { formData: mp3Form('sample.mp3'), csrf });
    const ref = await client.call('admin', 'POST', '/admin/uploads',
      { formData: mp3Form('ref.mp3'), csrf });
    const created = await client.call('admin', 'POST', '/admin/voices',
      { body: { name: '测试音色', category: 'young_f', gender: 'female', ageGroup: 'young',
        description: '测试', sampleUploadId: sample.json.uploadId, refAudioUploadId: ref.json.uploadId, sort: 99 }, csrf });
    assert.equal(created.status, 200, `创建音色：${JSON.stringify(created.json)}`);
    const list = await client.call('admin', 'GET', '/admin/voices', { csrf });
    const voice = list.json.items.find((item) => item.name === '测试音色');
    assert.equal(voice.sampleUploadId, sample.json.uploadId);
    assert.equal(voice.refAudioUploadId, ref.json.uploadId);
    const patched = await client.call('admin', 'PATCH', `/admin/voices/${voice.id}`,
      { body: { status: 'inactive', description: '下架测试' }, csrf });
    assert.equal(patched.status, 200);
    const { rows } = await testDb.db.query(`SELECT status FROM voices WHERE id = $1`, [voice.id]);
    assert.equal(rows[0].status, 'inactive');
  });

  test('管理端上传：类型识别、非法文件 400、超 5MB 400、MP4 视频不被当 m4a', async () => {
    const bad = await client.call('admin', 'POST', '/admin/uploads',
      { formData: textForm('note.txt'), csrf });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.code, 'UPLOAD_TYPE_INVALID');
    const big = await client.call('admin', 'POST', '/admin/uploads',
      { formData: pngForm('big.png', 5 * 1024 * 1024 + 1), csrf });
    assert.equal(big.status, 400);
    assert.equal(big.json.code, 'UPLOAD_TOO_LARGE');
    const wav = await client.call('admin', 'POST', '/admin/uploads',
      { formData: wavForm('a.wav'), csrf });
    assert.equal(wav.status, 200);
    const { rows } = await testDb.db.query(`SELECT kind, mime FROM uploads WHERE id = $1`, [wav.json.uploadId]);
    assert.deepEqual(rows[0], { kind: 'audio', mime: 'audio/wav' });
    // 复审建议 b：ftyp isom 的 MP4 视频不能被当 m4a 收下；M4A brand 的音频可收
    const mp4 = await client.call('admin', 'POST', '/admin/uploads',
      { formData: ftypForm('clip.mp4', 'isom'), csrf });
    assert.equal(mp4.status, 400);
    assert.equal(mp4.json.code, 'UPLOAD_TYPE_INVALID');
    const m4a = await client.call('admin', 'POST', '/admin/uploads',
      { formData: ftypForm('audio.m4a', 'M4A '), csrf });
    assert.equal(m4a.status, 200, `M4A 音频应可上传：${JSON.stringify(m4a.json)}`);
    const { rows: m4aRows } = await testDb.db.query(`SELECT kind, mime FROM uploads WHERE id = $1`, [m4a.json.uploadId]);
    assert.deepEqual(m4aRows[0], { kind: 'audio', mime: 'audio/mp4' });
  });

  test('调价价格上限：超过 ¥100/单位 400（复审建议 c）', async () => {
    const tooHigh = await client.call('admin', 'POST', '/admin/skus/video.480p/versions',
      { body: { priceFen: 10_001, idempotencyKey: 'cfg-cap' }, csrf });
    assert.equal(tooHigh.status, 400);
    assert.equal(tooHigh.json.code, 'VALIDATION_FAILED');
  });

  test('运营参数：白名单外键 400、越界 400、min>max 400、合法修改生效且进审计', async () => {
    const before = await client.call('admin', 'GET', '/admin/settings', { csrf });
    assert.equal(before.status, 200);
    assert.equal(before.json.items.length, 8, '白名单 8 项');
    assert.ok(before.json.items.every((item) => typeof item.value === 'number'));

    const badKey = await client.call('admin', 'PATCH', '/admin/settings',
      { body: { free_video_seconds: 60 }, csrf });
    assert.equal(badKey.status, 400);
    assert.equal(badKey.json.code, 'SETTING_KEY_NOT_ALLOWED');

    const outOfRange = await client.call('admin', 'PATCH', '/admin/settings',
      { body: { quote_ttl_seconds: 1 }, csrf });
    assert.equal(outOfRange.status, 400);
    assert.equal(outOfRange.json.code, 'VALIDATION_FAILED');
    assert.ok(outOfRange.json.details?.fields?.quote_ttl_seconds);

    const crossField = await client.call('admin', 'PATCH', '/admin/settings',
      { body: { min_story_chars: 4000 }, csrf });
    assert.equal(crossField.status, 400, 'min > max（当前 3000）');

    const ok = await client.call('admin', 'PATCH', '/admin/settings',
      { body: { quote_ttl_seconds: 600, max_character_photos: 8 }, csrf });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.items.find((item) => item.key === 'quote_ttl_seconds').value, 600);
    // 运行时读取的是 settings 表（pricing.js quote TTL）
    const { rows } = await testDb.db.query(`SELECT value FROM settings WHERE key = 'quote_ttl_seconds'`);
    assert.equal(rows[0].value, 600);
    const audit = await client.call('admin', 'GET', '/admin/audit?action=settings.update', { csrf });
    assert.equal(audit.json.items.length, 1);
    assert.deepEqual(audit.json.items[0].detail.changes.quote_ttl_seconds, { from: 900, to: 600 });
  });

  test('审计列表：过滤（targetType/targetId/from/to）与只读分页', async () => {
    const all = await client.call('admin', 'GET', '/admin/audit?limit=50', { csrf });
    assert.ok(all.json.items.length >= 5);
    assert.ok(all.json.items.every((item) => typeof item.id === 'number'));
    // targetId 过滤
    const styles = await client.call('admin', 'GET', '/admin/styles', { csrf });
    const styleId = styles.json.items.find((item) => item.name === '测试风格').id;
    const byTarget = await client.call('admin', `GET`, `/admin/audit?targetType=style&targetId=${styleId}`, { csrf });
    assert.ok(byTarget.json.items.length >= 2, '创建 + 更新（含下架）两条');
    assert.ok(byTarget.json.items.every((item) => item.targetType === 'style'));
    // from/to 过滤（只留今天）
    const today = new Date().toISOString().slice(0, 10);
    const dated = await client.call('admin', 'GET', `/admin/audit?from=${today}&to=${today}&limit=50`, { csrf });
    assert.equal(dated.json.items.length, all.json.items.length, '全部记录都在今天');
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const noneYesterday = await client.call('admin', 'GET', `/admin/audit?from=2026-01-01&to=2026-01-02`, { csrf });
    assert.equal(noneYesterday.json.items.length, 0);
    // 分页
    const page1 = await client.call('admin', 'GET', '/admin/audit?limit=2', { csrf });
    assert.equal(page1.json.items.length, 2);
    assert.ok(page1.json.nextCursor);
    const page2 = await client.call('admin', 'GET', `/admin/audit?limit=2&cursor=${page1.json.nextCursor}`, { csrf });
    assert.ok(page2.json.items[0].id < page1.json.items[1].id, '按 id 倒序续页');
  });

  test('写操作缺 CSRF → 403（同源校验不因新路由放宽）', async () => {
    const { status } = await client.call('admin', 'POST', '/admin/skus/video.480p/versions',
      { body: { priceFen: 1, idempotencyKey: 'cfg-nocsrf' } });
    assert.equal(status, 403);
  });
});

// multipart 表单（node fetch 原生 FormData/Blob）
function pngForm(name, size = 64) {
  const form = new FormData();
  const buffer = size > PNG.length ? Buffer.concat([PNG, Buffer.alloc(size - PNG.length, 7)]) : PNG;
  form.append('file', new Blob([buffer]), name);
  return form;
}
function mp3Form(name) {
  const form = new FormData();
  form.append('file', new Blob([MP3]), name);
  return form;
}
function wavForm(name) {
  const form = new FormData();
  const buffer = Buffer.concat([Buffer.from('RIFF____WAVE', 'latin1'), Buffer.alloc(16, 0)]);
  form.append('file', new Blob([buffer]), name);
  return form;
}
/** ftyp box 样本：major brand 决定是 M4A 音频（可收）还是 MP4 视频（拒收）。 */
function ftypForm(name, majorBrand) {
  const form = new FormData();
  const buffer = Buffer.concat([
    Buffer.from([0, 0, 0, 24]),
    Buffer.from('ftyp', 'latin1'),
    Buffer.from(majorBrand, 'latin1'),
    Buffer.from('0000', 'latin1'),
    Buffer.from('isomiso2', 'latin1'),
    Buffer.alloc(16, 0),
  ]);
  form.append('file', new Blob([buffer]), name);
  return form;
}
function textForm(name) {
  const form = new FormData();
  form.append('file', new Blob([Buffer.from('just text')]), name);
  return form;
}
