// aiide 视频适配器——火山方舟（Ark）内容生成协议（M2-BE-01 渠道切换，替代喵呜）。
// 文档 https://aiide.apifox.cn/chinese/464722026e0 与 464722027e0、定价页代码示例（2026-10-23 核对）：
//   提交 POST /v1/video/generations
//     { model, prompt, metadata: { content: [{ type: image_url|video_url|audio_url, <type>: { url }, role }],
//                                  generate_audio, ratio, duration(秒,整数), resolution(480p|720p|1080p), watermark } }
//     → { id, task_id, object: 'video', model, status, progress, created_at }
//   轮询 GET /v1/video/generations/{task_id}
//     → { code, message, data: { task_id, status: NOT_START|SUBMITTED|QUEUED|IN_PROGRESS|SUCCESS|FAILURE|UNKNOWN,
//                                 fail_reason, data: { status: queued|running|succeeded|failed|expired,
//                                                      content: { video_url }, usage: { total_tokens } } } }
//   参考素材：人脸/虚拟人图片必须先经素材库过审，以 asset://mat_xxx 引用（见 aiide-materials.js）。
// 错误分类与既有适配器同口径，并按 segment.js 的期望：上游**明确拒绝** → 返回 { status: 'failed' }（不抛，
//   抛非 retryable 会被当成 unknown 冻结）；连接失败/429/素材库暂不可用 → retryable 抛出（明确未提交）；
//   超时/5xx/受理后断连 → unknown（不重提，冻结待对账）。按 token 计费（$9.63/M，定价页），usage 透传给上层记账。
import { ProviderError } from './transport.js';

const RESOLUTIONS = new Set(['480p', '720p', '1080p']);
const OUTER_RUNNING = new Set(['not_start', 'submitted', 'queued', 'in_progress', 'unknown', 'pending', 'running']);
const OUTER_SUCCESS = new Set(['success', 'succeeded', 'completed']);
const OUTER_FAILURE = new Set(['failure', 'failed', 'error', 'rejected', 'cancelled', 'canceled', 'expired']);
const NOT_SUBMITTED_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT', 'UND_ERR_CONNECT_TIMEOUT']);
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

export function createAiideVideoAdapter({ baseUrl, apiKey, model = 'dreamina-seedance-2-5-hc', materials,
  fetchImpl = globalThis.fetch, timeoutMs = 180_000, generateAudio = true, watermark = false, logger } = {}) {
  if (!baseUrl || !apiKey) throw new ProviderError('aiide 渠道地址或凭证未配置。', { code: 'PROVIDER_CONFIG_INVALID', submitted: false });
  const root = String(baseUrl).replace(/\/+$/, '');

  async function request(path, { method = 'GET', body } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${root}${path}`, {
        method, signal: controller.signal,
        headers: { Authorization: `Bearer ${apiKey}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = null; }
      return { status: response.status, ok: response.ok, data, rawText: short(text) };
    } catch (error) {
      if (controller.signal.aborted) throw new ProviderError('aiide 渠道请求超时。', { code: 'SUBMISSION_UNKNOWN', submitted: method === 'POST' });
      const code = error?.cause?.code ?? error?.code;
      if (NOT_SUBMITTED_CODES.has(code)) {
        throw new ProviderError('无法连接 aiide 渠道。', { code: 'PROVIDER_NOT_SUBMITTED', submitted: false, retryable: true });
      }
      throw new ProviderError('aiide 渠道受理结果不确定。', { code: 'SUBMISSION_UNKNOWN', submitted: method === 'POST',
        providerMessage: short(error?.message) });
    } finally { clearTimeout(timer); }
  }

  /** 参考素材过审：http(s) 链接 → asset://；已是 asset:// 原样。未注入 materials 时直接传链接（冒烟/测试）。 */
  async function resolveMaterials(prepared) {
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

  return {
    id: `aiide-${model}`,
    kind: 'video',

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
          generate_audio: generateAudio,
          ratio,
          duration,
          resolution,
          watermark,
        },
      };
    },

    /** 素材过审 → 提交。明确拒绝返回 failed；未提交且可重试抛出；结果不确定按 unknown。 */
    async submit(prepared, { idempotencyKey } = {}) {
      void idempotencyKey; // 渠道无幂等键头：重提防护靠 gen_tasks 状态守卫（产品层）
      let body;
      try {
        body = await resolveMaterials(prepared);
      } catch (error) {
        // 素材库错误按鸭子类型分类（retryable → 未提交可重试；其余有 code 的明确失败 → 返回 failed 不冻结）
        if (!(error instanceof Error)) throw error;
        if (error.retryable === true) throw error;
        if (!error.code) throw error; // 无分类信息的异常照抛（编程错误）
        // 文案按原因区分（日志字段不用 code 命名，logger 会把它当密钥脱敏）
        let message = '参考素材未通过渠道审核，请更换形象或照片后重试。';
        if (['PROVIDER_CONFIG_INVALID', 'PROVIDER_INPUT_INVALID'].includes(error.code)) {
          logger?.error?.('aiide_video_material_invalid', { errorCode: error.code, message: error.message, detail: error.providerMessage });
          message = '参考素材格式不符合渠道要求，请联系客服。';
        } else if (error.code === 'PROVIDER_REJECTED') {
          logger?.warn?.('aiide_video_material_rejected', { errorCode: error.code, detail: error.providerMessage });
          message = '参考素材暂时无法被渠道读取，请稍后重试。';
        } else {
          logger?.warn?.('aiide_video_material_rejected', { errorCode: error.code, detail: error.providerMessage });
        }
        return { status: 'failed', error: message,
          providerMessage: error.providerMessage ?? error.message, providerCode: error.code };
      }

      const { status, ok, data, rawText } = await request('/v1/video/generations', { method: 'POST', body });
      if (status === 429) {
        throw new ProviderError('aiide 渠道请求过于频繁，请稍后重试。', {
          code: 'PROVIDER_RATE_LIMITED', submitted: false, retryable: true, status,
        });
      }
      if (status >= 300 && status < 400) {
        throw new ProviderError('aiide 渠道重定向结果不确定。', { code: 'SUBMISSION_UNKNOWN', submitted: true, status });
      }
      if (status >= 400 && status < 500 && status !== 408) {
        if ([401, 403].includes(status)) logger?.error?.('aiide_video_auth_rejected', { status });
        return { status: 'failed', error: '视频生成请求被渠道拒绝，请稍后重试。', httpStatus: status,
          providerMessage: short(data?.error?.message ?? data?.message ?? rawText),
          providerCode: short(String(data?.error?.code ?? data?.code ?? '')) };
      }
      if (!ok) throw new ProviderError('aiide 渠道受理结果不确定。', { code: 'SUBMISSION_UNKNOWN', submitted: true, status });
      if (data?.error) {
        return { status: 'failed', error: '视频生成请求被渠道拒绝，请稍后重试。',
          providerMessage: short(data.error.message ?? data.error), providerCode: short(String(data.error.code ?? '')) };
      }
      const taskId = data?.task_id ?? data?.id ?? data?.data?.task_id ?? data?.data?.id;
      if (!taskId || typeof taskId !== 'string') {
        throw new ProviderError('aiide 渠道未返回任务编号。', { code: 'SUBMISSION_UNKNOWN', submitted: true });
      }
      return { status: 'running', upstreamId: taskId, raw: data };
    },

    /** 轮询：排队/处理中 → running；成功且有地址 → succeeded（含 usage）；失败/过期 → failed；
     * 成功无地址 → unknown；单次查询网络/5xx 失败 → retryable 抛出（任务已在渠道侧，绝不因查询失败冻结）。 */
    async query(upstreamId) {
      let result;
      try {
        result = await request(`/v1/video/generations/${encodeURIComponent(upstreamId)}`);
      } catch (error) {
        throw new ProviderError('aiide 视频任务查询失败。', {
          code: 'PROVIDER_QUERY_FAILED', submitted: true, retryable: true, providerMessage: error?.providerMessage ?? error?.message,
        });
      }
      const { ok, status, data, rawText } = result;
      if ([404, 410].includes(status)) {
        return { status: 'failed', error: '视频任务不存在或已过期。', providerMessage: short(data ?? rawText) };
      }
      if (!ok || !data || typeof data !== 'object') {
        throw new ProviderError('aiide 视频任务查询失败。', {
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
      logger?.warn?.('aiide_video_status_unrecognized', { upstreamId, outer, innerState });
      return { status: 'running' };
    },

    normalize(raw) { return raw; },
  };
}
