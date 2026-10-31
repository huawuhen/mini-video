// M3-PAY-01：微信支付 APIv3 客户端（签名/验签/AES-GCM/三种下单/调起参数/查单/关单/退款/回调）
// 全程本地生成的 RSA 密钥对 + 本地模拟网关回环，零真实费用、零网络。
import assert from 'node:assert/strict';
import { createPublicKey, createSign, createVerify, generateKeyPairSync, randomBytes } from 'node:crypto';
import { describe, test } from 'node:test';
import {
  createWechatPayClient, decryptResource, jsapiPaySignMessage,
  requestSignMessage, responseSignMessage, wechatPayTime, WechatPayError,
} from '../../src/payments/wechat-pay.js';
import { createMockWechatPayGateway, encryptResource } from '../../src/payments/mock-gateway.js';

const MCHID = '1900000001';
const APPID = 'wx1234567890abcdef';
const APIV3_KEY = 'mock32byteapiV3key1234567890abcd'; // 恰 32 字节（AES-256 要求）
const CERT_SERIAL = 'MOCKMERCHANTCERTSERIAL00001';

function setup({ gatewayNow = () => Date.now(), clientNow = () => Date.now() } = {}) {
  const merchant = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const gateway = createMockWechatPayGateway({
    mchid: MCHID, appid: APPID, apiV3Key: APIV3_KEY,
    merchantPublicKeyPem: merchant.publicKey.export({ type: 'spki', format: 'pem' }),
    now: gatewayNow,
  });
  const client = createWechatPayClient({
    baseUrl: 'https://api.mch.weixin.qq.com', // 走 asHttp 回环，URL 不会被真正访问
    mchid: MCHID, appid: APPID,
    privateKey: merchant.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    certSerial: CERT_SERIAL,
    apiV3Key: APIV3_KEY,
    platformPublicKey: gateway.platform.publicKeyPem,
    platformPublicKeyId: gateway.platform.publicKeyId,
    http: gateway.asHttp(),
    now: clientNow,
  });
  return { gateway, client, merchant };
}

describe('待签名串格式（官方规则精确断言）', () => {
  test('请求：METHOD\\nPATH\\nTIMESTAMP\\nNONCE\\nBODY\\n', () => {
    assert.equal(requestSignMessage('POST', '/v3/pay/transactions/jsapi', '1700000000', 'abc', '{"a":1}'),
      'POST\n/v3/pay/transactions/jsapi\n1700000000\nabc\n{"a":1}\n');
    assert.equal(requestSignMessage('GET', '/v3/x?mchid=1', '1', 'n', ''),
      'GET\n/v3/x?mchid=1\n1\nn\n\n', 'GET 无 body 也保留空串与末尾换行');
  });
  test('应答/回调：TIMESTAMP\\nNONCE\\nBODY\\n', () => {
    assert.equal(responseSignMessage('1700000000', 'abc', '{"ok":1}'), '1700000000\nabc\n{"ok":1}\n');
  });
  test('JSAPI 调起参数：appId\\ntimeStamp\\nnonceStr\\npackage\\n', () => {
    assert.equal(jsapiPaySignMessage('wx1', '1700000000', 'n', 'prepay_id=x'),
      'wx1\n1700000000\nn\nprepay_id=x\n');
  });
});

describe('客户端 ↔ 模拟网关闭环', () => {
  test('三种下单 + 金额整数分直达（amount.total 原样）', async () => {
    const { gateway, client } = setup();
    const jsapi = await client.jsapi({ description: '余额充值', outTradeNo: 'po_t1', amountFen: 5000,
      openid: 'oMockOpenid', notifyUrl: 'https://example.com/api/v1/payments/wechat/notify' });
    assert.match(jsapi.prepayId, /^prepay_/);
    const h5 = await client.h5({ description: '余额充值', outTradeNo: 'po_t2', amountFen: 10000,
      clientIp: '203.0.113.9', notifyUrl: 'https://example.com/notify' });
    assert.match(h5.h5Url, /^https:\/\/pay\.tenpay\.com\/h5\/mock\//);
    const native = await client.native({ description: '余额充值', outTradeNo: 'po_t3', amountFen: 50000,
      notifyUrl: 'https://example.com/notify' });
    assert.match(native.codeUrl, /^weixin:\/\/wxpay\/mock\//);
    // 金额全程整数分：发往网关的 body 原样保留整数
    const bodies = gateway.seenRequests.map((r) => JSON.parse(r.body));
    assert.deepEqual(bodies.map((b) => b.amount.total), [5000, 10000, 50000]);
    // 网关侧订单入库
    assert.equal(gateway.orders.get('po_t1').amountFen, 5000);
  });

  test('非整数/非正金额在客户端即拒绝（不发起请求）', async () => {
    const { gateway, client } = setup();
    for (const bad of [50.5, 0, -1, '5000', NaN]) {
      await assert.rejects(() => client.jsapi({ description: 'x', outTradeNo: `po_bad_${bad}`,
        amountFen: bad, openid: 'o', notifyUrl: 'https://e/n' }),
        (err) => err instanceof WechatPayError && err.code === 'AMOUNT_INVALID');
    }
    assert.equal(gateway.seenRequests.length, 0, '金额非法不允许发请求');
  });

  test('商户签名错误 → 网关 401 SIGN_ERROR（Authorization 待签名串与请求一致才放行）', async () => {
    const merchant = generateKeyPairSync('rsa', { modulusLength: 2048 });
    // 网关持有的商户公钥与客户端私钥不配对 → 必然验签失败
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const gateway = createMockWechatPayGateway({ mchid: MCHID, appid: APPID, apiV3Key: APIV3_KEY,
      merchantPublicKeyPem: other.publicKey.export({ type: 'spki', format: 'pem' }) });
    const client = createWechatPayClient({ mchid: MCHID, appid: APPID,
      privateKey: merchant.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      certSerial: CERT_SERIAL, apiV3Key: APIV3_KEY,
      platformPublicKey: gateway.platform.publicKeyPem, platformPublicKeyId: gateway.platform.publicKeyId,
      http: gateway.asHttp() });
    await assert.rejects(() => client.native({ description: 'x', outTradeNo: 'po_sign', amountFen: 100,
      notifyUrl: 'https://e/n' }),
    (err) => err instanceof WechatPayError && err.code === 'SIGN_ERROR');
  });

  test('查单 / 关单 / 退款全链路', async () => {
    const { gateway, client } = setup();
    await client.native({ description: '余额充值', outTradeNo: 'po_q1', amountFen: 3000, notifyUrl: 'https://e/n' });
    let tx = await client.query('po_q1');
    assert.equal(tx.trade_state, 'NOTPAY');
    assert.equal(tx.amount.total, 3000);

    gateway.simulatePayment('po_q1'); // 模拟用户扫码支付
    tx = await client.query('po_q1');
    assert.equal(tx.trade_state, 'SUCCESS');
    assert.ok(tx.transaction_id);
    assert.equal(tx.amount.total, 3000);

    const refund = await client.refund({ outTradeNo: 'po_q1', outRefundNo: 'ref_0001',
      refundFen: 1000, totalFen: 3000, reason: '测试退款' });
    assert.equal(refund.status, 'SUCCESS');
    assert.equal(refund.amount.refund, 1000);

    await client.native({ description: '余额充值', outTradeNo: 'po_q2', amountFen: 100, notifyUrl: 'https://e/n' });
    assert.equal(await client.close('po_q2'), null); // 204 无 body
    assert.equal((await client.query('po_q2')).trade_state, 'CLOSED');
    // 已支付订单不能关
    await assert.rejects(() => client.close('po_q1'),
      (err) => err instanceof WechatPayError && err.code === 'TRADE_STATE_ERROR');
  });

  test('JSAPI 调起参数：字段齐全，paySign 可用商户公钥独立验证', async () => {
    const { client, merchant } = setup();
    const { prepayId } = await client.jsapi({ description: '余额充值', outTradeNo: 'po_p1',
      amountFen: 5000, openid: 'oMockOpenid', notifyUrl: 'https://e/n' });
    const params = client.jsapiPayParams(prepayId);
    assert.equal(params.appId, APPID);
    assert.equal(params.package, `prepay_id=${prepayId}`);
    assert.equal(params.signType, 'RSA');
    assert.match(params.timeStamp, /^\d{10}$/);
    // 前端调起签名的独立复验（微信侧用商户公钥做同样校验）
    const verifier = createVerify('RSA-SHA256');
    verifier.update(jsapiPaySignMessage(params.appId, params.timeStamp, params.nonceStr, params.package));
    assert.ok(verifier.verify(createPublicKey(merchant.publicKey.export({ type: 'spki', format: 'pem' })),
      Buffer.from(params.paySign, 'base64')), 'paySign 必须能用商户公钥验过');
  });

  test('上游 5xx / 参数错误按错误码抛出，不吞', async () => {
    const { gateway, client } = setup();
    gateway.failNextResponse(500, { code: 'SYSTEM_ERROR', message: '微信侧系统繁忙' });
    await assert.rejects(() => client.native({ description: 'x', outTradeNo: 'po_e1', amountFen: 100,
      notifyUrl: 'https://e/n' }),
    (err) => err instanceof WechatPayError && err.code === 'SYSTEM_ERROR');
    gateway.failNextResponse(400, { code: 'PARAM_ERROR', message: '缺少 notify_url' });
    await assert.rejects(() => client.native({ description: 'x', outTradeNo: 'po_e2', amountFen: 100,
      notifyUrl: 'https://e/n' }),
    (err) => err instanceof WechatPayError && err.code === 'PARAM_ERROR');
  });

  test('time_expire：北京时间无毫秒 +08:00（复审必改 1）', async () => {
    const { gateway, client } = setup();
    // 格式化：UTC→北京 +8；跨日；无毫秒
    assert.equal(wechatPayTime(new Date('2026-11-01T03:00:00.000Z')), '2026-11-01T11:00:00+08:00');
    assert.equal(wechatPayTime(new Date('2026-11-01T18:30:45.123Z')), '2026-11-02T02:30:45+08:00');
    assert.throws(() => wechatPayTime('not-a-date'), (err) => err.code === 'TIME_EXPIRE_INVALID');
    // 客户端带 expiresAt 下单：网关按官方格式校验通过
    await client.native({ description: '余额充值', outTradeNo: 'po_te1', amountFen: 100,
      notifyUrl: 'https://e/n', expiresAt: new Date(Date.now() + 30 * 60 * 1000) });
    const sent = JSON.parse(gateway.seenRequests.at(-1).body);
    assert.match(sent.time_expire, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/,
      `发出的 time_expire 必须是官方格式：${sent.time_expire}`);
  });

  test('网关对非法 time_expire 回 400 PARAM_ERROR（手工签名直打网关）', async () => {
    const { gateway, merchant } = setup();
    const privateKeyPem = merchant.privateKey.export({ type: 'pkcs8', format: 'pem' });
    const PATH = '/v3/pay/transactions/native';
    const signedRequest = (body) => {
      const timestamp = String(Math.floor(Date.now() / 1000));
      const nonce = randomBytes(16).toString('hex');
      const signer = createSign('RSA-SHA256');
      signer.update(requestSignMessage('POST', PATH, timestamp, nonce, body));
      return gateway.asHttp()({
        method: 'POST', url: `https://api.mch.weixin.qq.com${PATH}`,
        headers: { Authorization: `WECHATPAY2-SHA256-RSA2048 mchid="${MCHID}",nonce_str="${nonce}",`
          + `signature="${signer.sign(privateKeyPem, 'base64')}",timestamp="${timestamp}",serial_no="${CERT_SERIAL}"` },
        body,
      });
    };
    const base = { appid: APPID, mchid: MCHID, description: 'x', out_trade_no: 'po_bad_te',
      notify_url: 'https://e/n', amount: { total: 100, currency: 'CNY' } };
    // 旧实现（toISOString：毫秒 + Z 后缀）→ 网关按官方格式校验拒绝
    const bad = await signedRequest(JSON.stringify({ ...base, time_expire: new Date().toISOString() }));
    assert.equal(bad.status, 400);
    assert.equal(JSON.parse(await bad.text()).code, 'PARAM_ERROR');
    // 官方格式（北京时间无毫秒）→ 通过
    const good = await signedRequest(JSON.stringify(
      { ...base, time_expire: wechatPayTime(new Date(Date.now() + 30 * 60 * 1000)) }));
    assert.equal(good.status, 200);
  });
});

describe('回调通知：验签 + AES-256-GCM 解密', () => {
  test('正常回调：验签通过、resource 解密出交易对象', async () => {
    const { gateway, client } = setup();
    await client.jsapi({ description: '余额充值', outTradeNo: 'po_n1', amountFen: 5000,
      openid: 'oMockOpenid', notifyUrl: 'https://e/n' });
    gateway.simulatePayment('po_n1');
    const notify = gateway.buildNotify('po_n1');
    const parsed = client.verifyAndDecryptNotify(notify);
    assert.equal(parsed.event_type, 'TRANSACTION.SUCCESS');
    assert.equal(parsed.decrypted.out_trade_no, 'po_n1');
    assert.equal(parsed.decrypted.trade_state, 'SUCCESS');
    assert.equal(parsed.decrypted.amount.total, 5000);
    assert.equal(parsed.decrypted.mchid, MCHID);
    assert.equal(parsed.decrypted.appid, APPID);
    assert.equal(parsed.decrypted.payer.openid, 'oMockOpenid');
  });

  test('原始请求体被篡改一个字节 → 验签拒绝', async () => {
    const { gateway, client } = setup();
    await client.jsapi({ description: '余额充值', outTradeNo: 'po_n2', amountFen: 5000,
      openid: 'oMockOpenid', notifyUrl: 'https://e/n' });
    gateway.simulatePayment('po_n2');
    const notify = gateway.buildNotify('po_n2');
    assert.throws(() => client.verifyAndDecryptNotify({ ...notify, rawBody: notify.rawBody + ' ' }),
      (err) => err.code === 'SIGNATURE_INVALID');
  });

  test('平台公钥序列号不符 → 拒绝（serial 不参与签名，专测比对）', async () => {
    const { gateway, client } = setup();
    await client.jsapi({ description: '余额充值', outTradeNo: 'po_n3', amountFen: 5000,
      openid: 'oMockOpenid', notifyUrl: 'https://e/n' });
    gateway.simulatePayment('po_n3');
    const notify = gateway.buildNotify('po_n3');
    assert.throws(() => client.verifyAndDecryptNotify({
      ...notify, headers: { ...notify.headers, 'wechatpay-serial': 'PUB_KEY_ID_OTHER_0000000000001' } }),
    (err) => err.code === 'SIGNATURE_SERIAL_MISMATCH');
  });

  test('时间戳超出 5 分钟容差 → 拒绝（网关时钟比客户端慢 10 分钟）', async () => {
    const { gateway, client } = setup({
      gatewayNow: () => Date.now() - 10 * 60 * 1000,
      clientNow: () => Date.now(),
    });
    // 不经客户端下单（慢时钟网关的应答签名同样超差）；直接网关侧造单再模拟支付
    gateway.orders.set('po_n4', { outTradeNo: 'po_n4', amountFen: 5000, openid: 'oMockOpenid',
      status: 'NOTPAY', transactionId: null, tradeType: 'JSAPI', clientIp: null });
    gateway.simulatePayment('po_n4');
    const notify = gateway.buildNotify('po_n4');
    assert.throws(() => client.verifyAndDecryptNotify(notify),
      (err) => err.code === 'SIGNATURE_TIMESTAMP_EXPIRED');
  });

  test('APIv3 密钥不符 → 解密失败', async () => {
    const merchant = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const gateway = createMockWechatPayGateway({ mchid: MCHID, appid: APPID, apiV3Key: APIV3_KEY,
      merchantPublicKeyPem: merchant.publicKey.export({ type: 'spki', format: 'pem' }) });
    // 客户端持有错误的 APIv3 密钥
    const client = createWechatPayClient({ mchid: MCHID, appid: APPID,
      privateKey: merchant.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      certSerial: CERT_SERIAL, apiV3Key: 'X'.repeat(32),
      platformPublicKey: gateway.platform.publicKeyPem, platformPublicKeyId: gateway.platform.publicKeyId,
      http: gateway.asHttp() });
    await client.jsapi({ description: '余额充值', outTradeNo: 'po_n5', amountFen: 5000,
      openid: 'oMockOpenid', notifyUrl: 'https://e/n' });
    gateway.simulatePayment('po_n5');
    const notify = gateway.buildNotify('po_n5');
    assert.throws(() => client.verifyAndDecryptNotify(notify),
      (err) => err.code === 'RESOURCE_DECRYPT_FAILED');
  });

  test('非加密资源或缺 ciphertext → NOTIFY_RESOURCE_MISSING（复审必改 3，不返回无 decrypted 的对象）', async () => {
    const { gateway, client } = setup();
    // resource_type 不是 encrypt-resource（即使带 resource）
    const plain = gateway.signPayload({ id: 'evt_x', event_type: 'TRANSACTION.SUCCESS',
      resource_type: 'plain-text', resource: { ciphertext: 'AAAA' } });
    assert.throws(() => client.verifyAndDecryptNotify(plain),
      (err) => err.code === 'NOTIFY_RESOURCE_MISSING');
    // encrypt-resource 但 resource 缺 ciphertext
    const noCipher = gateway.signPayload({ id: 'evt_y', event_type: 'TRANSACTION.SUCCESS',
      resource_type: 'encrypt-resource', resource: { nonce: 'x', associated_data: 'transaction' } });
    assert.throws(() => client.verifyAndDecryptNotify(noCipher),
      (err) => err.code === 'NOTIFY_RESOURCE_MISSING');
    // 整个 resource 缺失
    const noResource = gateway.signPayload({ id: 'evt_z', event_type: 'TRANSACTION.SUCCESS',
      resource_type: 'encrypt-resource' });
    assert.throws(() => client.verifyAndDecryptNotify(noResource),
      (err) => err.code === 'NOTIFY_RESOURCE_MISSING');
  });
});

describe('decryptResource 正反例（AES-256-GCM）', () => {
  test('正例：encryptResource ↔ decryptResource 互逆', () => {
    const plain = { foo: '中文内容', total: 12345, nested: { ok: true } };
    const resource = encryptResource(APIV3_KEY, plain, 'transaction');
    assert.deepEqual(decryptResource(APIV3_KEY, resource), plain);
  });

  test('反例：篡改密文 / 错 AAD / 错密钥 / 非法输入全部拒绝', () => {
    const plain = { total: 100 };
    const resource = encryptResource(APIV3_KEY, plain, 'transaction');
    const rejectsCode = (code) => (err) => err instanceof WechatPayError && err.code === code;
    // 篡改密文末字节
    const bytes = Buffer.from(resource.ciphertext, 'base64');
    bytes[bytes.length - 3] ^= 0x01;
    assert.throws(() => decryptResource(APIV3_KEY, { ...resource,
      ciphertext: bytes.toString('base64') }), rejectsCode('RESOURCE_DECRYPT_FAILED'));
    // 错 AAD
    assert.throws(() => decryptResource(APIV3_KEY, { ...resource, associated_data: 'refund' }),
      rejectsCode('RESOURCE_DECRYPT_FAILED'));
    // 错密钥（同为 32 字节）
    assert.throws(() => decryptResource('Y'.repeat(32), resource),
      rejectsCode('RESOURCE_DECRYPT_FAILED'));
    // 密钥长度不是 32 字节
    assert.throws(() => decryptResource('short', resource), rejectsCode('APIV3_KEY_INVALID'));
    // 密文太短 / 缺 nonce
    assert.throws(() => decryptResource(APIV3_KEY, { ciphertext: 'AAAA', nonce: 'x' }),
      rejectsCode('RESOURCE_CIPHERTEXT_INVALID'));
  });
});
