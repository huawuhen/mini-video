// Provider-independent image facade for BE-04's generate() contract.
import { ProviderError } from './transport.js';

export function createImageProvider(registry, { adapterId = 'modelhub-gpt-image-2', sku = {}, downloadImage,
  logger, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  const adapter = registry.get(adapterId);
  if (adapter.kind !== 'image' || typeof downloadImage !== 'function') {
    throw new ProviderError('图片适配器或安全下载器未配置。', { code: 'PROVIDER_CONFIG_INVALID', submitted: false });
  }
  return {
    id: adapter.id,
    async generate({ characterId, styleId, promptHint, description, referenceKeys }) {
      let prepared;
      try { prepared = adapter.prepare({ characterId, styleId, promptHint, description, referenceKeys }, sku); }
      catch (error) {
        if (error.submitted === false && !error.retryable) {
          if (['PROVIDER_CONFIG_INVALID', 'PROVIDER_INPUT_INVALID'].includes(error.code)) {
            logger?.error?.('image_provider_local_invalid', { code: error.code, message: error.message });
          }
          return { status: 'failed', error: '图片生成参数不符合要求。' };
        }
        throw error;
      }
      let submitted;
      try { submitted = await adapter.submit(prepared); }
      catch (error) {
        if (error.retryable === true) throw error;
        if (error.submitted === false) {
          if (['PROVIDER_CONFIG_INVALID', 'PROVIDER_INPUT_INVALID'].includes(error.code)) {
            logger?.error?.('image_provider_local_invalid', { code: error.code, message: error.message });
          }
          if ([401, 403].includes(error.status)) logger?.error?.('image_provider_auth_rejected', {
            status: error.status, providerCode: error.providerCode, providerMessage: error.providerMessage,
          });
          return { status: 'failed', error: '图片生成请求被渠道拒绝，请稍后重试。',
            ...(error.providerMessage ? { providerMessage: error.providerMessage } : {}) };
        }
        return { status: 'unknown' };
      }
      if (submitted.status === 'unknown') return { status: 'unknown' };
      if (submitted.status === 'failed') return { status: 'failed', error: submitted.error,
        ...(submitted.providerMessage ? { providerMessage: submitted.providerMessage } : {}) };
      const url = submitted.outputs?.[0]?.url;
      if (!url) return { status: 'unknown' };
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const result = await downloadImage(url);
          if (Buffer.isBuffer(result?.buffer)) {
            return { status: 'succeeded', buffer: result.buffer, contentType: result.contentType ?? 'image/png',
              ...(submitted.droppedReferences ? { droppedReferences: submitted.droppedReferences } : {}) };
          }
        } catch (error) {
          logger?.warn?.('image_result_download_failed', { attempt: attempt + 1, message: error?.message });
        }
        if (attempt < 2) await sleep(200 * 2 ** attempt); // total delay 600ms, below 10 seconds
      }
      return { status: 'unknown' }; // URL known, download retries never resubmit the paid generation
    },
  };
}
