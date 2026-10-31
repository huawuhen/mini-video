// 公众号静默网页授权（M3-PAY-01，docs/API.md §3.1 /wechat/oauth/*）：
// snsapi_base（不弹确认框）只用来取 openid，供 JSAPI 支付使用；不取昵称头像等资料。
// code 换 openid 走微信 sns/oauth2/access_token；接口约定：HTTP 200 + errcode 字段表示业务失败。
import { WechatPayError } from './wechat-pay.js';

async function defaultHttp({ method, url, headers, body }) {
  const response = await fetch(url, { method, headers, body: body || undefined,
    signal: AbortSignal.timeout(10_000) });
  return { status: response.status, text: () => response.text() };
}

/**
 * createWechatOAuth（ARCHITECTURE 签名）：{ appid, secret, http }
 *   → { authorizeUrl, openidByCode }
 * authorizeUrl({ redirectUri, state })：302 目标（#wechat_redirect 结尾，微信要求）。
 * openidByCode(code)：换 openid；code 无效/已用过等按 errcode 抛错（中文文案给用户）。
 */
export function createWechatOAuth({
  appid, secret,
  http = defaultHttp,
  authorizeBaseUrl = 'https://open.weixin.qq.com/connect/oauth2/authorize',
  apiBaseUrl = 'https://api.weixin.qq.com',
}) {
  if (!appid || !secret) throw new WechatPayError('CONFIG_MISSING', '公众号授权缺少 appid/secret');

  function authorizeUrl({ redirectUri, state }) {
    if (!redirectUri || !state) throw new WechatPayError('CONFIG_MISSING', 'authorizeUrl 需要 redirectUri 与 state');
    const params = new URLSearchParams({
      appid, redirect_uri: redirectUri, response_type: 'code',
      scope: 'snsapi_base', state,
    });
    return `${authorizeBaseUrl}?${params.toString()}#wechat_redirect`;
  }

  async function openidByCode(code) {
    const params = new URLSearchParams({
      appid, secret, code, grant_type: 'authorization_code',
    });
    const response = await http({ method: 'GET', url: `${apiBaseUrl}/sns/oauth2/access_token?${params}`,
      headers: { Accept: 'application/json' } });
    const text = await response.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new WechatPayError('OAUTH_RESPONSE_INVALID', '微信授权接口返回非 JSON');
    }
    // 微信此接口错误时也是 HTTP 200 + errcode（40029 code 无效；40163 code 已使用等）
    if (parsed.errcode) {
      throw new WechatPayError('OAUTH_CODE_INVALID',
        `微信授权失败（${parsed.errcode}）：${parsed.errmsg ?? 'code 无效或已使用'}`);
    }
    if (!parsed.openid) throw new WechatPayError('OAUTH_RESPONSE_INVALID', '微信授权返回缺少 openid');
    return { openid: parsed.openid };
  }

  return { authorizeUrl, openidByCode };
}
