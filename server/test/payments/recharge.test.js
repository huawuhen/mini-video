// M3-PAY-02：充值订单 + 公众号授权 + 支付回调 + 对账（真实 HTTP 栈 + 本地模拟微信网关，
// 零真实费用）。验收对齐 TASKS：重复/并发通知只入账一次；验签/解密/mchid/appid/金额/
// 非 SUCCESS/查单未支付均不入账；过期订单后到的支付仍入账；对账补入账与关单；
// 3 单上限与每小时 10 单限流；下单失败不留 created 订单；无 openid 的 jsapi 409；
// OAuth state 校验与 returnTo 只允许站内路径；账本对账正确。
import assert from 'node:assert/strict';
import { createPublicKey, createVerify, generateKeyPairSync } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { silentLogger } from '../../src/logger.js';
import { createMockWechatPayGateway, encryptResource } from '../../src/payments/mock-gateway.js';
import { createWechatOAuth } from '../../src/payments/wechat-oauth.js';
import { createWechatPayClient, jsapiPaySignMessage } from '../../src/payments/wechat-pay.js';
import { runPaymentsReconcile } from '../../src/payments/recharge.js';
import { createTestDb } from '../helpers/db.js';

const ORIGIN = 'http://localhost:5173';
const MCHID = '1900000002';
const APPID = 'wxpay02mockappid';
const APIV3_KEY = 'pay02mock32byteapiV3key123456789'; // 恰 32 字节
const NOTIFY_URL = 'https://example.com/api/v1/payments/wechat/notify';

function captureSmsProvider() {
  const provider = { sent: [], id: 'test-capture', async send({ phone, code }) { provider.sent.push({ phone, code }); } };
  return provider;
}

const mivCookie = (res) => res.headers.getSetCookie().find((c) => c.startsWith('miv_sid='))?.split(';')[0];

async function signUp(base, provider, phone) {
  await fetch(`${base}/auth/sms`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ phone }) });
  const code = provider.sent.at(-1).code;
  const res = await fetch(`${base}/auth/login`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ phone, code, agreeTerms: true }) });
  assert.equal(res.status, 200);
  return { body: await res.json(), cookie: mivCookie(res) };
}

function authed(base, path, { cookie, csrf, method = 'GET', body, redirect } = {}) {
  const headers = { Cookie: cookie };
  if (body !== undefined) { headers['Content-Type'] = 'application/json'; headers.Origin = ORIGIN; }
  if (method !== 'GET') headers['X-CSRF-Token'] = csrf;
  return fetch(`${base}${path}`, { method, headers, redirect,
    body: body === undefined ? undefined : JSON.stringify(body) });
}

describe('M3-PAY-02：在线充值（微信支付）', () => {
  let ctx;
  let server;
  let base;
  let provider;
  let user;
  let gateway;
  let merchantPublicPem;
  let payments;
  let deps;

  before(async () => {
    ctx = await createTestDb();
    provider = captureSmsProvider();
    const merchant = generateKeyPairSync('rsa', { modulusLength: 2048 });
    merchantPublicPem = merchant.publicKey.export({ type: 'spki', format: 'pem' });
    gateway = createMockWechatPayGateway({ mchid: MCHID, appid: APPID, apiV3Key: APIV3_KEY,
      merchantPublicKeyPem: merchantPublicPem });
    const payClient = createWechatPayClient({ mchid: MCHID, appid: APPID,
      privateKey: merchant.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      certSerial: 'PAY02SERIAL0001', apiV3Key: APIV3_KEY,
      platformPublicKey: gateway.platform.publicKeyPem, platformPublicKeyId: gateway.platform.publicKeyId,
      http: gateway.asHttp() });
    // OAuth 用可注入 http 的真实实现（code 换 openid 走内存桩）
    const oauthCodes = new Map([['good_code', { openid: 'oPay02MockOpenid0001' }]]);
    const oauth = createWechatOAuth({ appid: APPID, secret: 'mp-secret',
      http: async ({ url }) => {
        const code = new URL(url).searchParams.get('code');
        const hit = oauthCodes.get(code);
        return { status: 200, text: async () => JSON.stringify(hit
          ? { openid: hit.openid, scope: 'snsapi_base' }
          : { errcode: 40029, errmsg: 'invalid code' }) };
      } });
    const config = loadConfig({ NODE_ENV: 'test' });
    // 测试库配置冻结为浅层：嵌套 payments/wechatMp 可覆写
    config.payments.mchid = MCHID;
    config.payments.apiV3Key = APIV3_KEY;
    config.payments.notifyUrl = NOTIFY_URL;
    config.payments.webBaseUrl = 'https://example.com';
    config.wechatMp.appid = APPID;
    config.wechatMp.secret = 'mp-secret';
    payments = { payClient, oauth, scenes: ['jsapi', 'native'], appid: APPID, apiV3Key: APIV3_KEY, config };
    deps = { payClient, scenes: payments.scenes, appid: APPID, config, logger: silentLogger };

    const app = createApp({ config, db: ctx.db, logger: silentLogger, smsProvider: provider, payments });
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}/api/v1`;
    const signedUp = await signUp(base, provider, '15800000101');
    user = { ...signedUp, id: signedUp.body.user.id };
  });
  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await ctx.drop();
  });

  const walletFen = async () => (await ctx.db.query(
    `SELECT available_fen FROM wallets WHERE user_id = $1`, [user.id])).rows[0]?.available_fen ?? 0;
  const orderRow = async (id) => (await ctx.db.query(
    `SELECT * FROM payment_orders WHERE id = $1`, [id])).rows[0];
  const rechargeCount = async (id) => (await ctx.db.query(
    `SELECT count(*)::int AS n FROM ledger WHERE idempotency_key = $1`, [`recharge:${id}`])).rows[0].n;

  const postNotify = async (notify) => fetch(`${base}/payments/wechat/notify`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...notify.headers }, body: notify.rawBody });

  // 限流计数是小时窗口、跨用例残留——除限流专项外的用例统一清零（在途 3 单检查不受影响）
  const resetCreateRateLimit = () => ctx.db.query(
    `DELETE FROM rate_counters WHERE key = $1`, [`recharge:create:${user.id}`]);

  const createOrder = async ({ amountFen = 5000, scene = 'native', key = 'idem' } = {}) => {
    const res = await authed(base, '/wallet/recharge', { cookie: user.cookie, csrf: user.body.csrfToken,
      method: 'POST', body: { amountFen, scene, idempotencyKey: `pay02-${key}`.padEnd(8, '0') } });
    return { status: res.status, body: await res.json() };
  };

  test('options：scenes 与 openid 就绪状态', async () => {
    let res = await authed(base, '/wallet/recharge/options', { cookie: user.cookie });
    assert.equal(res.status, 200);
    let body = await res.json();
    assert.deepEqual(body.amountsFen, [5000, 10000, 50000, 100000]);
    assert.deepEqual(body.scenes, ['jsapi', 'native']);
    assert.equal(body.wechatOpenidReady, false);
    await ctx.db.query(`INSERT INTO user_wechat (user_id, appid, openid) VALUES ($1, $2, 'oX')`,
      [user.id, APPID]);
    res = await authed(base, '/wallet/recharge/options', { cookie: user.cookie });
    assert.equal((await res.json()).wechatOpenidReady, true);
    await ctx.db.query(`DELETE FROM user_wechat WHERE user_id = $1`, [user.id]);
  });

  test('native 下单：201 + codeUrl；幂等重放同单；档位外 400；未开通 scene 400', async () => {
    const first = await createOrder({ key: 'nat1' });
    assert.equal(first.status, 201);
    assert.equal(first.body.status, 'created');
    assert.equal(first.body.pay.type, 'native');
    assert.match(first.body.pay.codeUrl, /^weixin:\/\//);
    const replay = await createOrder({ key: 'nat1' });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.id, first.body.id, '同幂等键返回同一订单');
    assert.equal((await ctx.db.query(`SELECT count(*)::int n FROM payment_orders`)).rows[0].n, 1);

    const badAmount = await createOrder({ amountFen: 12345, key: 'badamt' });
    assert.equal(badAmount.status, 400);
    assert.equal(badAmount.body.code, 'VALIDATION_FAILED');
    const badScene = await createOrder({ scene: 'h5', key: 'badscn' });
    assert.equal(badScene.status, 400); // h5 未开通
    assert.equal((await ctx.db.query(`SELECT count(*)::int n FROM payment_orders`)).rows[0].n, 1, '失败请求不留订单');
  });

  test('jsapi：无 openid 409；绑定后成功且 paySign 可用商户公钥独立验证', async () => {
    const no = await createOrder({ scene: 'jsapi', key: 'jsai1' });
    assert.equal(no.status, 409);
    assert.equal(no.body.code, 'WECHAT_OPENID_REQUIRED');
    await ctx.db.query(`INSERT INTO user_wechat (user_id, appid, openid) VALUES ($1, $2, 'oPay02User')`,
      [user.id, APPID]);
    const ok = await createOrder({ scene: 'jsapi', key: 'jsai2' });
    assert.equal(ok.status, 201);
    assert.equal(ok.body.pay.type, 'jsapi');
    const { params } = ok.body.pay;
    assert.equal(params.appId, APPID);
    assert.equal(params.signType, 'RSA');
    const verifier = createVerify('RSA-SHA256');
    verifier.update(jsapiPaySignMessage(params.appId, params.timeStamp, params.nonceStr, params.package));
    assert.ok(verifier.verify(createPublicKey(merchantPublicPem), Buffer.from(params.paySign, 'base64')));
    await ctx.db.query(`DELETE FROM user_wechat WHERE user_id = $1`, [user.id]);
  });

  test('同时 3 单上限与每小时 10 单限流 → 429', async () => {
    await ctx.db.query(`UPDATE payment_orders SET status = 'failed' WHERE status = 'created'`);
    for (const key of ['capA', 'capB']) {
      assert.equal((await createOrder({ key })).status, 201);
    }
    const third = await createOrder({ key: 'capC' });
    assert.equal(third.status, 201);
    const fourth = await createOrder({ key: 'capD' });
    assert.equal(fourth.status, 429, '同时待支付最多 3 笔');
    assert.equal((await ctx.db.query(
      `SELECT count(*)::int n FROM payment_orders WHERE status = 'created'`)).rows[0].n, 3);
    // 每小时 10 单：释放在途后连续创建，直到小时窗口限流触发（此前计数不定，用循环收敛）
    await ctx.db.query(`UPDATE payment_orders SET status = 'failed' WHERE status = 'created'`);
    let rateLimited = null;
    for (let i = 0; i < 15 && !rateLimited; i += 1) {
      const res = await createOrder({ key: `capR${i}` });
      if (res.status === 429) rateLimited = res;
      else assert.equal(res.status, 201, `第 ${i} 次连建应成功（未到小时上限）`);
    }
    assert.ok(rateLimited, '每小时 10 单限流应触发');
    assert.equal(rateLimited.body.message.includes('小时'), true);
    await ctx.db.query(`UPDATE payment_orders SET status = 'failed' WHERE status = 'created'`);
  });

  test('回调正常入账：204、钱包加分、账本 recharge、订单 paid；重复与并发通知只入账一次', async () => {
    await resetCreateRateLimit();
    // 清理在途订单避免上限干扰：直接置 failed（测试便利，生产由对账处理）
    await ctx.db.query(`UPDATE payment_orders SET status = 'failed', updated_at = now() WHERE status = 'created'`);
    const { body: order } = await createOrder({ key: 'ntf1' });
    gateway.simulatePayment(order.id);
    const notify = gateway.buildNotify(order.id);
    let res = await postNotify(notify);
    assert.equal(res.status, 204);
    assert.equal(await walletFen(), 5000, '入账 5000 分');
    assert.equal(await rechargeCount(order.id), 1, '账本恰一笔');
    let row = await orderRow(order.id);
    assert.equal(row.status, 'paid');
    assert.ok(row.transaction_id);
    assert.ok(row.credited_ledger_id);
    // 重复通知：success 但不重复入账
    res = await postNotify(notify);
    assert.equal(res.status, 204);
    assert.equal(await walletFen(), 5000);
    assert.equal(await rechargeCount(order.id), 1);
    assert.equal((await orderRow(order.id)).notify_count, 2);
    // 并发通知
    const concurrent = await Promise.all(Array.from({ length: 8 }, () => postNotify(notify)));
    assert.ok(concurrent.every((r) => r.status === 204));
    assert.equal(await walletFen(), 5000);
    assert.equal(await rechargeCount(order.id), 1, '并发只入账一次');
  });

  test('回调不入账的反例：验签失败 / mchid 不符 / 金额不符 / 非 SUCCESS 事件 / 查单未支付', async () => {
    await resetCreateRateLimit();
    const before = await walletFen();
    // ① 验签失败（body 篡改一字节）
    const { body: o1 } = await createOrder({ key: 'neg1' });
    gateway.simulatePayment(o1.id);
    const n1 = gateway.buildNotify(o1.id);
    let res = await postNotify({ ...n1, rawBody: n1.rawBody + ' ' });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, 'FAIL');
    // ② mchid 不符（手工加密 resource + 合法平台签名）
    const forged = (over) => gateway.signPayload({ id: 'evt_x', resource_type: 'encrypt-resource',
      event_type: 'TRANSACTION.SUCCESS',
      resource: encryptResource(APIV3_KEY, { mchid: MCHID, appid: APPID, out_trade_no: o1.id,
        transaction_id: 'wx_forged', trade_state: 'SUCCESS', amount: { total: 5000 },
        payer: { openid: 'oX' }, ...over }, 'transaction') });
    res = await postNotify(forged({ mchid: '9999999999' }));
    assert.equal(res.status, 400);
    // ③ 金额不符
    res = await postNotify(forged({ amount: { total: 99999 } }));
    assert.equal(res.status, 400);
    // ④ 非 SUCCESS 事件（合法回调、订单未支付）
    const { body: o2 } = await createOrder({ key: 'neg2' });
    const refundNotify = gateway.signPayload({ id: 'evt_r', resource_type: 'encrypt-resource',
      event_type: 'REFUND.SUCCESS',
      resource: encryptResource(APIV3_KEY, { mchid: MCHID, appid: APPID, out_trade_no: o2.id,
        transaction_id: 'x', trade_state: 'CLOSED', amount: { total: 5000 } }, 'transaction') });
    res = await postNotify(refundNotify);
    assert.equal(res.status, 204);
    // ⑤ 查单未支付：通知说 SUCCESS 但网关侧未支付（不 simulatePayment）
    const notPaidNotify = gateway.signPayload({ id: 'evt_np', resource_type: 'encrypt-resource',
      event_type: 'TRANSACTION.SUCCESS',
      resource: encryptResource(APIV3_KEY, { mchid: MCHID, appid: APPID, out_trade_no: o2.id,
        transaction_id: 'wx_np', trade_state: 'SUCCESS', amount: { total: 5000 } }, 'transaction') });
    res = await postNotify(notPaidNotify);
    assert.equal(res.status, 204);
    assert.equal((await orderRow(o2.id)).status, 'created', '查单未支付不入账');
    assert.equal(await walletFen(), before, '所有反例都不入账');
  });

  test('过期订单后到的支付仍入账（status IN created,expired 条件更新）', async () => {
    await resetCreateRateLimit();
    await ctx.db.query(`UPDATE payment_orders SET status = 'failed' WHERE status = 'created'`);
    const { body: order } = await createOrder({ key: 'exp1' });
    await ctx.db.query(
      `UPDATE payment_orders SET expires_at = now() - interval '40 minutes' WHERE id = $1`, [order.id]);
    gateway.simulatePayment(order.id);
    const res = await postNotify(gateway.buildNotify(order.id));
    assert.equal(res.status, 204);
    const row = await orderRow(order.id);
    assert.equal(row.status, 'paid', '过期后到的支付仍入账');
    assert.equal(await walletFen(), 10000);
  });

  test('下单失败：上游 5xx → 502 PAYMENT_UNAVAILABLE 且不留 created 订单', async () => {
    await resetCreateRateLimit();
    await ctx.db.query(`UPDATE payment_orders SET status = 'failed' WHERE status = 'created'`);
    gateway.failNextResponse(500, { code: 'SYSTEM_ERROR', message: '微信侧系统繁忙' });
    const res = await createOrder({ key: 'fail1' });
    assert.equal(res.status, 502);
    assert.equal(res.body.code, 'PAYMENT_UNAVAILABLE');
    assert.equal(res.body.message, '支付通道暂时不可用，请稍后重试', '对用户固定中文（建议 4）');
    assert.equal((await ctx.db.query(
      `SELECT count(*)::int n FROM payment_orders WHERE idempotency_key LIKE '%fail1%'`)).rows[0].n, 0,
    '下单失败不留订单');
  });

  test('订单查询：options 不被当订单号；非 po_ 前缀与他人订单 404；列表 keyset', async () => {
    const res = await authed(base, '/wallet/recharge/options', { cookie: user.cookie });
    assert.equal(res.status, 200, 'options 路由先于 /:orderId');
    assert.equal((await authed(base, '/wallet/recharge/abc', { cookie: user.cookie })).status, 404);
    assert.equal((await authed(base, '/wallet/recharge/po_other', { cookie: user.cookie })).status, 404);
    const list = await (await authed(base, '/wallet/recharge?limit=3', { cookie: user.cookie })).json();
    assert.ok(Array.isArray(list.items) && list.items.length >= 1);
    assert.ok(list.items.every((o) => o.id.startsWith('po_') && !o.pay), '列表不返回支付参数');
  });

  test('对账：已支付补入账；超时未支付关单（微信关单 + 本地 expired）', async () => {
    await resetCreateRateLimit();
    await ctx.db.query(`UPDATE payment_orders SET status = 'failed' WHERE status = 'created'`);
    // ① 已支付但通知丢失 → 补入账
    const { body: paid } = await createOrder({ key: 'rec1' });
    gateway.simulatePayment(paid.id);
    await ctx.db.query(
      `UPDATE payment_orders SET expires_at = now() - interval '40 minutes' WHERE id = $1`, [paid.id]);
    const before = await walletFen();
    let result = await runPaymentsReconcile(ctx.db, deps);
    assert.equal(result.credited, 1);
    assert.equal(await walletFen(), before + 5000);
    assert.equal((await orderRow(paid.id)).status, 'paid');
    // ② 未支付 → 关单
    const { body: unpaid } = await createOrder({ key: 'rec2' });
    await ctx.db.query(
      `UPDATE payment_orders SET expires_at = now() - interval '40 minutes' WHERE id = $1`, [unpaid.id]);
    result = await runPaymentsReconcile(ctx.db, deps);
    assert.equal(result.closed, 1);
    assert.equal((await orderRow(unpaid.id)).status, 'expired');
    assert.equal(gateway.orders.get(unpaid.id).status, 'CLOSED', '微信侧已关单');
    assert.equal(await walletFen(), before + 5000, '关单不入账');
    // 账本对账：钱包余额 === 各笔 recharge 之和
    const totalRecharge = (await ctx.db.query(
      `SELECT COALESCE(SUM(amount_fen), 0)::int AS fen FROM ledger WHERE user_id = $1 AND kind = 'recharge'`,
      [user.id])).rows[0].fen;
    assert.equal(await walletFen(), totalRecharge, '账本对账正确');
  });

  test('对账（合并后必改 a）：微信侧已关闭/撤销/支付失败 → 直接本地置 expired，不调关单', async () => {
    await resetCreateRateLimit();
    await ctx.db.query(`UPDATE payment_orders SET status = 'failed' WHERE status = 'created'`);
    const { body: closedRemote } = await createOrder({ key: 'rca1' });
    await ctx.db.query(
      `UPDATE payment_orders SET expires_at = now() - interval '40 minutes' WHERE id = $1`, [closedRemote.id]);
    // 微信侧已关闭（用户在微信里关掉、或微信超时自动关）：本地查单见 CLOSED
    gateway.orders.get(closedRemote.id).status = 'CLOSED';
    const requestsBefore = gateway.seenRequests.length;
    const result = await runPaymentsReconcile(ctx.db, deps);
    assert.equal(result.closed, 1);
    assert.equal((await orderRow(closedRemote.id)).status, 'expired');
    // 不调关单：网关没有收到任何 close 请求
    assert.ok(gateway.seenRequests.slice(requestsBefore)
      .every((r) => !r.path.includes('/close')), 'CLOSED/REVOKED/PAYERROR 不调关单');
  });

  test('对账（合并后必改 b）：关单 ORDERPAID 保持 created，下一轮查到已支付后入账；其他关单错误仍置 expired', async () => {
    await resetCreateRateLimit();
    await ctx.db.query(`UPDATE payment_orders SET status = 'failed' WHERE status = 'created'`);
    const before = await walletFen();
    // ① 查单 NOTPAY、关单瞬间用户恰好付款（注入 ORDERPAID）→ 保持 created
    const { body: racing } = await createOrder({ key: 'rcb1' });
    await ctx.db.query(
      `UPDATE payment_orders SET expires_at = now() - interval '40 minutes' WHERE id = $1`, [racing.id]);
    gateway.failNextResponse(400, { code: 'ORDERPAID', message: '订单已支付，不能关单' });
    let result = await runPaymentsReconcile(ctx.db, deps);
    assert.equal(result.closed, 0, 'ORDERPAID 不置 expired');
    assert.equal((await orderRow(racing.id)).status, 'created', '保持 created 等下一轮');
    // 用户随后真的支付成功 → 下一轮对账查单 SUCCESS → 入账
    gateway.simulatePayment(racing.id);
    result = await runPaymentsReconcile(ctx.db, deps);
    assert.equal(result.credited, 1);
    assert.equal((await orderRow(racing.id)).status, 'paid');
    assert.equal(await walletFen(), before + 5000);
    // ② 其他关单错误（如长期网络类 SYSTEM_ERROR）→ 记日志后仍置 expired（真付了有通知从 expired 入账兜底）
    const { body: broken } = await createOrder({ key: 'rcb2' });
    await ctx.db.query(
      `UPDATE payment_orders SET expires_at = now() - interval '40 minutes' WHERE id = $1`, [broken.id]);
    gateway.failNextResponse(500, { code: 'SYSTEM_ERROR', message: '微信侧系统繁忙' }, '/close'); // 只拦关单
    result = await runPaymentsReconcile(ctx.db, deps);
    assert.equal((await orderRow(broken.id)).status, 'expired', '非 ORDERPAID 错误不卡 created');
  });

  test('上限（合并后必改 c）：已过期未对账的单不占「同时 3 笔待支付」', async () => {
    await resetCreateRateLimit();
    await ctx.db.query(`UPDATE payment_orders SET status = 'failed' WHERE status = 'created'`);
    // 造 3 笔已过期但未对账（对账卡住时）的单——不占上限
    for (const key of ['stale1', 'stale2', 'stale3']) {
      const { body: order } = await createOrder({ key });
      await ctx.db.query(
        `UPDATE payment_orders SET expires_at = now() - interval '40 minutes' WHERE id = $1`, [order.id]);
    }
    // 新下单仍可进行（3 笔过期单不挡路）
    for (const key of ['fresh1', 'fresh2', 'fresh3']) {
      const res = await createOrder({ key });
      assert.equal(res.status, 201, `过期单不占上限：${key} 应成功`);
    }
    // 第 4 笔新的才触发上限
    const blocked = await createOrder({ key: 'fresh4' });
    assert.equal(blocked.status, 429);
  });

  test('OAuth：start 302 微信授权（returnTo 编码、state）；callback 校验 state 并绑定 openid', async () => {
    // start：returnTo 站内 → 编码进 state；外站 → 回退 /wallet
    let res = await authed(base, '/wechat/oauth/start?returnTo=/wallet/recharge', { cookie: user.cookie, redirect: 'manual' });
    assert.equal(res.status, 302);
    const location = new URL(res.headers.get('location'));
    assert.equal(location.host, 'open.weixin.qq.com');
    assert.equal(location.searchParams.get('appid'), APPID);
    assert.equal(location.searchParams.get('scope'), 'snsapi_base');
    const state = location.searchParams.get('state');
    const redirectUri = location.searchParams.get('redirect_uri');
    assert.equal(decodeURIComponent(redirectUri), 'https://example.com/api/v1/wechat/oauth/callback');
    assert.ok(location.hash === '#wechat_redirect' || res.headers.get('location').endsWith('#wechat_redirect'));

    res = await authed(base, '/wechat/oauth/start?returnTo=https://evil.example', { cookie: user.cookie, redirect: 'manual' });
    const evilState = new URL(res.headers.get('location')).searchParams.get('state');
    // 外站 returnTo 被回退到 /wallet（callback 后验证）

    // callback：state 无效 → 302 回 /wallet 带 wechatAuth=failed（不给 JSON，复审必改 2）
    res = await authed(base, '/wechat/oauth/callback?code=good_code&state=broken', { cookie: user.cookie, redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), 'https://example.com/wallet?wechatAuth=failed');
    // 未登录 → 302 /login?redirect=…（不再 401 JSON）
    res = await authed(base, `/wechat/oauth/callback?code=good_code&state=${encodeURIComponent(state)}`,
      { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.ok(res.headers.get('location').startsWith('/login?redirect='));
    // state 有效 + code 有效 → 绑定 + 302 回 returnTo
    res = await authed(base, `/wechat/oauth/callback?code=good_code&state=${encodeURIComponent(state)}`,
      { cookie: user.cookie, redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), 'https://example.com/wallet/recharge');
    const bound = await ctx.db.query(`SELECT openid FROM user_wechat WHERE user_id = $1`, [user.id]);
    assert.equal(bound.rows[0].openid, 'oPay02MockOpenid0001');
    // 坏 code → 302 returnTo 带 wechatAuth=failed（原因只进日志）
    const state2 = new URL((await authed(base, '/wechat/oauth/start?returnTo=/wallet',
      { cookie: user.cookie, redirect: 'manual' })).headers.get('location')).searchParams.get('state');
    res = await authed(base, `/wechat/oauth/callback?code=bad_code&state=${encodeURIComponent(state2)}`,
      { cookie: user.cookie, redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), 'https://example.com/wallet?wechatAuth=failed');
    // 外站 returnTo 的 state：绑定成功后只回站内（/wallet）
    const state3 = new URL((await authed(base, '/wechat/oauth/start?returnTo=https://evil.example',
      { cookie: user.cookie, redirect: 'manual' })).headers.get('location')).searchParams.get('state');
    res = await authed(base, `/wechat/oauth/callback?code=good_code&state=${encodeURIComponent(state3)}`,
      { cookie: user.cookie, redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), 'https://example.com/wallet', 'returnTo 只允许站内路径');
  });

  test('两个账号绑同一个 openid 都能用 jsapi 下单（openid 不是账号身份，复审必改 1）', async () => {
    await resetCreateRateLimit();
    await ctx.db.query(`UPDATE payment_orders SET status = 'failed' WHERE status = 'created'`);
    // 用户二登录并绑定与 user 相同的 openid
    const second = await signUp(base, provider, '15800000102');
    await ctx.db.query(
      `INSERT INTO user_wechat (user_id, appid, openid) VALUES ($1, $2, 'oSharedOpenid0001'),
       ($3, $2, 'oSharedOpenid0001') ON CONFLICT (user_id) DO UPDATE SET appid = $2, openid = 'oSharedOpenid0001'`,
      [user.id, APPID, second.body.user.id]);
    for (const [label, account] of [['用户一', user], ['用户二', second]]) {
      await resetCreateRateLimit();
      const res = await authed(base, '/wallet/recharge', { cookie: account.cookie,
        csrf: account.body.csrfToken, method: 'POST',
        body: { amountFen: 5000, scene: 'jsapi', idempotencyKey: `pay02-share-${label}` } });
      assert.equal(res.status, 201, `${label} 用同一 openid 下单应成功`);
      const body = await res.json();
      assert.equal(body.pay.type, 'jsapi');
      assert.ok(body.pay.params.paySign);
    }
  });

  test('GET 轮询兜底：created 超 10 秒时主动查单，已支付就地入账（建议 7）', async () => {
    await resetCreateRateLimit();
    await ctx.db.query(`UPDATE payment_orders SET status = 'failed' WHERE status = 'created'`);
    const { body: order } = await createOrder({ key: 'poll1' });
    const before = await walletFen();
    // 刚下单（<10s）：GET 不查单，仍 created
    let detail = await (await authed(base, `/wallet/recharge/${order.id}`, { cookie: user.cookie })).json();
    assert.equal(detail.status, 'created');
    // 模拟支付（不发通知）+ 时间倒退 11 秒 → GET 主动查单并入账
    gateway.simulatePayment(order.id);
    await ctx.db.query(
      `UPDATE payment_orders SET created_at = now() - interval '11 seconds' WHERE id = $1`, [order.id]);
    detail = await (await authed(base, `/wallet/recharge/${order.id}`, { cookie: user.cookie })).json();
    assert.equal(detail.status, 'paid', '回调丢失时 GET 轮询也能拿到 paid');
    assert.equal(await walletFen(), before + 5000);
    assert.ok(detail.wallet, 'paid 附带最新钱包');
  });

  test('未配置支付（scenes=[]）→ options 空、下单 502；回调 503', async () => {
    await resetCreateRateLimit();
    const { body: order } = await createOrder({ key: 'off1' }); // 先建一单供回调测试
    const disabled = { payClient: null, oauth: null, scenes: [], appid: APPID, apiV3Key: APIV3_KEY,
      config: payments.config, logger: silentLogger };
    const cfg = loadConfig({ NODE_ENV: 'test' });
    const app2 = createApp({ config: cfg, db: ctx.db, logger: silentLogger, smsProvider: provider,
      payments: disabled });
    const server2 = app2.listen(0, '127.0.0.1');
    await new Promise((resolve) => server2.once('listening', resolve));
    const base2 = `http://127.0.0.1:${server2.address().port}/api/v1`;
    try {
      const options = await (await authed(base2, '/wallet/recharge/options', { cookie: user.cookie })).json();
      assert.deepEqual(options.scenes, []);
      const res = await authed(base2, '/wallet/recharge', { cookie: user.cookie, csrf: user.body.csrfToken,
        method: 'POST', body: { amountFen: 5000, scene: 'native', idempotencyKey: 'pay02-off1000' } });
      assert.equal(res.status, 502);
      assert.equal((await res.json()).code, 'PAYMENT_UNAVAILABLE');
      gateway.simulatePayment(order.id);
      const notify = gateway.buildNotify(order.id);
      const nres = await fetch(`${base2}/payments/wechat/notify`, { method: 'POST',
        headers: { 'Content-Type': 'application/json', ...notify.headers }, body: notify.rawBody });
      assert.equal(nres.status, 503);
      assert.equal((await orderRow(order.id)).status, 'created', '未配置时回调不入账');
    } finally {
      await new Promise((resolve) => server2.close(resolve));
    }
  });
});
