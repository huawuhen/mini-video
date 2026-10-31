// 支付方式可用性判定（M3-PAY-01，docs/API.md §3.1 RechargeOptions.scenes）：
// 微信支付任一必填缺失 → scenes=[]（在线充值整体关闭，只保留兑换码），不给半开状态。
// jsapi 额外依赖公众号静默授权（取 openid）；h5 需商户平台另行申请开通（WXPAY_H5_ENABLED）。
const required = (p) => Boolean(
  p?.mchid && p?.privateKey && p?.certSerial && p?.apiV3Key
  && p?.platformPublicKey && p?.platformPublicKeyId && p?.notifyUrl,
);

/** 返回当前开通的支付方式（固定顺序 jsapi | h5 | native）；缺配置返回 []。 */
export function resolveScenes(config) {
  if (!required(config?.payments)) return [];
  const scenes = [];
  if (config.wechatMp?.appid && config.wechatMp?.secret) scenes.push('jsapi');
  if (config.payments.h5Enabled) scenes.push('h5');
  scenes.push('native');
  return scenes;
}
