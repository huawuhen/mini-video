// 微信支付 APIv3 客户端（M3-PAY-01，docs/ARCHITECTURE.md「支付（M3）」、docs/API.md §3.1）。
// 按微信支付官方《接口规则》自行实现：请求签名（SHA256withRSA）、应答与回调验签、
// resource AES-256-GCM 解密、JSAPI/H5/Native 下单、JSAPI 调起参数签名、查单、关单、退款。
// **不引入官方 SDK**；全部外部依赖（http、时钟）可注入，测试用本地 RSA 密钥对 +
// 模拟网关（./mock-gateway.js）零真实费用。
// 金额口径：微信 amount.total 即整数分，与本仓库一致，直接传递、不做任何换算。
import { createDecipheriv, createPrivateKey, createPublicKey, createSign, createVerify, randomBytes } from 'node:crypto';

const AUTH_SCHEMA = 'WECHATPAY2-SHA256-RSA2048';
const TIMESTAMP_TOLERANCE_SECONDS = 300; // 微信规定应答时间戳与本地差 5 分钟以上应拒绝

export class WechatPayError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WechatPayError';
    this.code = code;
  }
}

/** 请求待签名串（官方格式）：METHOD\nURL_PATH\nTIMESTAMP\nNONCE\nBODY\n（末尾换行必须有）。 */
export const requestSignMessage = (method, path, timestamp, nonce, body) =>
  [method, path, timestamp, nonce, body, ''].join('\n');

/** 应答/回调待签名串：TIMESTAMP\nNONCE\nBODY\n。 */
export const responseSignMessage = (timestamp, nonce, body) =>
  [timestamp, nonce, body, ''].join('\n');

/** JSAPI 调起参数待签名串：appId\ntimeStamp\nnonceStr\npackage\n。 */
export const jsapiPaySignMessage = (appId, timeStamp, nonceStr, pkg) =>
  [appId, timeStamp, nonceStr, pkg, ''].join('\n');

/** 微信 time_expire 格式（官方要求 RFC3339 北京时间）：yyyy-MM-DDTHH:mm:ss+08:00，
 * 不带毫秒（toISOString 的毫秒与 Z 后缀有被判参数错误的风险）。 */
export function wechatPayTime(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new WechatPayError('TIME_EXPIRE_INVALID', 'time_expire 需要 Date 对象');
  }
  const inBeijing = new Date(date.getTime() + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${inBeijing.getUTCFullYear()}-${p(inBeijing.getUTCMonth() + 1)}-${p(inBeijing.getUTCDate())}`
    + `T${p(inBeijing.getUTCHours())}:${p(inBeijing.getUTCMinutes())}:${p(inBeijing.getUTCSeconds())}+08:00`;
}

/** 环境变量里的 PEM 常把换行写成 `\n` 字面量（单行写法），统一还原成真实换行。 */
export function normalizePem(pem) {
  return typeof pem === 'string' && pem.includes('\\n') ? pem.replace(/\\n/g, '\n') : pem;
}

/**
 * AES-256-GCM 解密回调 resource（APIv3 密钥 32 字节；密文 Base64 = 明文 || 16 字节 auth tag；
 * associated_data 通常为 "transaction"）。任何字节被篡改或密钥/AAD 不符都会在 final() 抛错。
 */
export function decryptResource(apiV3Key, { ciphertext, nonce, associated_data: aad }) {
  if (typeof apiV3Key !== 'string' || apiV3Key.length !== 32) {
    throw new WechatPayError('APIV3_KEY_INVALID', 'APIv3 密钥必须是 32 字节字符串');
  }
  let data;
  try {
    data = Buffer.from(ciphertext, 'base64');
  } catch {
    throw new WechatPayError('RESOURCE_CIPHERTEXT_INVALID', '回调 resource 密文不是有效的 Base64');
  }
  if (data.length < 17 || typeof nonce !== 'string') {
    throw new WechatPayError('RESOURCE_CIPHERTEXT_INVALID', '回调 resource 密文或 nonce 非法');
  }
  const authTag = data.subarray(data.length - 16);
  const body = data.subarray(0, data.length - 16);
  let plain;
  try {
    const decipher = createDecipheriv('aes-256-gcm', Buffer.from(apiV3Key, 'utf8'),
      Buffer.from(nonce, 'utf8'), { authTagLength: 16 });
    if (aad) decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(authTag);
    plain = Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    throw new WechatPayError('RESOURCE_DECRYPT_FAILED', '回调 resource 解密失败（密钥不符或密文被篡改）');
  }
  try {
    return JSON.parse(plain.toString('utf8'));
  } catch {
    throw new WechatPayError('RESOURCE_DECRYPT_FAILED', '回调 resource 解密后不是有效的 JSON');
  }
}

/** 默认 HTTP 适配：形状与注入版一致（status / headers（大小写不敏感 get）/ text()）。 */
async function defaultHttp({ method, url, headers, body }) {
  const response = await fetch(url, { method, headers, body: body || undefined,
    signal: AbortSignal.timeout(15_000) });
  return { status: response.status, headers: response.headers, text: () => response.text() };
}

/** 取头（大小写不敏感）：兼容 fetch Headers（get）、Map（keys 迭代）、普通对象（Express req.headers）。 */
function headerOf(headers, name) {
  if (!headers) return undefined;
  const target = name.toLowerCase();
  if (typeof headers.get === 'function') {
    const direct = headers.get(target); // fetch Headers 本就大小写不敏感
    if (direct !== undefined && direct !== null) return direct;
  }
  if (typeof headers.keys === 'function') {
    for (const key of headers.keys()) {
      if (String(key).toLowerCase() === target) return headers.get(key);
    }
  }
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === target) return headers[key];
  }
  return undefined;
}

/**
 * createWechatPayClient（ARCHITECTURE 签名）：
 *   { baseUrl, mchid, appid, privateKey, certSerial, apiV3Key, platformPublicKey,
 *     platformPublicKeyId, http, now }
 *   → { jsapi, h5, native, jsapiPayParams, query, close, refund, verifyAndDecryptNotify }
 * privateKey/platformPublicKey 均为 PEM 文本（支持 \n 转义的单行写法）；
 * platformPublicKeyId 即「微信支付公钥 ID」，应答与回调的 Wechatpay-Serial 必须与之相等。
 */
export function createWechatPayClient({
  baseUrl = 'https://api.mch.weixin.qq.com',
  mchid, appid, privateKey, certSerial, apiV3Key, platformPublicKey, platformPublicKeyId,
  http = defaultHttp, now = () => Date.now(),
}) {
  for (const [name, value] of [['mchid', mchid], ['appid', appid], ['certSerial', certSerial],
    ['platformPublicKeyId', platformPublicKeyId]]) {
    if (!value) throw new WechatPayError('CONFIG_MISSING', `微信支付缺少配置：${name}`);
  }
  let merchantKey;
  let wxPublicKey;
  try {
    merchantKey = createPrivateKey(normalizePem(privateKey));
    wxPublicKey = createPublicKey(normalizePem(platformPublicKey));
  } catch (error) {
    throw new WechatPayError('CONFIG_INVALID', `微信支付密钥不是有效的 PEM：${error.message}`);
  }

  const sha256RsaSign = (message) => {
    const signer = createSign('RSA-SHA256');
    signer.update(message);
    return signer.sign(merchantKey, 'base64');
  };

  const unixNow = () => Math.floor(now() / 1000);

  function buildAuthorization(method, path, bodyStr) {
    const timestamp = String(unixNow());
    const nonce = randomBytes(16).toString('hex');
    const signature = sha256RsaSign(requestSignMessage(method, path, timestamp, nonce, bodyStr));
    return `${AUTH_SCHEMA} mchid="${mchid}",nonce_str="${nonce}",`
      + `signature="${signature}",timestamp="${timestamp}",serial_no="${certSerial}"`;
  }

  /** 平台签名校验（应答与回调共用）：序列号相符 + 时间戳 5 分钟内 + RSA-SHA256 验签。 */
  function verifyPlatformSignature({ timestamp, nonce, serial, signature }, bodyText) {
    if (serial !== platformPublicKeyId) {
      throw new WechatPayError('SIGNATURE_SERIAL_MISMATCH',
        `平台公钥序列号不符（期望 ${platformPublicKeyId}，实收 ${serial}）`);
    }
    const age = Math.abs(unixNow() - Number(timestamp));
    if (!Number.isSafeInteger(age) || age > TIMESTAMP_TOLERANCE_SECONDS) {
      throw new WechatPayError('SIGNATURE_TIMESTAMP_EXPIRED', `平台签名时间戳超出 5 分钟容差（偏差 ${age} 秒）`);
    }
    const verifier = createVerify('RSA-SHA256');
    verifier.update(responseSignMessage(timestamp, nonce, bodyText));
    let valid = false;
    try {
      valid = verifier.verify(wxPublicKey, Buffer.from(signature, 'base64'));
    } catch {
      valid = false;
    }
    if (!valid) throw new WechatPayError('SIGNATURE_INVALID', '平台签名校验未通过');
  }

  async function request(method, path, { body } = {}) {
    const bodyStr = body === undefined ? '' : JSON.stringify(body);
    const response = await http({
      method, url: `${baseUrl}${path}`,
      headers: {
        'Content-Type': 'application/json', Accept: 'application/json',
        Authorization: buildAuthorization(method, path, bodyStr),
        'User-Agent': 'MiniAIVideo/1.0',
      },
      body: bodyStr,
    });
    const text = await response.text();
    if (response.status < 200 || response.status >= 300) {
      let code = 'UPSTREAM_ERROR';
      let message = `HTTP ${response.status}`;
      try {
        const parsed = JSON.parse(text);
        if (parsed.code) code = parsed.code;
        if (parsed.message) message = parsed.message;
      } catch { /* 非 JSON 错误体，保留 HTTP 状态 */ }
      throw new WechatPayError(code, `微信支付接口错误：${message}`);
    }
    // 应答验签（微信对所有应答——含 204——都带四个 Wechatpay-* 头）
    const headers = {
      timestamp: headerOf(response.headers, 'wechatpay-timestamp'),
      nonce: headerOf(response.headers, 'wechatpay-nonce'),
      serial: headerOf(response.headers, 'wechatpay-serial'),
      signature: headerOf(response.headers, 'wechatpay-signature'),
    };
    if (!headers.timestamp || !headers.nonce || !headers.serial || !headers.signature) {
      throw new WechatPayError('SIGNATURE_HEADER_MISSING', '微信支付应答缺少 Wechatpay-* 签名头');
    }
    verifyPlatformSignature(headers, text);
    return text ? JSON.parse(text) : null;
  }

  const baseOrder = ({ description, outTradeNo, amountFen, notifyUrl, expiresAt }) => ({
    appid, mchid,
    description,
    out_trade_no: outTradeNo,
    notify_url: notifyUrl,
    amount: { total: amountFen, currency: 'CNY' },
    ...(expiresAt instanceof Date ? { time_expire: wechatPayTime(expiresAt) } : {}),
  });
  const assertAmountFen = (amountFen) => {
    if (!Number.isSafeInteger(amountFen) || amountFen <= 0) {
      throw new WechatPayError('AMOUNT_INVALID', `金额必须是正整数分，收到 ${amountFen}`);
    }
  };

  return {
    /** JSAPI 下单（微信内）：成功返回 { prepayId }。openid 必填（无则调用方先走 OAuth）。 */
    async jsapi(order) {
      assertAmountFen(order.amountFen);
      const { prepay_id: prepayId } = await request('POST', '/v3/pay/transactions/jsapi', {
        body: { ...baseOrder(order), payer: { openid: order.openid } } });
      return { prepayId };
    },

    /** H5 下单（手机系统浏览器）：成功返回 { h5Url }。clientIp 必填（微信风控要求）。 */
    async h5(order) {
      assertAmountFen(order.amountFen);
      const { h5_url: h5Url } = await request('POST', '/v3/pay/transactions/h5', {
        body: { ...baseOrder(order),
          scene_info: { payer_client_ip: order.clientIp, h5_info: { type: 'Wap' } } } });
      return { h5Url };
    },

    /** Native 下单（PC 扫码）：成功返回 { codeUrl }（前端渲染二维码）。 */
    async native(order) {
      assertAmountFen(order.amountFen);
      const { code_url: codeUrl } = await request('POST', '/v3/pay/transactions/native', {
        body: baseOrder(order) });
      return { codeUrl };
    },

    /** JSAPI 前端调起参数（官方规则）：appId/timeStamp/nonceStr/package/signType=RSA/paySign。 */
    jsapiPayParams(prepayId) {
      const timeStamp = String(unixNow());
      const nonceStr = randomBytes(16).toString('hex');
      const pkg = `prepay_id=${prepayId}`;
      return {
        appId: appid, timeStamp, nonceStr, package: pkg, signType: 'RSA',
        paySign: sha256RsaSign(jsapiPaySignMessage(appid, timeStamp, nonceStr, pkg)),
      };
    },

    /** 查单（微信字段原样返回：trade_state/transaction_id/amount.total/payer.openid…）。 */
    query(outTradeNo) {
      const path = `/v3/pay/transactions/out-trade-no/${encodeURIComponent(outTradeNo)}`
        + `?mchid=${encodeURIComponent(mchid)}`;
      return request('GET', path);
    },

    /** 关单：成功返回 null（微信回 204 无 body）。 */
    async close(outTradeNo) {
      await request('POST',
        `/v3/pay/transactions/out-trade-no/${encodeURIComponent(outTradeNo)}/close`, { body: { mchid } });
      return null;
    },

    /** 退款（充值逆向，运营用）：返回微信退款单。 */
    refund({ outTradeNo, outRefundNo, refundFen, totalFen, reason, notifyUrl }) {
      assertAmountFen(refundFen);
      assertAmountFen(totalFen);
      return request('POST', '/v3/refund/domestic/refunds', {
        body: {
          out_trade_no: outTradeNo, out_refund_no: outRefundNo,
          ...(reason ? { reason } : {}), ...(notifyUrl ? { notify_url: notifyUrl } : {}),
          amount: { refund: refundFen, total: totalFen, currency: 'CNY' },
        } });
    },

    /**
     * 回调通知验证 + 解密：先验平台签名（原始请求体，**不得**经任何 JSON 重排序/重新序列化），
     * 再解密 resource。支付回调一律为加密资源：非 encrypt-resource 或缺 ciphertext
     * 直接抛 NOTIFY_RESOURCE_MISSING（不返回无 decrypted 的对象——防止调用方误读外层字段
     * 绕过解密，M3-PAY-01 复审必改 3）。
     */
    verifyAndDecryptNotify({ headers, rawBody }) {
      verifyPlatformSignature({
        timestamp: headerOf(headers, 'wechatpay-timestamp'),
        nonce: headerOf(headers, 'wechatpay-nonce'),
        serial: headerOf(headers, 'wechatpay-serial'),
        signature: headerOf(headers, 'wechatpay-signature'),
      }, rawBody);
      let parsed;
      try {
        parsed = JSON.parse(rawBody);
      } catch {
        throw new WechatPayError('NOTIFY_BODY_INVALID', '回调请求体不是有效的 JSON');
      }
      if (parsed.resource_type !== 'encrypt-resource' || !parsed.resource?.ciphertext) {
        throw new WechatPayError('NOTIFY_RESOURCE_MISSING',
          `回调缺少加密 resource（resource_type=${parsed.resource_type ?? '无'}）`);
      }
      return { ...parsed, decrypted: decryptResource(apiV3Key, parsed.resource) };
    },
  };
}
