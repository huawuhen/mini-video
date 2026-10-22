// Source: chaodayun@2926b42 modelhub-models.js, dimensio-image-generation.js, backend/image-routes.js
// Modelhub-specific synchronous image generation and composition adapter.
import { ProviderError, submitSafely } from './transport.js';

const MODELS = Object.freeze({
  // 2026-10-21 实测目录与官网参数页：gpt-image-2 与 flare 同形态——分辨率走独立 resolution
  // 字段（1k/2k/4k，兼容 1080p/1440p/2160p 写法），quality/detail_level 为档位（本模型上限 high）。
  // ratio 目录默认 auto，产品形象照固定 1:1；image_count（1-4）产品固定 1 张，不发送。
  'gpt-image-2': { ratios: ['auto', '1:1', '16:9', '9:16', '4:3', '3:4'],
    resolutions: ['1k', '2k', '4k'], detailLevels: ['low', 'medium', 'high'],
    defaultRatio: '1:1', defaultResolution: '1k', defaultDetailLevel: 'medium', maxImages: 1,
    resolutionField: true },
  'nano-banana-2': { ratios: ['auto', '1:1', '16:9', '9:16', '4:3', '3:4', '5:4', '4:5', '3:2', '2:3', '21:9'],
    resolutions: ['512p', '1080p', '1440p', '2160p'], detailLevels: ['default'],
    defaultRatio: 'auto', defaultResolution: '512p', defaultDetailLevel: 'default', maxImages: 1 },
  // 2026-10-21 实测目录（GET /v1/models?include_capabilities=1）：flare 系分辨率走独立的 resolution
  // 字段（1k/2k/4k，兼容 1080p/1440p/2160p 写法），quality 与 detail_level 是 low→max 的档位。
  'gpt-image-2.5-flare': { ratios: ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '2:1', '1:2', '21:9', 'auto', '27:16', '16:27', '9:8', '8:9'],
    resolutions: ['1k', '2k', '4k'], detailLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultRatio: '1:1', defaultResolution: '1k', defaultDetailLevel: 'medium', maxImages: 1,
    resolutionField: true },
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
      const resolution = sku.resolution ?? capability.defaultResolution;
      const detail = input.detailLevel ?? capability.defaultDetailLevel;
      if (!capability.ratios.includes(ratio) || !capability.resolutions.includes(resolution)
        || !capability.detailLevels.includes(detail)) {
        throw new ProviderError('图片分辨率、比例或细节档不受模型支持。', {
          code: 'PROVIDER_INPUT_INVALID', submitted: false,
        });
      }
      const droppedReferences = Math.max(0, refs.length - capability.maxImages);
      if (droppedReferences) logger?.warn?.('image_references_dropped', { model, droppedReferences });
      // 旧路由形态（gpt-image-2 / nano-banana-2）把分辨率档放在 quality 字段；flare 形态分辨率与档位分开。
      const fields = capability.resolutionField
        ? { model, prompt, ratio, resolution, quality: detail, detail_level: detail }
        : { model, prompt, ratio, quality: resolution,
          ...(capability.detailLevels.length > 1 ? { detail_level: detail } : {}) };
      return { ...fields, referenceKeys: refs.slice(0, capability.maxImages), droppedReferences };
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
          let media;
          try { media = await loadReference(key); }
          catch (error) {
            throw new ProviderError('参考图片暂时无法读取，请稍后重试。', {
              code: 'PROVIDER_REFERENCE_UNAVAILABLE', submitted: false, retryable: true,
            });
          }
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

export const createFlare25ImageAdapter = (transport) => createModelhubImageAdapter({
  model: 'gpt-image-2.5-flare', transport,
});
