// 支付方式可用性判定（M3-PAY-01，docs/API.md §3.1 RechargeOptions.scenes）：
// 微信支付任一必填缺失 → scenes=[]（在线充值整体关闭，只保留兑换码），不给半开状态。
// M3-PAY-01 复审必改 2：appid（公众号）是整体必填——Native/H5 下单同样必须带 appid
// （且与商户号绑定），缺它时客户端会拒绝构造，不能让前端看到 native 可用、一下单就 502；
// notifyUrl 必须以 https:// 开头（微信要求公网 HTTPS 回调），否则视为未配置；
// jsapi 额外依赖公众号 secret（静默授权换 openid）；h5 需商户平台另行开通。
const required = (config) => Boolean(
  config?.payments?.mchid && config?.payments?.privateKey && config?.payments?.certSerial
  && config?.payments?.apiV3Key && config?.payments?.platformPublicKey
  && config?.payments?.platformPublicKeyId
  && typeof config?.payments?.notifyUrl === 'string' && config.payments.notifyUrl.startsWith('https://')
  && config?.wechatMp?.appid,
);

/** 返回当前开通的支付方式（固定顺序 jsapi | h5 | native）；缺配置返回 []。 */
export function resolveScenes(config) {
  if (!required(config)) return [];
  const scenes = [];
  if (config.wechatMp.secret) scenes.push('jsapi');
  if (config.payments.h5Enabled) scenes.push('h5');
  scenes.push('native');
  return scenes;
}
