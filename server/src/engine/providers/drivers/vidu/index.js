// vidu 驱动——Vidu 开放平台 Q3 系列视频生成协议（M3-ENG-01，2026-11-12 接入）。
// 官方文档 https://platform.vidu.cn/docs/api-reference（2026-11-12 核对）：
//   参考生 POST /ent/v2/reference2video
//     { model, images: [URL|base64]（1~7 张）, prompt, audio, duration, aspect_ratio,
//       resolution(540p|720p|1080p), off_peak, watermark }
//     → { task_id, state: created|queueing|processing|success|failed, credits, created_at }
//   文生   POST /ent/v2/text2video（仅 viduq3-pro / viduq3-turbo 支持）
//   轮询   GET /ent/v2/tasks/{id}/creations
//     → { id, state, err_code, credits, creations: [{ id, url, cover_url, watermarked_url }] }
//   余额   GET /ent/v2/credits（免费，channel:test 用）→ { remains: [{ credit_remain, ... }] }
//   鉴权   Authorization: Token {key}（非 Bearer；经 transport 逐请求覆盖请求头）
// 接口选型（详见本目录 README）：管线提示词按「图N 主体参考」语义拼装，与参考生的主体一致性
//   能力对齐，故有参考图一律走 reference2video；无参考图回退 text2video。尾帧作为第 1 张参考图
//   传入（产品口径「尽力而为，不保证首帧衔接」，此处进一步弱化为「参考条件」）。
// 错误口径（与 aiide-ark 一致）：上游明确拒绝 → { status: 'failed' }（不冻结）；连接失败/429 →
//   retryable 抛出（明确未提交）；超时/5xx/受理后断连 → unknown（不重提，冻结待对账）。
// 计费：按积分（定价页 1 积分 = 0.03125 元，2026-11-12 核对），失败不计积分；轮询透传 credits
//   到 usage 供成本校准。用户可见文案不出现渠道/厂商名。
import { ProviderError } from '../../contract.js';
import { createChannelHttp } from '../../transport.js';

const RATIOS = new Set(['1:1', '16:9', '9:16', '4:3', '3:4']);
// 产品口径分辨率 → Vidu 分辨率。SKU video.480p 对应 Vidu 540p（高于 SKU 名义值，对用户只升不降）。
const RESOLUTION_MAP = { '480p': '540p', '720p': '720p', '1080p' : '1080p' };

// 各模型能力表（接口文档「枚举值」与各模型小节，2026-11-12 核对）：
//   ref/text —— 是否支持参考生/文生；refSeconds/textSeconds —— 时长闭区间；
//   resolutions —— Vidu 侧可选分辨率；promptMaxChars —— 提示词上限（turbo 参考生 5000，其余 20000）。
// viduq3-pro-fast（仅图生）、viduq3-mix（仅参考生且 720p 起步、单价高）暂不开放：场景不匹配或无性价比，
//   配置成这两个值会在 create 时被拒（避免「能建渠道、全部任务失败」的静默坑）。
const MODELS = {
  'viduq3-turbo': { ref: true, text: true, refSeconds: [3, 15], textSeconds: [1, 16],
    resolutions: new Set(['540p', '720p', '1080p']), promptMaxChars: 5000 },
  'viduq3': { ref: true, text: false, refSeconds: [3, 16],
    resolutions: new Set(['540p', '720p', '1080p']), promptMaxChars: 20000 },
  'viduq3-pro': { ref: false, text: true, textSeconds: [1, 16],
    resolutions: new Set(['540p', '720p', '1080p']), promptMaxChars: 20000 },
};

export const DEFAULT_PARAMS = Object.freeze({
  model: 'viduq3-turbo',   // 主力：音画同出（默认 audio=true）+ 智能切镜，性价比最高
  audio: true,             // 音视频直出：台词 + 背景音（对白已由提示词嵌入，见 engine README）
  offPeak: false,          // 错峰半价但 48h 内出片：仅适合后台批量，交互路径必须 false
  watermark: false,        // 渠道侧「内容由AI生成」水印；AI 标识由成片渲染层统一处理
  requestTimeoutMs: 180_000,
});

const short = (value) => {
  if (value === undefined || value === null) return undefined;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.slice(0, 200);
};
const isHttpUrl = (value) => typeof value === 'string' && /^https?:\/\//i.test(value);

/** 从轮询响应里取成片地址：只接受 http(s) 且不带用户名密码的链接（Vidu 为 https 资源）。 */
export function pickVideoUrl(payload) {
  for (const creation of Array.isArray(payload?.creations) ? payload.creations : []) {
    const url = creation?.url;
    if (!isHttpUrl(url)) continue;
    try {
      const parsed = new URL(url);
      if (!parsed.username && !parsed.password) return parsed.toString();
    } catch { /* 下一个候选 */ }
  }
  return null;
}

/** 查询状态 → 业务态分类（running / 终态 / 未识别）。 */
const RUNNING_STATES = new Set(['created', 'queueing', 'processing']);

export default {
  id: 'vidu',
  kinds: ['video'],
  configSchema: {
    baseUrl: 'url',        // 官方 API 根地址 https://api.vidu.cn
    credential: 'secret',  // Vidu API Token（控制台 api-keys 页获取）
    modelMap: 'models',    // { "video": "viduq3-turbo" }，优先于 params.model
    params: {
      model: 'string（缺省 viduq3-turbo；可选 viduq3 / viduq3-pro，见 README 能力表）',
      audio: 'boolean（缺省 true；音视频直出：台词与背景音由模型生成）',
      offPeak: 'boolean（缺省 false；true 则 48 小时内出片、积分减半，仅适合非实时批量）',
      watermark: 'boolean（缺省 false；渠道侧水印）',
      requestTimeoutMs: 'int（缺省 180000）',
    },
  },

  /** @param channel 渠道记录（凭证已解密） @param ctx { logger, deps: { fetchImpl, sleep } } */
  create(channel, { logger, deps = {} } = {}) {
    const params = { ...DEFAULT_PARAMS, ...(channel.params ?? {}) };
    const model = channel.modelMap?.video ?? params.model;
    const spec = MODELS[model];
    if (!spec) {
      throw new ProviderError(`渠道模型配置不受支持：${model}`, {
        code: 'PROVIDER_CONFIG_INVALID', submitted: false, providerMessage: model,
      });
    }
    if (!params.audio && params.offPeak) {
      // 官方口径：audio=false 的任务不支持错峰；配置矛盾直接拒绝，避免建渠道后全部失败
      throw new ProviderError('渠道参数矛盾：关闭音频直出时不支持错峰模式。', {
        code: 'PROVIDER_CONFIG_INVALID', submitted: false,
      });
    }
    const http = createChannelHttp({
      baseUrl: channel.baseUrl, credential: channel.credential,
      timeoutMs: params.requestTimeoutMs, fetchImpl: deps.fetchImpl,
    });
    // Vidu 用 Token 方案鉴权（transport 默认 Bearer），逐请求覆盖
    const authHeaders = { Authorization: `Token ${channel.credential}` };

    const fail = (error, fallbackMessage) => ({
      status: 'failed', error: fallbackMessage, httpStatus: error?.status,
      providerMessage: short(error?.data?.message ?? error?.data?.error ?? error?.rawText),
      providerCode: short(String(error?.data?.code ?? '')),
    });

    return {
      id: `vidu/${model}`,
      kind: 'video',

      capabilities() {
        return {
          model,
          durations: [5, 10, 15],               // 产品 SKU 取值；协议支持 3~15（turbo 参考）/3~16/1~16 连续整数
          resolutions: ['480p', '720p', '1080p'], // 产品口径（480p 实际提交为 540p，见 RESOLUTION_MAP）
          ratios: [...RATIOS],
          refImages: 7,                          // 参考生 1~7 张（管线默认上限 9，超出截断并记日志）
          refAudio: 0,                           // 无音频参考入参；音色一致性靠 prompt 台词 + audio（见 README 遗留）
          withAudio: params.audio,
        };
      },

      /** 组装请求体。有参考图走 reference2video（主体参考，≤7 张截断）；无参考图回退 text2video。 */
      prepare(input, sku = {}) {
        const prompt = String(input.prompt ?? '').trim();
        if (!prompt) throw new ProviderError('视频提示词不能为空。', { code: 'PROVIDER_INPUT_INVALID', submitted: false });
        const promptCap = params.promptMaxChars ?? spec.promptMaxChars ?? MODELS['viduq3-turbo'].promptMaxChars;
        if (prompt.length > promptCap) {
          throw new ProviderError('视频提示词超出该渠道长度限制，请缩短剧情后重试。', {
            code: 'PROVIDER_INPUT_INVALID', submitted: false, providerMessage: `${prompt.length}>${promptCap}`,
          });
        }
        const duration = Number(input.durationSeconds);
        if (!Number.isInteger(duration) || duration <= 0) {
          throw new ProviderError('视频时长不合法。', { code: 'PROVIDER_INPUT_INVALID', submitted: false });
        }
        if (Array.isArray(sku.durations) && sku.durations.length && !sku.durations.includes(duration)) {
          throw new ProviderError('片段时长不符合 SKU 允许值。', { code: 'PROVIDER_INPUT_INVALID', submitted: false });
        }
        const images = (input.imageRefs ?? []).filter((value) => isHttpUrl(value));
        if (images.length > 7) {
          // 参考生上限 7 张：保序截断（尾帧排最前，先丢后面的形象图），超出量记日志
          logger?.warn?.('vidu_ref_truncated', { kept: 7, dropped: images.length - 7 });
          images.length = 7;
        }
        // 时长校验按所选接口的区间（参考生/文生）
        const [minSeconds, maxSeconds] = images.length > 0
          ? (spec.refSeconds ?? [0, 0])
          : (spec.textSeconds ?? spec.refSeconds ?? [0, 0]);
        if (minSeconds === 0 || duration < minSeconds || duration > maxSeconds) {
          throw new ProviderError('片段时长不受该渠道支持，请换用其他片段时长后重试。', {
            code: 'PROVIDER_INPUT_INVALID', submitted: false,
            providerMessage: images.length > 0 ? `ref ${duration}s ∉ [${spec.refSeconds}]` : `text ${duration}s ∉ [${spec.textSeconds}]`,
          });
        }
        const resolution = RESOLUTION_MAP[String(input.resolution ?? sku.resolution ?? '').toLowerCase()];
        if (!resolution || !spec.resolutions.has(resolution)) {
          throw new ProviderError('视频分辨率不受支持。', { code: 'PROVIDER_INPUT_INVALID', submitted: false,
            providerMessage: String(input.resolution ?? sku.resolution ?? '') });
        }
        const ratio = String(input.ratio ?? '').trim();
        if (!RATIOS.has(ratio)) throw new ProviderError('视频画幅缺失或不受支持。', { code: 'PROVIDER_INPUT_INVALID', submitted: false });

        if (images.length > 0 && !spec.ref) {
          throw new ProviderError('该渠道模型不支持参考图生成，请调整渠道配置。', {
            code: 'PROVIDER_CONFIG_INVALID', submitted: false });
        }
        if (images.length === 0 && !spec.text) {
          throw new ProviderError('该渠道模型不支持纯文生视频且本段没有参考图，请联系客服。', {
            code: 'PROVIDER_INPUT_INVALID', submitted: false });
        }

        const common = {
          prompt,
          audio: params.audio,
          duration,
          aspect_ratio: ratio,
          resolution,
          off_peak: params.offPeak,
          watermark: params.watermark,
        };
        return images.length > 0
          ? { endpoint: '/ent/v2/reference2video', body: { model, images, ...common } }
          : { endpoint: '/ent/v2/text2video', body: { model, ...common } };
      },

      /** 提交。明确拒绝返回 failed；未提交且可重试抛出；结果不确定按 unknown（绝不自动重提）。 */
      async submit(prepared, { idempotencyKey } = {}) {
        void idempotencyKey; // 协议无幂等键：重提防护靠 gen_tasks 状态守卫（产品层）
        const { status, ok, data, rawText } = await http.request(prepared.endpoint, {
          method: 'POST', body: prepared.body, headers: authHeaders,
        });
        if (status === 429) {
          throw new ProviderError('生成渠道请求过于频繁，请稍后重试。', {
            code: 'PROVIDER_RATE_LIMITED', submitted: false, retryable: true, status,
          });
        }
        if (status >= 300 && status < 400) {
          throw new ProviderError('生成渠道重定向结果不确定。', { code: 'SUBMISSION_UNKNOWN', submitted: true, status });
        }
        if (status >= 400 && status < 500 && status !== 408) {
          const code = String(data?.code ?? '');
          if ([401, 403].includes(status) || code === 'Unauthorized') {
            logger?.error?.('vidu_auth_rejected', { status });
            return fail({ status, data, rawText }, '生成渠道鉴权失败，请检查渠道配置。');
          }
          if (code === 'CreditInsufficient') {
            return fail({ status, data, rawText }, '生成渠道余额不足，请联系客服。');
          }
          return fail({ status, data, rawText }, '视频生成请求被渠道拒绝，请稍后重试。');
        }
        if (!ok) throw new ProviderError('生成渠道受理结果不确定。', { code: 'SUBMISSION_UNKNOWN', submitted: true, status });
        if (data?.state === 'failed') {
          return fail({ status, data, rawText }, '视频生成请求被渠道拒绝，请稍后重试。');
        }
        const taskId = data?.task_id;
        if (!taskId || typeof taskId !== 'string') {
          throw new ProviderError('生成渠道未返回任务编号。', { code: 'SUBMISSION_UNKNOWN', submitted: true });
        }
        return { status: 'running', upstreamId: taskId, raw: data };
      },

      /** 轮询：排队/处理中 → running；成功且有地址 → succeeded（含 credits）；失败 → failed；
       * 成功无地址 → unknown；单次查询网络/5xx 失败 → retryable 抛出（任务已在渠道侧，绝不因查询失败冻结）。
       * 注意：错峰任务 48 小时内可能一直排队，超过产品轮询上限会按 unknown 冻结待对账（见 README）。 */
      async query(upstreamId) {
        let result;
        try {
          result = await http.request(`/ent/v2/tasks/${encodeURIComponent(upstreamId)}/creations`, {
            headers: authHeaders,
          });
        } catch (error) {
          throw new ProviderError('视频任务查询失败。', {
            code: 'PROVIDER_QUERY_FAILED', submitted: true, retryable: true, providerMessage: error?.providerMessage ?? error?.message,
          });
        }
        const { ok, status, data, rawText } = result;
        if ([404, 410].includes(status)) {
          return { status: 'failed', error: '视频任务不存在或已过期。', providerMessage: short(data ?? rawText) };
        }
        if (!ok || !data || typeof data !== 'object') {
          throw new ProviderError('视频任务查询失败。', {
            code: 'PROVIDER_QUERY_FAILED', submitted: true, retryable: true, status, providerMessage: short(data ?? rawText),
          });
        }
        const state = String(data.state ?? '').toLowerCase();
        if (state === 'failed') {
          return { status: 'failed', error: '视频生成失败，请稍后重试。',
            providerMessage: short(data.err_code ?? data.message ?? rawText),
            providerCode: short(String(data.err_code ?? '')) };
        }
        const videoUrl = pickVideoUrl(data);
        if (state === 'success') {
          if (!videoUrl) return { status: 'unknown', providerMessage: '完成态未返回结果地址' };
          const usage = Number.isFinite(data.credits) ? { credits: data.credits } : undefined;
          return { status: 'succeeded', outputs: [{ kind: 'video', url: videoUrl }], ...(usage ? { usage } : {}), raw: data };
        }
        if (RUNNING_STATES.has(state) || (!state && !videoUrl)) {
          return { status: 'running' };
        }
        logger?.warn?.('vidu_status_unrecognized', { upstreamId, state });
        return videoUrl
          ? { status: 'succeeded', outputs: [{ kind: 'video', url: videoUrl }], raw: data }
          : { status: 'running' };
      },

      normalize(raw) { return raw; },

      /** 渠道连通/鉴权测试（免费）：GET /ent/v2/credits。Vidu 无公开模型目录接口，
       * models 以本渠道配置的模型名回显（真实可用性以试生成/冒烟为准，见 README）。 */
      async catalog() {
        const { ok, status, data } = await http.request('/ent/v2/credits', { headers: authHeaders });
        if (!ok || !data || typeof data !== 'object') {
          throw new ProviderError(`渠道连接测试失败（HTTP ${status ?? 'ERR'}）。`, {
            code: 'PROVIDER_QUERY_FAILED', submitted: false,
          });
        }
        const remains = Array.isArray(data.remains) ? data.remains : [];
        return {
          models: [{ name: model }],
          balance: {
            credits: remains.reduce((sum, item) => sum + (Number(item?.credit_remain) || 0), 0),
            concurrency: remains.reduce((max, item) => Math.max(max, Number(item?.concurrency_limit) || 0), 0),
          },
        };
      },
    };
  },
};
