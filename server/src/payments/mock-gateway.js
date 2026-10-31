// 本地模拟微信支付网关（M3-PAY-01 测试专用，**零真实费用**）。
// 在内存里实现 APIv3 的最小子集：验商户请求签名 → 三种下单/查单/关单/退款 →
// 全部应答带平台签名头（Wechatpay-Serial/Timestamp/Nonce/Signature）→ 可构造
// 加密回调通知（TRANSACTION.SUCCESS，AES-256-GCM resource + 平台签名）。
// 客户端侧把 asHttp() 注入 createWechatPayClient 的 http 即形成回环，不经网络。
// 测试控制：simulatePayment（模拟用户支付成功）、buildNotify（生成回调请求）、
// orders/refunds（内部状态）、failNextResponse（注入故障验证客户端行为）。
import { createCipheriv, createSign, createVerify, generateKeyPairSync, randomBytes } from 'node:crypto';
import { responseSignMessage } from './wechat-pay.js';

const AUTH_SCHEMA = 'WECHATPAY2-SHA256-RSA2048';

/** 12 字符 ASCII nonce（= 12 字节，AES-GCM IV 长度要求）。 */
const asciiNonce = () => [...randomBytes(12)]
  .map((b) => '0123456789abcdefghijklmnopqrstuvwxyz'[b % 36]).join('');

/** AES-256-GCM 加密（回调 resource 生成侧，与 decryptResource 互逆）。 */
export function encryptResource(apiV3Key, plain, aad = 'transaction') {
  const nonce = asciiNonce();
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(apiV3Key, 'utf8'),
    Buffer.from(nonce, 'utf8'), { authTagLength: 16 });
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const enc = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(plain), 'utf8')), cipher.final()]);
  return {
    original_type: 'transaction', algorithm: 'AEAD_AES_256_GCM',
    ciphertext: Buffer.concat([enc, cipher.getAuthTag()]).toString('base64'),
    associated_data: aad, nonce,
  };
}

/**
 * createMockWechatPayGateway：
 *   { mchid, appid, apiV3Key, merchantPublicKeyPem, platformKeyPair?, platformPublicKeyId?, now? }
 * platformKeyPair 缺省时自动生成（{ privateKey, publicKey } PEM，测试里公钥交给客户端做验签）。
 */
export function createMockWechatPayGateway({
  mchid, appid, apiV3Key,
  merchantPublicKeyPem,
  platformKeyPair,
  platformPublicKeyId = 'PUB_KEY_ID_MOCK_0000000000000001',
  now = () => Date.now(),
}) {
  const platform = platformKeyPair ?? generateKeyPairSync('rsa', { modulusLength: 2048 });
  const platformPrivatePem = platform.privateKey.export({ type: 'pkcs8', format: 'pem' });
  const platformPublicPem = platform.publicKey.export({ type: 'spki', format: 'pem' });
  const merchantPublicKey = merchantPublicKeyPem; // createVerify 可直接吃 PEM 字符串

  const orders = new Map();   // out_trade_no → { outTradeNo, amountFen, openid, status, transactionId, tradeType, clientIp, closed }
  const refunds = new Map();  // out_refund_no → 退款单
  const seenRequests = [];    // 每条 { method, path, authorization, body }（断言金额整数/待签名串用）
  let failNext = null;        // { status, body }：下一次请求直接回（故障注入）

  const unixNow = () => Math.floor(now() / 1000);

  function signResponse(bodyText) {
    const timestamp = String(unixNow());
    const nonce = asciiNonce();
    const signer = createSign('RSA-SHA256');
    signer.update(responseSignMessage(timestamp, nonce, bodyText));
    return {
      'Content-Type': 'application/json',
      'Wechatpay-Serial': platformPublicKeyId,
      'Wechatpay-Timestamp': timestamp,
      'Wechatpay-Nonce': nonce,
      'Wechatpay-Signature': signer.sign(platformPrivatePem, 'base64'),
    };
  }

  const reply = (status, payload) => {
    const bodyText = payload === undefined ? '' : JSON.stringify(payload);
    return { status, headers: signResponse(bodyText), body: bodyText };
  };

  /** 验商户 Authorization（官方待签名串格式；任何不符 → 401 SIGN_ERROR，与真实网关一致）。 */
  function verifyMerchantAuth(method, path, bodyText, authorization) {
    if (typeof authorization !== 'string' || !authorization.startsWith(`${AUTH_SCHEMA} `)) {
      return { ok: false, reason: 'Authorization 头缺失或格式不对' };
    }
    const fields = {};
    for (const part of authorization.slice(AUTH_SCHEMA.length + 1).split(',')) {
      const eq = part.indexOf('=');
      if (eq > 0) fields[part.slice(0, eq).trim()] = part.slice(eq + 1).replace(/^"|"$/g, '');
    }
    if (fields.mchid !== mchid) return { ok: false, reason: `mchid 不符：${fields.mchid}` };
    const verifier = createVerify('RSA-SHA256');
    // 官方格式：METHOD\nPATH\nTIMESTAMP\nNONCE\nBODY\n
    verifier.update([method, path, fields.timestamp, fields.nonce_str, bodyText, ''].join('\n'));
    let valid = false;
    try {
      valid = verifier.verify(merchantPublicKey, Buffer.from(fields.signature, 'base64'));
    } catch { valid = false; }
    return valid ? { ok: true, auth: fields } : { ok: false, reason: '商户签名校验未通过' };
  }

  const requireFields = (body, names) => names.filter((n) => body?.[n] === undefined);

  function handle(method, rawPath, headers, bodyText) {
    const [path, queryString = ''] = rawPath.split('?');
    if (failNext) {
      const injected = failNext;
      failNext = null;
      return injected.status >= 500
        ? { status: injected.status, headers: {}, body: JSON.stringify(injected.body) } // 故障注入不签名（验证客户端对异常的处理）
        : reply(injected.status, injected.body);
    }
    const auth = verifyMerchantAuth(method, rawPath, bodyText ?? '', headers.authorization ?? headers.Authorization);
    if (!auth.ok) return reply(401, { code: 'SIGN_ERROR', message: auth.reason });

    const body = bodyText ? JSON.parse(bodyText) : {};

    // ── 下单（三种）──
    if (method === 'POST' && path === '/v3/pay/transactions/jsapi') {
      const missing = requireFields(body, ['appid', 'mchid', 'description', 'out_trade_no', 'notify_url', 'amount', 'payer']);
      if (missing.length) return reply(400, { code: 'PARAM_ERROR', message: `缺少字段：${missing.join(',')}` });
      if (body.appid !== appid || body.mchid !== mchid) {
        return reply(403, { code: 'INVALID_REQUEST', message: 'appid 或 mchid 不符' });
      }
      if (!Number.isSafeInteger(body.amount.total) || body.amount.total <= 0) {
        return reply(400, { code: 'PARAM_ERROR', message: 'amount.total 必须是正整数（分）' });
      }
      if (orders.has(body.out_trade_no)) {
        return reply(400, { code: 'INVALID_REQUEST', message: '商户订单号重复' });
      }
      orders.set(body.out_trade_no, { outTradeNo: body.out_trade_no, amountFen: body.amount.total,
        openid: body.payer.openid, status: 'NOTPAY', transactionId: null, tradeType: 'JSAPI', clientIp: null });
      return reply(200, { prepay_id: `prepay_${randomBytes(10).toString('hex')}` });
    }
    if (method === 'POST' && path === '/v3/pay/transactions/h5') {
      if (!body?.scene_info?.payer_client_ip) {
        return reply(400, { code: 'PARAM_ERROR', message: 'H5 下单需要 scene_info.payer_client_ip' });
      }
      orders.set(body.out_trade_no, { outTradeNo: body.out_trade_no, amountFen: body.amount.total,
        openid: null, status: 'NOTPAY', transactionId: null, tradeType: 'H5', clientIp: body.scene_info.payer_client_ip });
      return reply(200, { h5_url: `https://pay.tenpay.com/h5/mock/${randomBytes(8).toString('hex')}` });
    }
    if (method === 'POST' && path === '/v3/pay/transactions/native') {
      orders.set(body.out_trade_no, { outTradeNo: body.out_trade_no, amountFen: body.amount.total,
        openid: null, status: 'NOTPAY', transactionId: null, tradeType: 'NATIVE', clientIp: null });
      return reply(200, { code_url: `weixin://wxpay/mock/${randomBytes(10).toString('hex')}` });
    }

    // ── 查单 / 关单 ──
    const tradeMatch = /^\/v3\/pay\/transactions\/out-trade-no\/([^/]+)$/.exec(path);
    if (method === 'GET' && tradeMatch) {
      const outTradeNo = decodeURIComponent(tradeMatch[1]);
      const order = orders.get(outTradeNo);
      if (!order) return reply(404, { code: 'ORDER_NOT_EXIST', message: '订单不存在' });
      if (new URLSearchParams(queryString).get('mchid') !== mchid) {
        return reply(400, { code: 'PARAM_ERROR', message: 'mchid 查询参数不符' });
      }
      return reply(200, transactionOf(order));
    }
    const closeMatch = /^\/v3\/pay\/transactions\/out-trade-no\/([^/]+)\/close$/.exec(path);
    if (method === 'POST' && closeMatch) {
      const order = orders.get(decodeURIComponent(closeMatch[1]));
      if (!order) return reply(404, { code: 'ORDER_NOT_EXIST', message: '订单不存在' });
      if (order.status === 'SUCCESS') return reply(400, { code: 'TRADE_STATE_ERROR', message: '订单已支付，不能关单' });
      order.status = 'CLOSED';
      return reply(204);
    }

    // ── 退款 ──
    if (method === 'POST' && path === '/v3/refund/domestic/refunds') {
      const order = orders.get(body.out_trade_no);
      if (!order) return reply(404, { code: 'ORDER_NOT_EXIST', message: '原订单不存在' });
      if (order.status !== 'SUCCESS') return reply(400, { code: 'TRADE_STATE_ERROR', message: '订单未支付，不能退款' });
      if (body.amount.refund > body.amount.total) {
        return reply(400, { code: 'INVALID_REQUEST', message: '退款金额超过原订单金额' });
      }
      const refund = { refund_id: `ref_${randomBytes(10).toString('hex')}`, out_refund_no: body.out_refund_no,
        out_trade_no: body.out_trade_no, status: 'SUCCESS', amount: body.amount,
        success_time: new Date(now()).toISOString() };
      refunds.set(body.out_refund_no, refund);
      return reply(200, refund);
    }

    return reply(404, { code: 'NOT_FOUND', message: `模拟网关未实现：${method} ${path}` });
  }

  /** 微信 transaction 应答体字段（真实网关口径的字段子集）。 */
  function transactionOf(order) {
    return {
      mchid, appid,
      out_trade_no: order.outTradeNo,
      transaction_id: order.transactionId,
      trade_type: order.tradeType,
      trade_state: order.status,
      trade_state_desc: order.status === 'SUCCESS' ? '支付成功' : order.status === 'CLOSED' ? '已关闭' : '未支付',
      success_time: order.paidAt ?? null,
      payer: order.openid ? { openid: order.openid } : undefined,
      amount: { total: order.amountFen, payer_total: order.amountFen, currency: 'CNY' },
    };
  }

  return {
    /** 注入给 createWechatPayClient 的 http：拦截请求形成回环（不经网络）。 */
    asHttp() {
      return async ({ method, url, headers, body }) => {
        const parsed = new URL(url);
        const rawPath = `${parsed.pathname}${parsed.search}`;
        seenRequests.push({ method, path: rawPath, authorization: headers.Authorization, body: body ?? '' });
        const { status, headers: respHeaders, body: respBody } = handle(method, rawPath, headers, body ?? '');
        return { status, headers: new Map(Object.entries(respHeaders)), text: async () => respBody };
      };
    },

    /** 平台公钥（PEM）与公钥 ID：测试里交给客户端构造参数。 */
    platform: { publicKeyPem: platformPublicPem, publicKeyId: platformPublicKeyId },

    /** 模拟用户支付成功（内部测试控制，微信侧没有对应 API）。 */
    simulatePayment(outTradeNo) {
      const order = orders.get(outTradeNo);
      if (!order) throw new Error(`模拟网关：订单不存在 ${outTradeNo}`);
      order.status = 'SUCCESS';
      order.transactionId = `wx_tx_${randomBytes(10).toString('hex')}`;
      order.paidAt = new Date(now()).toISOString();
      return order;
    },

    /** 构造加密回调通知（含平台签名头），供 verifyAndDecryptNotify 测试。 */
    buildNotify(outTradeNo, { eventType = 'TRANSACTION.SUCCESS', aad = 'transaction' } = {}) {
      const order = orders.get(outTradeNo);
      if (!order || order.status !== 'SUCCESS') throw new Error('只有已支付订单才能构造成功回调');
      const payload = {
        id: `evt_${randomBytes(8).toString('hex')}`,
        create_time: new Date(now()).toISOString(),
        resource_type: 'encrypt-resource',
        event_type: eventType,
        summary: '支付成功',
        resource: encryptResource(apiV3Key, transactionOf(order), aad),
      };
      const rawBody = JSON.stringify(payload);
      const timestamp = String(unixNow());
      const nonce = asciiNonce();
      const signer = createSign('RSA-SHA256');
      signer.update(responseSignMessage(timestamp, nonce, rawBody));
      return {
        rawBody,
        headers: {
          'wechatpay-serial': platformPublicKeyId,
          'wechatpay-timestamp': timestamp,
          'wechatpay-nonce': nonce,
          'wechatpay-signature': signer.sign(platformPrivatePem, 'base64'),
        },
      };
    },

    /** 故障注入：下一次请求直接返回 { status, body }（5xx 不带签名头，验证客户端异常路径）。 */
    failNextResponse(status, body) { failNext = { status, body }; },

    orders, refunds, seenRequests,
  };
}
