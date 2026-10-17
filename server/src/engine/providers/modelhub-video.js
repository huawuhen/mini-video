// Source: chaodayun@2926b42 modelhub-models.js, backend/providers.js:154-157, backend/task-routes.js
// Modelhub-specific paths, fields, model capabilities, and response normalization.
import { ProviderError, submitSafely } from './transport.js';

const MODELS = Object.freeze({
  'wan-3.0': { minSeconds: 2, maxSeconds: 30, maxImages: 9, maxAudios: 3,
    ratios: ['16:9', '9:16', '1:1', '4:3', '3:4'] },
  'seedance-2.5': { minSeconds: 4, maxSeconds: 30, maxImages: 30, maxAudios: 10,
    ratios: ['auto', '16:9', '9:16', '1:1', '4:3', '3:4'] },
});

function requiredString(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new ProviderError(`${name} 不能为空。`, {
    code: 'PROVIDER_INPUT_INVALID', submitted: false,
  });
  return value.trim();
}

function mediaList(value, max, name) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max || value.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new ProviderError(`${name} 不符合模型能力限制。`, { code: 'PROVIDER_INPUT_INVALID', submitted: false });
  }
  return value.map((item) => item.trim());
}

function validUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export function videoUrl(raw) {
  const candidates = [raw?.url, raw?.video, raw?.video_url, raw?.result_url, raw?.result?.url,
    raw?.output?.video, raw?.data?.output?.video, raw?.output?.outputs?.[0], raw?.data?.output?.outputs?.[0],
    raw?.output?.urls?.get, raw?.data?.output?.urls?.get, raw?.outputs?.[0], raw?.content?.video_url,
    raw?.data?.video_url, raw?.data?.result_url, raw?.data?.result?.url, raw?.data?.content?.video_url,
    raw?.data?.data?.content?.video_url, raw?.data?.data?.result_url,
    ...(Array.isArray(raw?.result_urls) ? raw.result_urls : []),
    ...(Array.isArray(raw?.data?.results) ? raw.data.results.filter((item) => item?.type === 'video').map((item) => item.url) : [])];
  return candidates.map(validUrl).find(Boolean) ?? null;
}

export function normalizeVideo(raw) {
  const status = String(raw?.status ?? raw?.data?.status ?? raw?.state ?? raw?.data?.state ?? '').toLowerCase();
  if (['failed', 'error', 'rejected', 'expired', 'cancelled', 'canceled', 'blocked', 'timeout'].includes(status)) {
    const providerMessage = String(raw?.error?.message ?? raw?.data?.error?.message
      ?? raw?.error ?? raw?.failMessage ?? raw?.message ?? '').slice(0, 200);
    return { status: 'failed', error: '视频生成失败，请稍后重试。',
      ...(providerMessage ? { providerMessage } : {}) };
  }
  const url = videoUrl(raw);
  if (url) return { status: 'succeeded', outputs: [{ url, kind: 'video' }] };
  if (['succeeded', 'completed', 'success'].includes(status)) return { status: 'unknown' };
  return { status: 'running' };
}

export function createModelhubVideoAdapter({ model, transport }) {
  const capabilities = MODELS[model];
  if (!capabilities) throw new ProviderError('未登记的视频模型。', { code: 'PROVIDER_CONFIG_INVALID', submitted: false });
  return {
    id: `modelhub-${model}`,
    kind: 'video',
    prepare(input, sku = {}) {
      const images = mediaList(input.imageRefs, capabilities.maxImages, '图片参考');
      const audios = mediaList(input.audioRefs, capabilities.maxAudios, '音频参考');
      const prompt = requiredString(input.prompt, '提示词');
      const duration = input.durationSeconds ?? input.duration;
      if (!Number.isInteger(duration) || duration < capabilities.minSeconds || duration > capabilities.maxSeconds
        || (sku.durations?.length && !sku.durations.includes(duration))) {
        throw new ProviderError('片段时长不符合模型能力或 SKU。', { code: 'PROVIDER_INPUT_INVALID', submitted: false });
      }
      const ratio = input.ratio ?? '9:16';
      const resolution = input.resolution ?? sku.resolution ?? '720p';
      if (!capabilities.ratios.includes(ratio) || !['480p', '720p', '1080p'].includes(resolution)) {
        throw new ProviderError('画幅或分辨率不受支持。', { code: 'PROVIDER_INPUT_INVALID', submitted: false });
      }
      // tailRef is the previous segment's tail image, placed first as an ordinary
      // omni_reference image. Best-effort visual continuity; no first-frame guarantee.
      const references = input.tailRef
        ? [requiredString(input.tailRef, '上一段尾帧'), ...images.filter((ref) => ref !== input.tailRef)] : images;
      if (references.length > capabilities.maxImages) {
        throw new ProviderError('图片参考超过模型限制。', { code: 'PROVIDER_INPUT_INVALID', submitted: false });
      }
      const payload = { model, prompt, resolution, ratio, duration, functionMode: 'omni_reference' };
      references.forEach((ref, index) => { payload[`image_file_${index + 1}`] = ref; });
      audios.forEach((ref, index) => { payload[`audio_file_${index + 1}`] = ref; });
      return payload;
    },
    async submit(prepared, { idempotencyKey } = {}) {
      const raw = await submitSafely(transport, '/v1/videos/generations', { method: 'POST', body: prepared, idempotencyKey });
      if (raw.status === 'unknown') return { status: 'unknown' };
      const upstreamId = raw.task_id ?? raw.taskId ?? raw.data?.task_id ?? raw.id;
      return upstreamId ? { status: 'running', upstreamId: String(upstreamId) } : { status: 'unknown' };
    },
    async query(upstreamId) {
      const raw = await transport.request(`/v1/videos/tasks/${encodeURIComponent(upstreamId)}`);
      return this.normalize(raw);
    },
    normalize: normalizeVideo,
  };
}

export const createWan30Adapter = (transport) => createModelhubVideoAdapter({ model: 'wan-3.0', transport });
export const createSeedance25Adapter = (transport) => createModelhubVideoAdapter({ model: 'seedance-2.5', transport });
