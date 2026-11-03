// M3-LEGAL-01：同意记录（只追加 / 版本不一致视为未同意 / 登录记 terms / 照片同意接口 / 上传 403）。
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { silentLogger } from '../src/logger.js';
import { PHOTO_CONSENT_VERSION, TERMS_VERSION } from '../src/auth/consents.js';
import { TINY_PNG } from './helpers/providers.js';
import { createTestDb } from './helpers/db.js';

const ORIGIN = 'http://localhost:5173';

function captureSmsProvider() {
  const provider = { sent: [], id: 'test-capture', async send({ phone, code }) { provider.sent.push({ phone, code }); } };
  return provider;
}

describe('M3-LEGAL-01：同意记录与照片上传守卫', () => {
  let ctx;
  let server;
  let base;
  let provider;
  let account; // { cookie, csrf, user }

  async function signUp(phone, { reusePhone = false } = {}) {
    if (reusePhone) {
      // 同手机号再登录：先回拨验证码创建时间避开 60s 发送冷却
      await ctx.db.query(`UPDATE sms_codes SET created_at = now() - interval '2 minutes' WHERE phone = $1`, [phone]);
    }
    await fetch(`${base}/auth/sms`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
      body: JSON.stringify({ phone }) });
    const res = await fetch(`${base}/auth/login`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
      body: JSON.stringify({ phone, code: provider.sent.at(-1).code, agreeTerms: true }) });
    assert.equal(res.status, 200);
    const body = await res.json();
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith('miv_sid=')).split(';')[0];
    return { cookie, csrf: body.csrfToken, user: body.user };
  }

  const post = (path, body, opts = {}) => fetch(`${base}${path}`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN,
      ...(opts.cookie ? { Cookie: opts.cookie } : {}), ...(opts.csrf ? { 'X-CSRF-Token': opts.csrf } : {}) },
    body: JSON.stringify(body) });
  const multipart = (path, { cookie, csrf }) => {
    const form = new FormData();
    form.append('file', new Blob([TINY_PNG]), 'photo.png');
    return fetch(`${base}${path}`, { method: 'POST',
      headers: { Cookie: cookie, Origin: ORIGIN, 'X-CSRF-Token': csrf }, body: form });
  };

  before(async () => {
    ctx = await createTestDb();
    provider = captureSmsProvider();
    const app = createApp({ config: loadConfig({ NODE_ENV: 'test' }), db: ctx.db, logger: silentLogger,
      smsProvider: provider, storage: { put: async () => {}, remove: async () => {}, signedUrl: () => undefined } });
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}/api/v1`;
    account = await signUp('15800000777');
  });
  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await ctx.drop();
  });

  const consentRows = (kind) => ctx.db.query(
    `SELECT version, created_at FROM user_consents WHERE user_id = $1 AND kind = $2 ORDER BY created_at, id`,
    [account.user.id, kind]).then((r) => r.rows);

  test('登录 agreeTerms：记 terms 当前版本与 consents.current；同版本重复登录不追加、版本变化追加（建议 d）', async () => {
    assert.equal(account.user.consents.terms, TERMS_VERSION);
    assert.equal(account.user.consents.current.terms, TERMS_VERSION, '复审必改④：current 返回服务端当前版本');
    assert.equal(account.user.consents.current.photo, 'photo-v1');
    assert.equal(account.user.consents.photo, null);
    assert.equal((await consentRows('terms')).length, 1);
    // 第二次登录（同版本）：不追加（建议 d：防表无限增长）
    const again = await signUp('15800000777', { reusePhone: true });
    assert.equal(again.user.consents.terms, TERMS_VERSION);
    assert.equal((await consentRows('terms')).length, 1, '同版本重复登录不追加');
    // 版本升级（模拟）：服务端改版本后登录 → 追加新版本留痕
    await ctx.db.query(`UPDATE user_consents SET version = 'terms-v0' WHERE user_id = $1 AND kind = 'terms'`,
      [account.user.id]);
    const third = await signUp('15800000777', { reusePhone: true });
    assert.equal(third.user.consents.terms, TERMS_VERSION);
    assert.equal((await consentRows('terms')).length, 2, '版本变化时重新追加留痕');
  });

  test('登录未勾选 agreeTerms → 400（不变）', async () => {
    await fetch(`${base}/auth/sms`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
      body: JSON.stringify({ phone: '15800000778' }) });
    const res = await fetch(`${base}/auth/login`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
      body: JSON.stringify({ phone: '15800000778', code: provider.sent.at(-1).code }) });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.code, 'VALIDATION_FAILED');
  });

  test('POST /me/consents：版本不符 400；正确版本写入并返回；重复同意追加（只追加）', async () => {
    let res = await post('/me/consents', { kind: 'photo', version: 'photo-v0' }, account);
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, 'VALIDATION_FAILED');
    res = await post('/me/consents', { kind: 'terms', version: TERMS_VERSION }, account);
    assert.equal(res.status, 400, 'kind 只能是 photo（terms 只随登录记录）');
    res = await post('/me/consents', { kind: 'photo', version: PHOTO_CONSENT_VERSION }, account);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { consents: { terms: TERMS_VERSION, photo: PHOTO_CONSENT_VERSION,
      current: { terms: TERMS_VERSION, photo: PHOTO_CONSENT_VERSION } } });  // 复审必改④：响应含 current
    await post('/me/consents', { kind: 'photo', version: PHOTO_CONSENT_VERSION }, account);
    assert.equal((await consentRows('photo')).length, 2, '重复同意只追加新记录');
  });

  test('上传图片：旧版本视为未同意 403；同意当前版本后 201', async () => {
    // ① 未同意（新用户）
    const fresh = await signUp('15800000779');
    let res = await multipart('/uploads/image', fresh);
    assert.equal(res.status, 403);
    assert.equal((await res.json()).code, 'PHOTO_CONSENT_REQUIRED');
    // ② 版本不一致（直接落一条旧版本记录模拟历史同意）
    await ctx.db.query(
      `INSERT INTO user_consents (id, user_id, kind, version) VALUES ('cns_old0000000001', $1, 'photo', 'photo-v0')`,
      [fresh.user.id]);
    res = await multipart('/uploads/image', fresh);
    assert.equal(res.status, 403, '旧版本 ≠ 当前版本 → 视为未同意');
    // ③ 同意当前版本后成功
    await post('/me/consents', { kind: 'photo', version: PHOTO_CONSENT_VERSION }, fresh);
    res = await multipart('/uploads/image', fresh);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.uploadId);
  });

  test('GET /auth/me 返回 consents', async () => {
    const res = await fetch(`${base}/auth/me`, { headers: { Cookie: account.cookie } });
    const { user } = await res.json();
    assert.equal(user.consents.terms, TERMS_VERSION);
    assert.equal(user.consents.photo, PHOTO_CONSENT_VERSION);
  });
});
