// aiide-ark 驱动——火山方舟（Ark）内容生成视频协议 + 素材库过审（经 aiide 网关，M2-BE-03 由
// M2-BE-01 的 aiide 适配器平移；真实冒烟与端到端已验证，见 docs/m0/channel-aiide.md）。
// 官方文档 https://aiide.apifox.cn/chinese/464722026e0 与 464722027e0（2026-10-23 核对）：
//   提交 POST /v1/video/generations
//     { model, prompt, metadata: { content: [{ type: image_url|video_url|audio_url, <type>: { url }, role }],
//                                  generate_audio, ratio, duration(秒,整数), resolution(480p|720p|1080p), watermark } }
//     → { id, task_id, object: 'video', model, status, progress, created_at }
//   轮询 GET /v1/video/generations/{task_id}
//     → { code, message, data: { task_id, status: NOT_START|SUBMITTED|QUEUED|IN_PROGRESS|SUCCESS|FAILURE|UNKNOWN,
//                                 fail_reason, data: { status: queued|running|succeeded|failed|expired,
//                                                      content: { video_url }, usage: { total_tokens } } } }
//   目录 GET /v1/models（免费，channel:test 用）
// 错误口径（业务层约定，厂商差异只留在本驱动内）：上游**明确拒绝** → 返回 { status: 'failed' }
//   （该段失败退回，不冻结）；连接失败/429/素材库暂不可用 → retryable 抛出（明确未提交）；
//   超时/5xx/受理后断连 → unknown（不重提，冻结待对账）。用户可见文案不出现渠道/厂商名。
// 按 token 计费（定价页 $9.63/M，2026-10-23 核对），usage 透传给上层记账。
import { ProviderError } from '../../contract.js';
import { createChannelHttp } from '../../transport.js';
import { createMaterials } from './materials.js';

const RESOLUTIONS = new Set(['480p', '720p', '1080p']);
const OUTER_RUNNING = new Set(['not_start', 'submitted', 'queued', 'in_progress', 'unknown', 'pending', 'running']);
const OUTER_SUCCESS = new Set(['success', 'succeeded', 'completed']);
const OUTER_FAILURE = new Set(['failure', 'failed', 'error', 'rejected', 'cancelled', 'canceled', 'expired']);
const CONTENT_FIELD = { image: 'image_url', video: 'video_url', audio: 'audio_url' };

const short = (value) => {
  if (value === undefined || value === null) return undefined;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.slice(0, 200);
};
const isHttpUrl = (value) => typeof value === 'string' && /^https?:\/\//i.test(value);
const isAssetRef = (value) => typeof value === 'string' && /^asset:\/\//i.test(value);

/** 从轮询响应里取成片地址：只接受 http(s) 且不带用户名密码的链接。 */
export function pickVideoUrl(payload) {
  const inner = payload?.data ?? payload;
  const candidates = [inner?.content?.video_url, inner?.video_url, inner?.url, payload?.video_url, payload?.url];
  for (const candidate of candidates) {
    if (!isHttpUrl(candidate)) continue;
    try {
      const parsed = new URL(candidate);
      if (!parsed.username && !parsed.password) return parsed.toString();
    } catch { /* 下一个候选 */ }
  }
  return null;
}

export const DEFAULT_PARAMS = Object.freeze({
  model: 'dreamina-seedance-2-5-hc',
  generateAudio: true,
  watermark: false,
  requestTimeoutMs: 180_000,
  materialsPollIntervalMs: 2_000,
  materialsPollTimeoutMs: 180_000,
  materialsPurpose: 'Mini AI Video 参考素材',
});

export default {
  id: 'aiide-ark',
  kinds: ['video'],
  configSchema: {
    baseUrl: 'url',
    credential: 'secret',
    modelMap: 'models', // { "video": "dreamina-seedance-2-5-hc" }，优先于 params.model
    params: {
      model: 'string（缺省 dreamina-seedance-2-5-hc）',
      generateAudio: 'boolean（缺省 true；对白口型同步依赖原生音频）',
      watermark: 'boolean（缺省 false）',
      requestTimeoutMs: 'int（缺省 180000）',
      materialsPollIntervalMs: 'int（素材库过审轮询间隔，缺省 2000）',
      materialsPollTimeoutMs: 'int（素材过审等待上限，缺省 180000；超时按未提交交队列重试）',
      materialsPurpose: 'string（素材库登记用途说明）',
    },
  },

  /** @param channel 渠道记录（凭证已解密） @param ctx { logger, deps: { fetchImpl, sleep } } */
  create(channel, { logger, deps = {} } = {}) {
    const params = { ...DEFAULT_PARAMS, ...(channel.params ?? {}) };
    const model = channel.modelMap?.video ?? params.model;
    const http = createChannelHttp({
      baseUrl: channel.baseUrl, credential: channel.credential,
      timeoutMs: params.requestTimeoutMs, fetchImpl: deps.fetchImpl,
    });
    const materials = createMaterials({
      http, logger,
      pollIntervalMs: params.materialsPollIntervalMs,
      pollTimeoutMs: params.materialsPollTimeoutMs,
      purpose: params.materialsPurpose,
      sleep: deps.sleep,
    });
    return {
      id: `aiide-ark/${model}`,
      kind: 'video',

      capabilities() {
        return {
          model,
          durations: [5, 10, 15, 30],          // M0 实测 seedance 系 4~30 秒整数；产品 SKU 取 {5,10,15,30}
          resolutions: ['480p', '720p', '1080p'],
          ratios: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'],
          refImages: 30,                        // M0-02 目录快照：seedance 参考图上限
          refAudio: 10,
          withAudio: params.generateAudio,
        };
      },

      /** 组装方舟请求体；imageRefs 顺序即「图1、图2…」（尾帧由上层排最前），audioRefs 为「音频1…」。 */
      prepare(input, sku = {}) {
        const prompt = String(input.prompt ?? '').trim();
        if (!prompt) throw new ProviderError('视频提示词不能为空。', { code: 'PROVIDER_INPUT_INVALID', submitted: false });
        const duration = Number(input.durationSeconds);
        if (!Number.isInteger(duration) || duration <= 0) {
          throw new ProviderError('视频时长不合法。', { code: 'PROVIDER_INPUT_INVALID', submitted: false });
        }
        if (Array.isArray(sku.durations) && sku.durations.length && !sku.durations.includes(duration)) {
          throw new ProviderError('片段时长不符合 SKU 允许值。', { code: 'PROVIDER_INPUT_INVALID', submitted: false });
        }
        const resolution = String(input.resolution ?? sku.resolution ?? '').toLowerCase();
        if (!RESOLUTIONS.has(resolution)) {
          throw new ProviderError('视频分辨率不受支持。', { code: 'PROVIDER_INPUT_INVALID', submitted: false, providerMessage: resolution });
        }
        const ratio = String(input.ratio ?? '').trim();
        if (!/^\d+:\d+$/.test(ratio)) throw new ProviderError('视频画幅缺失或不合法。', { code: 'PROVIDER_INPUT_INVALID', submitted: false });
        const refs = (keys, type) => (keys ?? [])
          .filter((value) => isHttpUrl(value) || isAssetRef(value))
          .map((url) => ({ type: CONTENT_FIELD[type], [CONTENT_FIELD[type]]: { url }, role: `reference_${type}` }));
        const content = [...refs(input.imageRefs, 'image'), ...refs(input.videoRefs, 'video'), ...refs(input.audioRefs, 'audio')];
        return {
          model,
          prompt,
          metadata: {
            content,
            generate_audio: params.generateAudio,
            ratio,
            duration,
            resolution,
            watermark: params.watermark,
          },
        };
      },

      /** 素材过审 → 提交。明确拒绝返回 failed；未提交且可重试抛出；结果不确定按 unknown。 */
      async submit(prepared, { idempotencyKey } = {}) {
        void idempotencyKey; // 协议无幂等键头：重提防护靠 gen_tasks 状态守卫（产品层）
        let body;
        try {
          body = await resolveMaterials(prepared, materials);
        } catch (error) {
          // 素材库错误按鸭子类型分类（retryable → 未提交可重试；其余有 code 的明确失败 → 返回 failed 不冻结）
          if (!(error instanceof Error)) throw error;
          if (error.retryable === true) throw error;
          if (!error.code) throw error; // 无分类信息的异常照抛（编程错误）
          // 文案按原因区分（日志字段不用 code 命名，logger 会把它当密钥脱敏）
          let message = '参考素材未通过渠道审核，请更换形象或照片后重试。';
          if (['PROVIDER_CONFIG_INVALID', 'PROVIDER_INPUT_INVALID'].includes(error.code)) {
            logger?.error?.('ark_material_invalid', { errorCode: error.code, message: error.message, detail: error.providerMessage });
            message = '参考素材格式不符合渠道要求，请联系客服。';
          } else {
            logger?.warn?.('ark_material_rejected', { errorCode: error.code, detail: error.providerMessage });
          }
          return { status: 'failed', error: message,
            providerMessage: error.providerMessage ?? error.message, providerCode: error.code };
        }

        const { status, ok, data, rawText } = await http.request('/v1/video/generations', { method: 'POST', body });
        if (status === 429) {
          throw new ProviderError('生成渠道请求过于频繁，请稍后重试。', {
            code: 'PROVIDER_RATE_LIMITED', submitted: false, retryable: true, status,
          });
        }
        if (status >= 300 && status < 400) {
          throw new ProviderError('生成渠道重定向结果不确定。', { code: 'SUBMISSION_UNKNOWN', submitted: true, status });
        }
        if (status >= 400 && status < 500 && status !== 408) {
          if ([401, 403].includes(status)) logger?.error?.('ark_auth_rejected', { status });
          return { status: 'failed', error: '视频生成请求被渠道拒绝，请稍后重试。', httpStatus: status,
            providerMessage: short(data?.error?.message ?? data?.message ?? rawText),
            providerCode: short(String(data?.error?.code ?? data?.code ?? '')) };
        }
        if (!ok) throw new ProviderError('生成渠道受理结果不确定。', { code: 'SUBMISSION_UNKNOWN', submitted: true, status });
        if (data?.error) {
          return { status: 'failed', error: '视频生成请求被渠道拒绝，请稍后重试。',
            providerMessage: short(data.error.message ?? data.error), providerCode: short(String(data.error.code ?? '')) };
        }
        const taskId = data?.task_id ?? data?.id ?? data?.data?.task_id ?? data?.data?.id;
        if (!taskId || typeof taskId !== 'string') {
          throw new ProviderError('生成渠道未返回任务编号。', { code: 'SUBMISSION_UNKNOWN', submitted: true });
        }
        return { status: 'running', upstreamId: taskId, raw: data };
      },

      /** 轮询：排队/处理中 → running；成功且有地址 → succeeded（含 usage）；失败/过期 → failed；
       * 成功无地址 → unknown；单次查询网络/5xx 失败 → retryable 抛出（任务已在渠道侧，绝不因查询失败冻结）。 */
      async query(upstreamId) {
        let result;
        try {
          result = await http.request(`/v1/video/generations/${encodeURIComponent(upstreamId)}`);
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
        const task = data.data && typeof data.data === 'object' ? data.data : data;
        const inner = task.data && typeof task.data === 'object' ? task.data : {};
        const outer = String(task.status ?? '').toLowerCase();
        const innerState = String(inner.status ?? '').toLowerCase();
        // 文档示例里成功任务的 fail_reason 字段放着成片链接（渠道侧字段错位），成功态下作最后候选
        const videoUrl = pickVideoUrl(task)
          ?? (OUTER_SUCCESS.has(outer) && isHttpUrl(task.fail_reason) ? pickVideoUrl({ url: task.fail_reason }) : null);
        const usage = inner.usage && typeof inner.usage === 'object' ? inner.usage : undefined;

        if (OUTER_FAILURE.has(outer) || OUTER_FAILURE.has(innerState)) {
          return { status: 'failed', error: '视频生成失败，请稍后重试。',
            providerMessage: short(task.fail_reason ?? inner.error?.message ?? inner.error ?? data.message) };
        }
        if (videoUrl) {
          return { status: 'succeeded', outputs: [{ kind: 'video', url: videoUrl }], ...(usage ? { usage } : {}), raw: task };
        }
        if (OUTER_SUCCESS.has(outer) || OUTER_SUCCESS.has(innerState)) {
          return { status: 'unknown', providerMessage: '完成态未返回结果地址' };
        }
        if (OUTER_RUNNING.has(outer) || OUTER_RUNNING.has(innerState) || (!outer && !innerState)) {
          return { status: 'running', ...(task.progress ? { progress: String(task.progress) } : {}) };
        }
        logger?.warn?.('ark_status_unrecognized', { upstreamId, outer, innerState });
        return { status: 'running' };
      },

      normalize(raw) { return raw; },

      /** 免费模型目录（channel:test / 调价对账用）：GET /v1/models → { data: [{ id }] }。 */
      async catalog() {
        const { ok, status, data } = await http.request('/v1/models');
        if (!ok || !Array.isArray(data?.data)) {
          throw new ProviderError(`模型目录不可用（HTTP ${status ?? 'ERR'}）。`, {
            code: 'PROVIDER_QUERY_FAILED', submitted: false,
          });
        }
        return { models: data.data.map((item) => ({ name: String(item.id ?? item.model ?? '') })).filter((m) => m.name) };
      },
    };
  },
};

/** 参考素材过审：http(s) 链接 → asset://；已是 asset:// 原样。未注入 materials 时直接传链接（测试）。 */
async function resolveMaterials(prepared, materials) {
  if (!materials) return prepared;
  const content = [];
  for (const item of prepared.metadata.content) {
    const type = String(item.type ?? '').replace(/_url$/, '');
    const field = CONTENT_FIELD[type];
    const url = item?.[field]?.url;
    if (!field || !isHttpUrl(url)) { content.push(item); continue; }
    const assetRef = await materials.register(url, type);
    content.push({ ...item, [field]: { ...item[field], url: assetRef } });
  }
  return { ...prepared, metadata: { ...prepared.metadata, content } };
}
