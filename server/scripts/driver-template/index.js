// __PROTOCOL__ 驱动——<一句话协议说明；官方文档链接>。
// 由 `npm run driver:new -- __PROTOCOL__` 生成：填空后跑 driver.test.js（契约套件必须全绿），
// 再在渠道里登记使用（后台 / CLI），不需要改任何业务代码。
// 硬性约束（ARCHITECTURE §5.5）：不引入厂商 SDK，一律走共用 HTTP 层（createChannelHttp）；
// 厂商差异只留在本目录内；用户可见文案不出现渠道/厂商名。
import { ProviderError } from '../../contract.js';
import { createChannelHttp } from '../../transport.js';

export const DEFAULT_PARAMS = Object.freeze({
  // model: '…', requestTimeoutMs: 180_000,
});

export default {
  id: '__PROTOCOL__',
  kinds: ['video'], // 按协议实际能力改：video | image | llm（可多选）
  configSchema: {
    baseUrl: 'url',
    credential: 'secret',
    modelMap: 'models', // { "video": "…" } / { "image": "…" } / { "llm": "…" }
    params: {
      // requestTimeoutMs: 'int（缺省 180000）',
    },
  },

  create(channel, { logger, deps = {} } = {}) {
    const params = { ...DEFAULT_PARAMS, ...(channel.params ?? {}) };
    const model = channel.modelMap?.video ?? params.model;
    const http = createChannelHttp({
      baseUrl: channel.baseUrl, credential: channel.credential,
      timeoutMs: params.requestTimeoutMs, fetchImpl: deps.fetchImpl,
    });

    return {
      id: `__PROTOCOL__/${model}`,
      kind: 'video',

      capabilities() {
        return {
          model,
          durations: [],   // 允许的单段时长（秒），如 [5, 10, 15, 30]
          resolutions: [], // 如 ['480p', '720p']
          ratios: [],      // 如 ['9:16', '16:9', '1:1']
          refImages: 0,    // 参考图上限
          refAudio: 0,     // 参考音频上限
          withAudio: true, // 是否原生出声
        };
      },

      prepare(input, sku = {}) {
        // 组装协议请求体；校验输入（提示词/时长/分辨率/画幅），不合法抛
        // ProviderError({ code: 'PROVIDER_INPUT_INVALID', submitted: false })
        void input; void sku;
        throw new Error('TODO: 按协议实现 prepare');
      },

      async submit(prepared, { idempotencyKey } = {}) {
        // 明确拒绝 → 返回 { status: 'failed', error: 中文提示, providerMessage? }
        // 连接失败/429 → 抛 ProviderError({ submitted: false, retryable: true })
        // 超时/5xx/受理后断连 → 抛 ProviderError({ submitted: true })（unknown 冻结，绝不自动重提）
        // 成功 → { status: 'running', upstreamId, raw }
        void prepared; void idempotencyKey;
        throw new Error('TODO: 按协议实现 submit');
      },

      async query(upstreamId) {
        // running / succeeded（outputs: [{ kind: 'video', url }], usage?）/ failed / unknown；
        // 查询网络失败 → 抛 retryable（任务仍在渠道侧，继续轮询）
        void upstreamId;
        throw new Error('TODO: 按协议实现 query');
      },

      normalize(raw) { return raw; },

      // 可选：免费目录接口（channel:test 用）
      // async catalog() { const { ok, status, data } = await http.request('<目录路径>');
      //   return { models: […] }; },
    };
  },
};
