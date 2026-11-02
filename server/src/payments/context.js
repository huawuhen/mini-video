// 支付域装配（M3-PAY-02）：按 config 构造 payClient / oauth / scenes，注入到 API、Worker 与测试。
// 只支持「微信支付公钥」验签模式（M3-PAY-01 审查建议 5：2024 年后新商户默认形态，
// 不做旧平台证书模式）；任一必填缺失 → scenes=[]，在线充值整体关闭（API §3.1）。
// http 为注入点：生产用默认 fetch 封装（微信固定域名，非用户输入 URL），
// 测试注入模拟网关的 asHttp()（零真实费用）。
import { createWechatPayClient } from './wechat-pay.js';
import { createWechatOAuth } from './wechat-oauth.js';
import { resolveScenes } from './scenes.js';

export function createPaymentsContext({ config, http, now = () => Date.now() }) {
  const scenes = resolveScenes(config);
  const base = { scenes, appid: config.wechatMp.appid, apiV3Key: config.payments.apiV3Key, config };
  if (!scenes.length) return { ...base, payClient: null, oauth: null };
  let payClient;
  let oauth;
  try {
    payClient = createWechatPayClient({
      mchid: config.payments.mchid,
      appid: config.wechatMp.appid, // Native/H5 下单同样必须带 appid（复审必改 2 口径）
      privateKey: config.payments.privateKey,
      certSerial: config.payments.certSerial,
      apiV3Key: config.payments.apiV3Key,
      platformPublicKey: config.payments.platformPublicKey,
      platformPublicKeyId: config.payments.platformPublicKeyId,
      ...(http ? { http } : {}),
      now,
    });
    oauth = createWechatOAuth({ appid: config.wechatMp.appid, secret: config.wechatMp.secret,
      ...(http ? { http } : {}) });
  } catch {
    return { ...base, scenes: [], payClient: null, oauth: null }; // 配置不完整/非法：整体关闭
  }
  return { ...base, payClient, oauth };
}
