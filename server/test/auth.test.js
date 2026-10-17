import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { silentLogger } from '../src/logger.js';
import { createTestDb } from './helpers/db.js';

const ORIGIN = 'http://localhost:5173';

/** 可注入的模拟短信 provider：记录每次发送（测试直接读验证码），可模拟网关故障。 */
function captureSmsProvider() {
  const provider = {
    sent: [],
    id: 'test-capture',
    failNext: false,
    async send({ phone, code }) {
      if (provider.failNext) {
        provider.failNext = false;
        throw new Error('模拟短信网关故障');
      }
      provider.sent.push({ phone, code });
    },
  };
  return provider;
}

function request(base, method, path, { body, cookie, csrf, origin = ORIGIN } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  if (csrf) headers['X-CSRF-Token'] = csrf;
  if (origin) headers.Origin = origin;
  return fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

const post = (base, path, body, opts) => request(base, 'POST', path, { body, ...opts });
const patch = (base, path, body, opts) => request(base, 'PATCH', path, { body, ...opts });

const mivCookie = (res) => res.headers.getSetCookie().find((c) => c.startsWith('miv_sid='))?.split(';')[0];
const backdateSms = (ctx, phone, seconds) =>
  ctx.db.query(`UPDATE sms_codes SET created_at = created_at - ($2 || ' seconds')::interval WHERE phone = $1`, [phone, String(seconds)]);

/** 走完「发码 → 登录」，返回登录响应体与会话 Cookie。 */
async function signUp(base, provider, phone) {
  await post(base, '/auth/sms', { phone });
  const code = provider.sent.at(-1).code;
  const res = await post(base, '/auth/login', { phone, code, agreeTerms: true });
  assert.equal(res.status, 200);
  return { body: await res.json(), cookie: mivCookie(res) };
}

describe('auth（M1-BE-01）', () => {
  let ctx;
  let server;
  let base;
  let provider;
  let limited; // 独立限流配置的第二个 app
  let limitedBase;
  let limitedServer;

  before(async () => {
    ctx = await createTestDb();
    provider = captureSmsProvider();
    const app = createApp({ config: loadConfig({ NODE_ENV: 'test' }), db: ctx.db, logger: silentLogger, urlFor: (key) => `https://cdn.test/${key}`, smsProvider: provider });
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}/api/v1`;

    limited = createApp({
      config: loadConfig({ NODE_ENV: 'test', SMS_MAX_PER_PHONE_PER_DAY: '2', SMS_SEND_COOLDOWN_SECONDS: '0' }),
      db: ctx.db,
      logger: silentLogger,
      smsProvider: captureSmsProvider(),
    });
    limitedServer = limited.listen(0, '127.0.0.1');
    await new Promise((resolve) => limitedServer.once('listening', resolve));
    limitedBase = `http://127.0.0.1:${limitedServer.address().port}/api/v1`;
  });
  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => limitedServer.close(resolve));
    await ctx.drop();
  });

  test('未登录访问受保护接口返回 401 UNAUTHENTICATED', async () => {
    for (const [method, path] of [['GET', '/auth/me'], ['POST', '/auth/logout'], ['PATCH', '/me/onboarding']]) {
      const res = await request(base, method, path, { body: method === 'GET' ? undefined : {} });
      assert.equal(res.status, 401);
      assert.equal((await res.json()).code, 'UNAUTHENTICATED');
    }
    // 无效会话 Cookie 等同未登录
    const bad = await request(base, 'GET', '/auth/me', { cookie: 'miv_sid=not-a-real-token' });
    assert.equal(bad.status, 401);
  });

  test('生产环境禁止 console 短信 provider', () => {
    assert.throws(
      () => loadConfig({ NODE_ENV: 'production', DATABASE_URL: 'postgres://x/y', ALLOWED_ORIGINS: 'https://miv.example', SMS_PROVIDER: 'console' }),
      /短信/,
    );
  });

  test('POST /auth/sms：手机号格式错误 400', async () => {
    const res = await post(base, '/auth/sms', { phone: '12345' });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.code, 'VALIDATION_FAILED');
    assert.ok(body.details.fields.phone);
  });

  test('POST /auth/sms：发送成功，返回冷却秒数，provider 收到 6 位验证码', async () => {
    const res = await post(base, '/auth/sms', { phone: '13800000001' });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { cooldownSeconds: 60 });
    assert.match(provider.sent.at(-1).code, /^\d{6}$/);
  });

  test('冷却期内重发返回 429 SMS_COOLDOWN（含 retryAfterSeconds）', async () => {
    const res = await post(base, '/auth/sms', { phone: '13800000001' });
    assert.equal(res.status, 429);
    const body = await res.json();
    assert.equal(body.code, 'SMS_COOLDOWN');
    assert.ok(body.details.retryAfterSeconds >= 1 && body.details.retryAfterSeconds <= 60);
  });

  test('冷却过后可重发，且旧验证码作废', async () => {
    const phone = '13800000002';
    await post(base, '/auth/sms', { phone });
    const oldCode = provider.sent.at(-1).code;
    await backdateSms(ctx, phone, 61);
    const resent = await post(base, '/auth/sms', { phone });
    assert.equal(resent.status, 200);
    const newCode = provider.sent.at(-1).code;
    assert.notEqual(newCode, oldCode);

    const withOld = await post(base, '/auth/login', { phone, code: oldCode, agreeTerms: true });
    assert.equal(withOld.status, 400);
    assert.equal((await withOld.json()).code, 'SMS_CODE_INVALID');
  });

  test('登录成功（新用户）：tourCompletedAt=null、csrfToken、Cookie 属性齐全', async () => {
    const phone = '13800000003';
    await post(base, '/auth/sms', { phone });
    const code = provider.sent.at(-1).code;
    const res = await post(base, '/auth/login', { phone, code, agreeTerms: true });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.isNewUser, true);
    assert.match(body.user.id, /^usr_/);
    assert.equal(body.user.phoneMasked, '138****0003');
    assert.ok(body.user.nickname);
    assert.equal(body.user.onboarding.tourCompletedAt, null);
    assert.deepEqual(body.user.onboarding.tipsSeen, []);
    assert.ok(body.csrfToken.length >= 32);

    const cookie = res.headers.getSetCookie().find((c) => c.startsWith('miv_sid='));
    assert.ok(cookie, '应下发会话 Cookie');
    assert.ok(cookie.includes('HttpOnly'));
    assert.ok(cookie.includes('SameSite=Lax'));
    assert.ok(cookie.includes('Path=/'));
    assert.ok(!cookie.includes('Secure'), '测试环境非 HTTPS，不应有 Secure');
  });

  test('登录参数：未同意协议 400、坏手机号 400', async () => {
    await post(base, '/auth/sms', { phone: '13800000004' });
    const noAgree = await post(base, '/auth/login', { phone: '13800000004', code: '000000' });
    assert.equal(noAgree.status, 400);
    assert.ok((await noAgree.json()).details.fields.agreeTerms);
    const badPhone = await post(base, '/auth/login', { phone: '999', code: '000000', agreeTerms: true });
    assert.equal(badPhone.status, 400);
    assert.ok((await badPhone.json()).details.fields.phone);
  });

  test('验证码连续错 5 次后作废，正确码也无法登录', async () => {
    const phone = '13800000005';
    await post(base, '/auth/sms', { phone });
    const code = provider.sent.at(-1).code;
    for (let i = 0; i < 5; i += 1) {
      const res = await post(base, '/auth/login', { phone, code: '000000', agreeTerms: true });
      assert.equal(res.status, 400);
      assert.equal((await res.json()).code, 'SMS_CODE_INVALID');
    }
    const withRight = await post(base, '/auth/login', { phone, code, agreeTerms: true });
    assert.equal(withRight.status, 400);
    assert.equal((await withRight.json()).code, 'SMS_CODE_INVALID');
  });

  test('过期验证码不能登录', async () => {
    const phone = '13800000006';
    await post(base, '/auth/sms', { phone });
    const code = provider.sent.at(-1).code;
    await ctx.db.query(`UPDATE sms_codes SET expires_at = now() - interval '1 second' WHERE phone = $1`, [phone]);
    const res = await post(base, '/auth/login', { phone, code, agreeTerms: true });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, 'SMS_CODE_INVALID');
  });

  test('同一手机号再次登录 isNewUser=false，两个会话并存', async () => {
    const phone = '13800000007';
    const first = await signUp(base, provider, phone);
    assert.equal(first.body.isNewUser, true);
    await backdateSms(ctx, phone, 61);
    const second = await signUp(base, provider, phone);
    assert.equal(second.body.isNewUser, false);
    assert.equal(second.body.user.id, first.body.user.id);
    // 旧会话仍然有效
    const me = await request(base, 'GET', '/auth/me', { cookie: first.cookie });
    assert.equal(me.status, 200);
  });

  test('GET /auth/me 返回会话用户与 csrfToken', async () => {
    const phone = '13800000008';
    const { body, cookie } = await signUp(base, provider, phone);
    const res = await request(base, 'GET', '/auth/me', { cookie });
    assert.equal(res.status, 200);
    const me = await res.json();
    assert.equal(me.user.id, body.user.id);
    assert.equal(me.csrfToken, body.csrfToken);
    assert.equal(me.user.onboarding.tourCompletedAt, null);
  });

  test('写请求缺 CSRF token 或 token 错误返回 403', async () => {
    const phone = '13800000009';
    const { cookie, body } = await signUp(base, provider, phone);
    const missing = await patch(base, '/me/onboarding', { tourCompleted: true }, { cookie });
    assert.equal(missing.status, 403);
    assert.equal((await missing.json()).code, 'CSRF_INVALID');
    const wrong = await patch(base, '/me/onboarding', { tourCompleted: true }, { cookie, csrf: 'wrong-token' });
    assert.equal(wrong.status, 403);
    // GET 不需要 CSRF
    const get = await request(base, 'GET', '/auth/me', { cookie });
    assert.equal(get.status, 200);
    assert.ok(body.csrfToken);
  });

  test('Origin 不在白名单的写请求返回 403（无论是否登录）', async () => {
    const evil = 'https://evil.example';
    const sms = await post(base, '/auth/sms', { phone: '13800000010' }, { origin: evil });
    assert.equal(sms.status, 403);
    assert.equal((await sms.json()).code, 'CSRF_INVALID');

    const phone = '13800000011';
    const { cookie, body } = await signUp(base, provider, phone);
    const patchRes = await patch(base, '/me/onboarding', { tourCompleted: true }, { cookie, csrf: body.csrfToken, origin: evil });
    assert.equal(patchRes.status, 403);
    assert.equal((await patchRes.json()).code, 'CSRF_INVALID');
  });

  test('PATCH /me/onboarding：完成引导写入时间且幂等', async () => {
    const phone = '13800000012';
    const { cookie, body } = await signUp(base, provider, phone);
    const res = await patch(base, '/me/onboarding', { tourCompleted: true }, { cookie, csrf: body.csrfToken });
    assert.equal(res.status, 200);
    const first = (await res.json()).onboarding;
    assert.match(first.tourCompletedAt, /^\d{4}-\d{2}-\d{2}T/);
    const again = await patch(base, '/me/onboarding', { tourCompleted: true }, { cookie, csrf: body.csrfToken });
    assert.equal((await again.json()).onboarding.tourCompletedAt, first.tourCompletedAt, '重复完成不覆盖首次时间');
  });

  test('PATCH /me/onboarding：tipSeen 追加且去重', async () => {
    const phone = '13800000013';
    const { cookie, body } = await signUp(base, provider, phone);
    const patchTip = (tip) => patch(base, '/me/onboarding', { tipSeen: tip }, { cookie, csrf: body.csrfToken });
    assert.equal((await patchTip('story_review')).status, 200);
    assert.equal((await patchTip('delivery')).status, 200);
    const dup = await patchTip('story_review');
    assert.deepEqual((await dup.json()).onboarding.tipsSeen, ['story_review', 'delivery']);
    // me 接口也能读到
    const me = await request(base, 'GET', '/auth/me', { cookie });
    assert.deepEqual((await me.json()).user.onboarding.tipsSeen, ['story_review', 'delivery']);
  });

  test('PATCH /me/onboarding：参数校验', async () => {
    const phone = '13800000014';
    const { cookie, body } = await signUp(base, provider, phone);
    const badKey = await patch(base, '/me/onboarding', { tipSeen: 'unknown_tip' }, { cookie, csrf: body.csrfToken });
    assert.equal(badKey.status, 400);
    assert.ok((await badKey.json()).details.fields.tipSeen);
    const empty = await patch(base, '/me/onboarding', {}, { cookie, csrf: body.csrfToken });
    assert.equal(empty.status, 400);
    const wrongType = await patch(base, '/me/onboarding', { tourCompleted: false }, { cookie, csrf: body.csrfToken });
    assert.equal(wrongType.status, 400);
  });

  test('logout 后会话失效并清除 Cookie', async () => {
    const phone = '13800000015';
    const { cookie, body } = await signUp(base, provider, phone);
    const res = await post(base, '/auth/logout', undefined, { cookie, csrf: body.csrfToken });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    const cleared = res.headers.getSetCookie().find((c) => c.startsWith('miv_sid='));
    assert.ok(cleared && /Expires=Thu, 01 Jan 1970|Max-Age=0/.test(cleared), '应下发清除 Cookie');
    const me = await request(base, 'GET', '/auth/me', { cookie });
    assert.equal(me.status, 401);
  });

  test('无 Origin 头的写请求放行（非浏览器客户端）', async () => {
    const phone = '13800000016';
    const sms = await post(base, '/auth/sms', { phone }, { origin: undefined });
    assert.equal(sms.status, 200);
    const code = provider.sent.at(-1).code;
    const login = await post(base, '/auth/login', { phone, code, agreeTerms: true }, { origin: undefined });
    assert.equal(login.status, 200);
    assert.ok((await login.json()).csrfToken);
  });

  test('provider 发送失败返回 502，不占冷却可立即重试', async () => {
    const phone = '13800000017';
    provider.failNext = true;
    const failed = await post(base, '/auth/sms', { phone });
    assert.equal(failed.status, 502);
    assert.equal((await failed.json()).code, 'UPSTREAM_FAILED');
    assert.ok(!provider.sent.some((s) => s.phone === phone), '失败的发送不应记录');
    const retry = await post(base, '/auth/sms', { phone });
    assert.equal(retry.status, 200, '发送失败不应触发冷却');
  });

  test('独立限流配置：单手机号每日发送上限', async () => {
    const phone = '13900000001';
    assert.equal((await post(limitedBase, '/auth/sms', { phone })).status, 200);
    assert.equal((await post(limitedBase, '/auth/sms', { phone })).status, 200);
    const third = await post(limitedBase, '/auth/sms', { phone });
    assert.equal(third.status, 429);
    assert.equal((await third.json()).code, 'RATE_LIMITED');
  });

  test('独立限流配置：单手机号登录尝试上限', async () => {
    const phone = '13900000002';
    await post(limitedBase, '/auth/sms', { phone });
    let last;
    for (let i = 0; i <= 20; i += 1) {
      last = await post(limitedBase, '/auth/login', { phone, code: '000000', agreeTerms: true });
    }
    // 前 20 次是验证码错误，第 21 次被限流拦截
    assert.equal(last.status, 429);
    assert.equal((await last.json()).code, 'RATE_LIMITED');
  });
});
