// Source: chaodayun@2926b42 modelhub-models.js, dimensio-image-generation.js, backend/image-routes.js
// Modelhub-specific synchronous image generation and composition adapter.
import { ProviderError, submitSafely } from './transport.js';

const MODELS = Object.freeze({
  'gpt-image-2': { ratios: ['1:1', '16:9', '9:16', '4:3', '3:4'],
    resolutions: ['1080p', '1440p', '2160p'], detailLevels: ['low', 'medium', 'high'],
    defaultRatio: '1:1', defaultResolution: '1080p', defaultDetailLevel: 'medium', maxImages: 1 },
  'nano-banana-2': { ratios: ['auto', '1:1', '16:9', '9:16', '4:3', '3:4', '5:4', '4:5', '3:2', '2:3', '21:9'],
    resolutions: ['512p', '1080p', '1440p', '2160p'], detailLevels: ['default'],
    defaultRatio: 'auto', defaultResolution: '512p', defaultDetailLevel: 'default', maxImages: 1 },
});

function imageUrl(raw) {
  const value = raw?.data?.find?.((item) => typeof item?.url === 'string' && item.url.trim())?.url;
  if (!value) return null;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export function createModelhubImageAdapter({ transport, model = 'gpt-image-2', loadReference, logger }) {
  const capability = MODELS[model];
  if (!capability) throw new ProviderError('图片模型不受支持。', { code: 'PROVIDER_CONFIG_INVALID', submitted: false });
  return {
    id: `modelhub-${model}`,
    kind: 'image',
    prepare(input, sku = {}) {
      const prompt = [input.promptHint, input.description].filter(Boolean).join('\n').trim();
      const refs = input.referenceKeys ?? [];
      if (!prompt || !Array.isArray(refs) || refs.some((key) => typeof key !== 'string' || !key)) {
        throw new ProviderError('形象提示词或参考图片不正确。', { code: 'PROVIDER_INPUT_INVALID', submitted: false });
      }
      const ratio = input.ratio ?? capability.defaultRatio;
      const quality = sku.resolution ?? capability.defaultResolution;
      const detail = input.detailLevel ?? capability.defaultDetailLevel;
      if (!capability.ratios.includes(ratio) || !capability.resolutions.includes(quality)
        || !capability.detailLevels.includes(detail)) {
        throw new ProviderError('图片分辨率、比例或细节档不受模型支持。', {
          code: 'PROVIDER_INPUT_INVALID', submitted: false,
        });
      }
      const droppedReferences = Math.max(0, refs.length - capability.maxImages);
      if (droppedReferences) logger?.warn?.('image_references_dropped', { model, droppedReferences });
      return { model, prompt, ratio, quality,
        ...(capability.detailLevels.length > 1 ? { detail_level: detail } : {}),
        referenceKeys: refs.slice(0, capability.maxImages), droppedReferences };
    },
    async submit(prepared, { idempotencyKey } = {}) {
      const { referenceKeys, droppedReferences, ...fields } = prepared;
      let path = '/v1/images/generations';
      let body = fields;
      if (referenceKeys.length) {
        if (!loadReference) throw new ProviderError('图片参考读取器未配置。', { code: 'PROVIDER_CONFIG_INVALID', submitted: false });
        path = '/v1/images/compositions';
        body = new FormData();
        for (const [key, value] of Object.entries(fields)) body.append(key, String(value));
        for (const key of referenceKeys) {
          const media = await loadReference(key);
          if (!Buffer.isBuffer(media?.buffer)) throw new ProviderError('参考图片不可用。', {
            code: 'PROVIDER_INPUT_INVALID', submitted: false,
          });
          body.append('images', new Blob([media.buffer], { type: media.contentType ?? 'image/png' }), media.name ?? 'reference.png');
        }
      }
      const raw = await submitSafely(transport, path, { method: 'POST', body, idempotencyKey });
      if (raw.status === 'unknown') return { status: 'unknown', droppedReferences };
      return { ...this.normalize(raw), droppedReferences };
    },
    async query() {
      throw new ProviderError('Modelhub 图片接口同步返回结果，无远端查询接口。', {
        code: 'PROVIDER_QUERY_UNSUPPORTED', submitted: false,
      });
    },
    normalize(raw) {
      const url = imageUrl(raw);
      if (url) return { status: 'succeeded', outputs: [{ url, kind: 'image' }] };
      if (raw?.error) return { status: 'failed', error: '图片生成失败，请修改内容后重试。',
        providerMessage: String(raw.error?.message ?? raw.error).slice(0, 200) };
      return { status: 'unknown' };
    },
  };
}
