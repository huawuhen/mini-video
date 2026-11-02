// 支付环境判定（M3-PAY-03，API §3.1）：按打开环境自动选支付方式。
// 微信内置浏览器 → jsapi（需 openid，无则先静默授权）；手机系统浏览器 → h5
// （未开通时提示在微信中打开本页面）；其余（PC）→ native 扫码。
import type { PayScene } from '@/api';

export const isWechatBrowser = /MicroMessenger/i.test(typeof navigator === 'undefined' ? '' : navigator.userAgent);
// 只按 UA 判移动端（手机 UA 必带 Mobile/iPhone/Android 等字样；不能用窗口尺寸回退——
// 普通笔记本 1470×736 的高度小于 768 会被误判成手机，PC 就提示「在微信中打开」了）
export const isMobileBrowser = typeof navigator !== 'undefined'
  && /Android|iPhone|iPad|ipod|Mobile/i.test(navigator.userAgent);

export type SceneChoice =
  | { scene: PayScene; hint?: undefined }                        // 可直接下单
  | { scene?: undefined; hint: 'wechat-only' | 'unavailable' };  // 不可下单，给用户指引

/** 从已开通 scenes 里按环境选一个；不可用时给出原因（充值页展示对应提示）。 */
export function pickScene(scenes: PayScene[]): SceneChoice {
  if (!scenes.length) return { hint: 'unavailable' };
  if (isWechatBrowser) {
    if (scenes.includes('jsapi')) return { scene: 'jsapi' };
    return { hint: 'wechat-only' }; // 微信内但 JSAPI 未开通（配置异常），提示暂不可用
  }
  if (isMobileBrowser) {
    if (scenes.includes('h5')) return { scene: 'h5' };
    return { hint: 'wechat-only' }; // 手机系统浏览器但 H5 未开通 → 提示「请在微信中打开」
  }
  if (scenes.includes('native')) return { scene: 'native' };
  if (scenes.includes('h5')) return { scene: 'h5' };
  return { hint: 'unavailable' };
}
