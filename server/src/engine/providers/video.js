// Source: chaodayun@2926b42 modelhub-models.js, backend/providers.js
// Wan 3.0 and Seedance 2.5 model adapters for the Modelhub video task API.
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

export function normalizeVideo(raw) {
  const data = raw?.data && typeof raw.data === 'object' ? raw.data : raw;
  const status = String(data?.status ?? data?.state ?? '').toLowerCase();
  if (['failed', 'error', 'cancelled', 'canceled'].includes(status)) {
    return { status: 'failed', error: String(data?.error?.message ?? data?.error ?? data?.failMessage ?? data?.message ?? '生成失败') };
  }
  const url = data?.video_url ?? data?.result?.url ?? data?.output?.video ?? data?.result_urls?.[0];
  if (['succeeded', 'completed', 'success'].includes(status) && typeof url === 'string' && /^https?:\/\//.test(url)) {
    return { status: 'succeeded', outputs: [{ url, kind: 'video' }] };
  }
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
      const firstFrame = input.firstFrame;
      if (firstFrame !== undefined) requiredString(firstFrame, '首帧');
      const functionMode = input.functionMode ?? 'omni_reference';
      if (!['omni_reference', 'first_last_frames'].includes(functionMode)
        || (functionMode === 'first_last_frames' && audios.length)) {
        throw new ProviderError('首尾帧模式不允许引用音频。', { code: 'PROVIDER_INPUT_INVALID', submitted: false });
      }
      const references = firstFrame ? [firstFrame, ...images.filter((ref) => ref !== firstFrame)] : images;
      if (references.length > capabilities.maxImages || (functionMode === 'first_last_frames' && references.length > 2)) {
        throw new ProviderError('图片参考超过模型限制。', { code: 'PROVIDER_INPUT_INVALID', submitted: false });
      }
      const payload = { model, prompt, resolution, ratio, duration, functionMode };
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
