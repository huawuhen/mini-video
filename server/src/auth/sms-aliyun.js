// 阿里云短信 provider（M3-SMS-01，TASKS / PRD §11）：dysmsapi（2017-05-25）SendSms，
// RPC API 签名 V1.0（HMAC-SHA1）**自行实现、不引入官方 SDK**；http/now 可注入，
// 测试用本地模拟网关（test/sms-aliyun.test.js）零真实发送。
// 错误口径（M3-PAY-01 建议 4 同款）：阿里原始 Code/Message 只进日志（手机号脱敏），
// 用户只看到映射后的固定中文（err.userMessage，由 sms.js 的 catch 透出）。
import { createHmac, randomBytes } from 'node:crypto';

const ENDPOINT = 'https://dysmsapi.aliyuncs.com/';

/** 阿里云错误码 → 面向用户的固定中文（未命中走默认文案）。 */
export const ALIYUN_SMS_ERROR_MAP = {
  'isv.BUSINESS_LIMIT_CONTROL': '发送太频繁了，请稍后再试',
  'isv.MINUTE_LIMIT_CONTROL': '发送太频繁了，请稍后再试',
  'isv.HOUR_LIMIT_CONTROL': '发送太频繁，请一小时后再试',
  'isv.DAY_LIMIT_CONTROL': '今天发送的验证码次数已用完，请明天再试',
  'Throttling': '发送太频繁了，请稍后再试',
  'isv.AMOUNT_NOT_ENOUGH': '短信服务余额不足，暂时无法发送验证码，请联系客服',
  'isv.MOBILE_NUMBER_ILLEGAL': '手机号无效，请检查后重试',
  'InvalidPhoneNumbers': '手机号无效，请检查后重试',
  'isv.SIGN_NAME_ILLEGAL': '短信签名未配置正确，请联系客服处理',
  'isv.SIGN_NOT_EXISTS': '短信签名不存在，请联系客服处理',
  'isv.TEMPLATE_MISSING_PARAMETERS': '短信模板配置有误，请联系客服处理',
  'isv.TEMPLATE_NOT_EXISTS': '短信模板不存在，请联系客服处理',
};

/** RFC3986 percentEncode（阿里云 RPC 签名专用）：+ → %20、* → %2A、%7E → ~。 */
export function percentEncode(value) {
  return encodeURIComponent(String(value))
    .replace(/\+/g, '%20')
    .replace(/\*/g, '%2A')
    .replace(/%7E/g, '~');
}

/**
 * 构造已签名的请求 URL（纯函数，测试直接断言参数与签名）。
 * 参数按 key 升序 percentEncode 拼串 → `GET&%2F&percentEncode(串)` HMAC-SHA1(key=secret+'&')。
 */
export function buildAliyunSmsRequest({ accessKeyId, accessKeySecret, phone, code, signName,
  templateCode, now = () => new Date(), nonce = () => randomBytes(16).toString('hex') }) {
  const params = {
    AccessKeyId: accessKeyId,
    Action: 'SendSms',
    Format: 'JSON',
    PhoneNumbers: phone,
    RegionId: 'cn-hangzhou',
    SignatureMethod: 'HMAC-SHA1',
    SignatureNonce: nonce(),
    SignatureVersion: '1.0',
    SignName: signName,
    TemplateCode: templateCode,
    TemplateParam: JSON.stringify({ code }),
    Timestamp: now().toISOString().replace(/\.\d{3}Z$/, 'Z'), // UTC ISO8601（秒级，无毫秒）
    Version: '2017-05-25',
  };
  const canonical = Object.keys(params).sort()
    .map((key) => `${percentEncode(key)}=${percentEncode(params[key])}`).join('&');
  const stringToSign = `GET&${percentEncode('/')}&${percentEncode(canonical)}`;
  const signature = createHmac('sha1', `${accessKeySecret}&`).update(stringToSign).digest('base64');
  const query = `${canonical}&Signature=${percentEncode(signature)}`;
  return { url: `${ENDPOINT}?${query}`, params, signature, stringToSign };
}

async function defaultHttp({ url }) {
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  return { status: response.status, text: await response.text() };
}

/**
 * 阿里云短信 provider（SMS_PROVIDER=aliyun）。构造即校验四项配置（缺任一直接抛错，
 * 无论环境——选了 aliyun 就是要真发）；发送失败抛带 { code, userMessage } 的错误，
 * 原始 Code/Message 在 err.message 供日志，不透给用户。
 */
export function aliyunSmsProvider(config, logger, { http = defaultHttp, now, nonce } = {}) {
  const { accessKeyId, accessKeySecret, signName, templateCode } = config.sms.aliyun;
  const missing = [
    ['ALIYUN_SMS_ACCESS_KEY_ID', accessKeyId],
    ['ALIYUN_SMS_ACCESS_KEY_SECRET', accessKeySecret],
    ['ALIYUN_SMS_SIGN_NAME', signName],
    ['ALIYUN_SMS_TEMPLATE_CODE', templateCode],
  ].filter(([, value]) => !value).map(([name]) => name);
  if (missing.length) {
    throw new Error(`SMS_PROVIDER=aliyun 缺少配置：${missing.join('、')}（RAM 子账号建议只授短信权限）`);
  }
  logger?.info?.('sms_aliyun_provider_ready', { signName, templateCode });
  return {
    id: 'aliyun',
    async send({ phone, code }) {
      const request = buildAliyunSmsRequest({ accessKeyId, accessKeySecret, phone, code,
        signName, templateCode, ...(now ? { now } : {}), ...(nonce ? { nonce } : {}) });
      let parsed;
      try {
        const { status, text } = await http({ url: request.url });
        parsed = { status, body: text ? JSON.parse(text) : {} };
      } catch (err) {
        // 网络类失败：原始错误进日志，用户只看固定中文
        const error = new Error(`aliyun sms request failed: ${err?.code ?? ''} ${String(err?.message ?? err).slice(0, 200)}`);
        error.code = err?.code ?? 'NETWORK_ERROR';
        error.userMessage = '验证码发送失败，请稍后再试';
        throw error;
      }
      const aliCode = parsed.body?.Code ?? `HTTP_${parsed.status}`;
      if (parsed.status >= 400 || aliCode !== 'OK') {
        // 原始错误只进日志（手机号由调用方脱敏）；用户看映射后的中文
        const error = new Error(`aliyun sms rejected: ${aliCode} ${parsed.body?.Message ?? ''}`.trim());
        error.code = aliCode;
        error.userMessage = ALIYUN_SMS_ERROR_MAP[aliCode] ?? '验证码发送失败，请稍后再试';
        throw error;
      }
      logger?.info?.('sms_aliyun_sent', { bizId: parsed.body?.BizId });
    },
  };
}
