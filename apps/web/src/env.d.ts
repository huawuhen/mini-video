/// <reference types="vite/client" />
declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<object, object, unknown>;
  export default component;
}
interface ImportMetaEnv { readonly VITE_USE_MOCK?: string }
interface ImportMeta { readonly env: ImportMetaEnv }

// 微信内置浏览器 JSAPI 支付桥（M3-PAY-03；仅微信内存在，由微信注入）
interface WeixinJSBridgePayResult { err_msg: string }
interface WeixinJSBridge {
  invoke(api: 'getBrandWCPayRequest', params: Record<string, string>, callback: (result: WeixinJSBridgePayResult) => void): void;
}
interface Window { WeixinJSBridge?: WeixinJSBridge }
