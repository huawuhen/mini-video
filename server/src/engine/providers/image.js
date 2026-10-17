// Source: chaodayun@2926b42 dimensio-image-generation.js, backend/image-routes.js
// Modelhub synchronous image generation/composition; reference assets are passed as multipart files.
import { ProviderError, submitSafely } from './transport.js';

const imageUrl = (raw) => raw?.data?.find?.((item) => typeof item?.url === 'string' && /^https?:\/\//.test(item.url))?.url;

export function createModelhubImageAdapter({ transport, model = 'gpt-image-2', loadReference }) {
  return {
    id: `modelhub-${model}`,
    kind: 'image',
    prepare(input, sku = {}) {
      const prompt = [input.promptHint, input.description].filter(Boolean).join('\n').trim();
      if (!prompt || !Array.isArray(input.referenceKeys ?? [])
        || (input.referenceKeys ?? []).some((key) => typeof key !== 'string' || !key)) {
        throw new ProviderError('形象提示词或参考图片不正确。', { code: 'PROVIDER_INPUT_INVALID', submitted: false });
      }
      return { model, prompt, ratio: input.ratio ?? '9:16', quality: sku.resolution ?? '2k',
        referenceKeys: input.referenceKeys ?? [] };
    },
    async submit(prepared, { idempotencyKey } = {}) {
      const { referenceKeys, ...fields } = prepared;
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
      if (raw.status === 'unknown') return { status: 'unknown' };
      const normalized = this.normalize(raw);
      return normalized;
    },
    async query() {
      throw new ProviderError('Modelhub 图片接口同步返回结果，无远端查询接口。', {
        code: 'PROVIDER_QUERY_UNSUPPORTED', submitted: false,
      });
    },
    normalize(raw) {
      const url = imageUrl(raw);
      if (url) return { status: 'succeeded', outputs: [{ url, kind: 'image' }] };
      if (raw?.error) return { status: 'failed', error: String(raw.error?.message ?? raw.error) };
      return { status: 'unknown' };
    },
  };
}

export function createImageProvider(registry, { adapterId = 'modelhub-gpt-image-2', sku = {}, downloadImage }) {
  const adapter = registry.get(adapterId);
  if (adapter.kind !== 'image' || typeof downloadImage !== 'function') {
    throw new ProviderError('图片适配器或安全下载器未配置。', { code: 'PROVIDER_CONFIG_INVALID', submitted: false });
  }
  return {
    id: adapter.id,
    async generate({ characterId, styleId, promptHint, description, referenceKeys }) {
      const prepared = adapter.prepare({ characterId, styleId, promptHint, description, referenceKeys }, sku);
      // BE-04's generate signature has no per-version key. Never reuse characterId:styleId
      // as an upstream idempotency key: regenerating the same look must create a new take.
      const submitted = await adapter.submit(prepared);
      if (submitted.status === 'unknown') return { status: 'unknown' };
      if (submitted.status === 'failed') return { status: 'failed', error: submitted.error };
      const url = submitted.outputs?.[0]?.url;
      if (!url) return { status: 'unknown' };
      try {
        const result = await downloadImage(url);
        if (!Buffer.isBuffer(result?.buffer)) return { status: 'unknown' };
        return { status: 'succeeded', buffer: result.buffer, contentType: result.contentType ?? 'image/png' };
      } catch {
        return { status: 'unknown' }; // 上游已生成但结果转存不确定，不自动重提
      }
    },
  };
}
