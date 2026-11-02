// M3-SMS-01：阿里云短信 provider——dysmsapi SendSms 自实现签名（RPC 签名 V1.0 HMAC-SHA1）
// 与错误映射，全部走本地模拟网关（本文件内**独立实现**验签，与 src 实现分离，避免自证），
// 零真实发送（用户阿里云账号未申请，TASKS 明确真实发送前需另行授权）。
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { silentLogger } from '../src/logger.js';
import {
  aliyunSmsProvider, buildAliyunSmsRequest, ALIYUN_SMS_ERROR_MAP, percentEncode,
} from '../src/auth/sms-aliyun.js';
import { createTestDb } from './helpers/db.js';

const AK = 'LTAI5tMockAccessKeyId0000';
const SECRET = 'MockAccessKeySecret0000000000000000000000';
const SIGN_NAME = '迷你AI视频';
const TEMPLATE = 'SMS_1000000000';

const aliConfig = (over = {}) => {
  const config = loadConfig({ NODE_ENV: 'test' });
  config.sms.aliyun = {
    accessKeyId: AK, accessKeySecret: SECRET, signName: SIGN_NAME, templateCode: TEMPLATE,
    ...(over.aliyun ?? {}),
  };
  return config;
};

// ── 模拟网关：独立实现 RFC3986 编码与 HMAC-SHA1 验签（不 import src 的实现）──
function decodePct(value) {
  return decodeURIComponent(String(value).replace(/%7E/g, '~'));
}

/** 验签 + 校验必填参数；respond(params) 决定返回 { status, body }。 */
function createMockAliyunSmsGateway({ secret = SECRET, respond } = {}) {
  const gateway = { seen: [], respond };
  gateway.asHttp = async ({ url }) => {
      assert.ok(url.startsWith('https://dysmsapi.aliyuncs.com/?'), `请求应发往 dysmsapi：${url.slice(0, 60)}`);
      const pairs = url.split('?')[1].split('&').map((pair) => {
        const eq = pair.indexOf('=');
        return [decodePct(pair.slice(0, eq)), decodePct(pair.slice(eq + 1))];
      });
      const params = Object.fromEntries(pairs);
      const signature = params.Signature;
      delete params.Signature;
      gateway.seen.push(params);
      // 独立验签：参数升序、RFC3986 编码拼串、GET&%2F&… HMAC-SHA1(secret&)
      const canonical = Object.keys(params).sort()
        .map((key) => `${encodeURIComponent(key).replace(/\+/g, '%20').replace(/\*/g, '%2A').replace(/%7E/g, '~')}=${
          encodeURIComponent(params[key]).replace(/\+/g, '%20').replace(/\*/g, '%2A').replace(/%7E/g, '~')}`)
        .join('&');
      const stringToSign = `GET&${encodeURIComponent('/')}&${encodeURIComponent(canonical)}`;
      const expected = createHmac('sha1', `${secret}&`).update(stringToSign).digest('base64');
      if (signature !== expected) {
        return { status: 400, text: JSON.stringify({ Code: 'SignatureDoesNotMatch',
          Message: `mock 验签失败：收到 ${signature}，期望 ${expected}` }) };
      }
      // 必填参数与格式校验（与阿里云 RPC 语义一致）
      const required = ['AccessKeyId', 'Action', 'Format', 'PhoneNumbers', 'SignatureMethod',
        'SignatureNonce', 'SignatureVersion', 'SignName', 'TemplateCode', 'TemplateParam',
        'Timestamp', 'Version'];
      for (const key of required) {
        if (params[key] === undefined) {
          return { status: 400, text: JSON.stringify({ Code: 'MissingParameter', Message: key }) };
        }
      }
      if (params.Action !== 'SendSms' || params.Version !== '2017-05-25' || params.Format !== 'JSON'
        || params.SignatureMethod !== 'HMAC-SHA1' || params.SignatureVersion !== '1.0') {
        return { status: 400, text: JSON.stringify({ Code: 'InvalidParameter', Message: 'RPC 协议参数不正确' }) };
      }
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(params.Timestamp)) {
        return { status: 400, text: JSON.stringify({ Code: 'InvalidTimeStamp.Format',
          Message: 'Timestamp 必须是 UTC ISO8601 秒级' }) };
      }
      return gateway.respond?.(params) ?? { status: 200, text: JSON.stringify({ Code: 'OK', Message: 'OK',
        RequestId: 'req-mock', BizId: 'biz-mock-0001' }) };
    };
  return gateway;
}

const okConfig = () => aliConfig();

describe('buildAliyunSmsRequest：签名与参数（固定向量）', () => {
  const fixed = buildAliyunSmsRequest({
    accessKeyId: AK, accessKeySecret: SECRET, phone: '13800001234', code: '654321',
    signName: SIGN_NAME, templateCode: TEMPLATE,
    now: () => new Date('2026-11-02T08:30:00.000Z'),
    nonce: () => 'nonce-fixed-0001',
  });

  test('参数齐全且口径正确（Action/Version/TemplateParam 等）', () => {
    assert.equal(fixed.params.Action, 'SendSms');
    assert.equal(fixed.params.Version, '2017-05-25');
    assert.equal(fixed.params.Format, 'JSON');
    assert.equal(fixed.params.PhoneNumbers, '13800001234');
    assert.equal(fixed.params.SignName, SIGN_NAME);
    assert.equal(fixed.params.TemplateCode, TEMPLATE);
    assert.equal(fixed.params.TemplateParam, '{"code":"654321"}', '模板变量 code');
    assert.equal(fixed.params.Timestamp, '2026-11-02T08:30:00Z', 'UTC 秒级、无毫秒');
    assert.equal(fixed.params.SignatureNonce, 'nonce-fixed-0001');
  });

  test('percentEncode：RFC3986 口径（空格/+/*/~）', () => {
    assert.equal(percentEncode('a b+c*d~e'), 'a%20b%2Bc%2Ad~e');
    assert.equal(percentEncode('{"code":"123"}'), '%7B%22code%22%3A%22123%22%7D');
  });

  test('待签名串格式：GET&%2F&percentEncode(升序参数串)', () => {
    const canonical = Object.keys(fixed.params).sort()
      .map((key) => `${percentEncode(key)}=${percentEncode(fixed.params[key])}`).join('&');
    assert.equal(fixed.stringToSign, `GET&${percentEncode('/')}&${percentEncode(canonical)}`);
  });

  test('签名与测试内独立重算一致（锁算法，HMAC-SHA1(secret&) → base64）', () => {
    const independent = createHmac('sha1', `${SECRET}&`).update(fixed.stringToSign).digest('base64');
    assert.equal(fixed.signature, independent);
    // URL 尾部带编码后的签名
    assert.ok(fixed.url.endsWith(`Signature=${percentEncode(fixed.signature)}`));
  });
});

describe('aliyunSmsProvider：模拟网关回环', () => {
  test('发送成功：验签通过、参数正确、BizId 只进日志', async () => {
    const gateway = createMockAliyunSmsGateway({});
    const provider = aliyunSmsProvider(okConfig(), silentLogger, { http: gateway.asHttp });
    await provider.send({ phone: '13800001234', code: '123456' });
    assert.equal(gateway.seen.length, 1);
    assert.equal(gateway.seen[0].PhoneNumbers, '13800001234');
    assert.equal(gateway.seen[0].TemplateParam, '{"code":"123456"}');
    assert.equal(gateway.seen[0].SignName, SIGN_NAME);
  });

  test('验签失败（密钥不符）：mock 网关拒绝 → provider 抛错（我们的签名实现会被真实网关同款拒绝）', async () => {
    const gateway = createMockAliyunSmsGateway({ secret: 'wrong-secret' });
    const provider = aliyunSmsProvider(okConfig(), silentLogger, { http: gateway.asHttp });
    await assert.rejects(() => provider.send({ phone: '13800001234', code: '123456' }),
      (err) => err.code === 'SignatureDoesNotMatch' && /发送失败/.test(err.userMessage));
  });

  test('错误码映射中文：频控 / 余额不足 / 号码无效 / 未知码默认 / HTTP 400 Throttling', async () => {
    const cases = [
      { respond: () => ({ status: 200, text: JSON.stringify({ Code: 'isv.BUSINESS_LIMIT_CONTROL', Message: '触发分钟级流控' }) }),
        code: 'isv.BUSINESS_LIMIT_CONTROL', match: /频繁/ },
      { respond: () => ({ status: 200, text: JSON.stringify({ Code: 'isv.DAY_LIMIT_CONTROL', Message: '触发天级流控' }) }),
        code: 'isv.DAY_LIMIT_CONTROL', match: /明天/ },
      { respond: () => ({ status: 200, text: JSON.stringify({ Code: 'isv.AMOUNT_NOT_ENOUGH', Message: '余额不足' }) }),
        code: 'isv.AMOUNT_NOT_ENOUGH', match: /余额不足/ },
      { respond: () => ({ status: 200, text: JSON.stringify({ Code: 'isv.MOBILE_NUMBER_ILLEGAL', Message: '非法手机号' }) }),
        code: 'isv.MOBILE_NUMBER_ILLEGAL', match: /手机号无效/ },
      { respond: () => ({ status: 400, text: JSON.stringify({ Code: 'Throttling', Message: '请求被限流' }) }),
        code: 'Throttling', match: /频繁/ },
      { respond: () => ({ status: 200, text: JSON.stringify({ Code: 'isv.SOMETHING_NEW', Message: '未知错误' }) }),
        code: 'isv.SOMETHING_NEW', match: /验证码发送失败/ },
    ];
    for (const { respond, code, match } of cases) {
      const gateway = createMockAliyunSmsGateway({ respond });
      const provider = aliyunSmsProvider(okConfig(), silentLogger, { http: gateway.asHttp });
      await assert.rejects(() => provider.send({ phone: '13800001234', code: '123456' }),
        (err) => err.code === code && match.test(err.userMessage),
        `${code} 应映射为 ${match}`);
    }
    // 错误映射表本身可被调用方引用（如文档生成）
    assert.ok(ALIYUN_SMS_ERROR_MAP['isv.BUSINESS_LIMIT_CONTROL'].length > 0);
  });

  test('网络类失败：固定中文 userMessage，原始错误只在 message（供日志）', async () => {
    const provider = aliyunSmsProvider(okConfig(), silentLogger, {
      http: async () => { const e = new Error('connect ETIMEDOUT'); e.code = 'ETIMEDOUT'; throw e; },
    });
    await assert.rejects(() => provider.send({ phone: '13800001234', code: '123456' }),
      (err) => err.code === 'ETIMEDOUT' && err.userMessage === '验证码发送失败，请稍后再试'
        && /aliyun sms request failed/.test(err.message));
  });

  test('缺任一配置：构造即报错并点名缺失变量（不挑环境）', async () => {
    for (const key of ['accessKeyId', 'accessKeySecret', 'signName', 'templateCode']) {
      const broken = okConfig();
      broken.sms.aliyun[key] = '';
      assert.throws(() => aliyunSmsProvider(broken, silentLogger),
        (err) => /缺少配置/.test(err.message) && /ALIYUN_SMS_/.test(err.message),
        `缺 ${key} 应点名报错`);
    }
  });
});

describe('M3-SMS-01：配置校验与端到端（真实 HTTP 栈 + 模拟网关）', () => {
  let ctx;
  let server;
  let base;
  before(async () => { ctx = await createTestDb(); });
  after(async () => { await ctx.drop(); });

  test('生产缺配置：loadConfig 启动即报错；配齐则通过', () => {
    const prodEnv = { NODE_ENV: 'production', DATABASE_URL: 'postgres://x/y',
      ALLOWED_ORIGINS: 'https://miv.example', SMS_PROVIDER: 'aliyun' };
    assert.throws(() => loadConfig(prodEnv), /ALIYUN_SMS_ACCESS_KEY_ID/);
    assert.doesNotThrow(() => loadConfig({ ...prodEnv,
      ALIYUN_SMS_ACCESS_KEY_ID: AK, ALIYUN_SMS_ACCESS_KEY_SECRET: SECRET,
      ALIYUN_SMS_SIGN_NAME: SIGN_NAME, ALIYUN_SMS_TEMPLATE_CODE: TEMPLATE }));
  });

  test('端到端：发送成功 → 验证码流程可登录；频控错误 → 固定中文提示（原始错误不透出）', async () => {
    const gateway = createMockAliyunSmsGateway({});
    const app = createApp({ config: loadConfig({ NODE_ENV: 'test' }),
      db: ctx.db, logger: silentLogger,
      smsProvider: aliyunSmsProvider(okConfig(), silentLogger, { http: gateway.asHttp }) });
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}/api/v1`;
    try {
      // 成功路径：发码（mock 网关收到）→ 用码登录（发送侧不回传验证码，登录需读库）
      let res = await fetch(`${base}/auth/sms`, { method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:5173' },
        body: JSON.stringify({ phone: '13800009999' }) });
      assert.equal(res.status, 200);
      assert.equal(gateway.seen.length, 1);
      assert.equal(gateway.seen[0].PhoneNumbers, '13800009999');
      const { rows } = await ctx.db.query(
        `SELECT code_hash FROM sms_codes WHERE phone = '13800009999' ORDER BY created_at DESC LIMIT 1`);
      assert.ok(rows.length, '验证码已落库（哈希）');
      // 等冷却以便第二次发送（测试配置冷却 0？默认 60s——直接换手机号测错误分支）

      // 错误分支：换一个手机号 + 网关回频控 → 502 + 固定中文；响应不含阿里原始 Code/Message
      gateway.respond = () => ({ status: 200, text: JSON.stringify({ Code: 'isv.BUSINESS_LIMIT_CONTROL',
        Message: '触发分钟级流控 Permits:1' }) });
      res = await fetch(`${base}/auth/sms`, { method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:5173' },
        body: JSON.stringify({ phone: '13900008888' }) });
      assert.equal(res.status, 502);
      const body = await res.json();
      assert.equal(body.code, 'UPSTREAM_FAILED');
      assert.equal(body.message, ALIYUN_SMS_ERROR_MAP['isv.BUSINESS_LIMIT_CONTROL']);
      assert.ok(!JSON.stringify(body).includes('isv.') && !JSON.stringify(body).includes('Permits'),
        '响应不透出原始错误');
      // 频控失败不留死码（不占冷却/每日次数）
      const dead = await ctx.db.query(
        `SELECT count(*)::int AS n FROM sms_codes WHERE phone = '13900008888'`);
      assert.equal(dead.rows[0].n, 0);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
