// Adapter registry for video/image providers (docs/ARCHITECTURE.md §5).
import { ProviderError } from './transport.js';

export function createRegistry(adapters) {
  const byId = new Map();
  for (const adapter of adapters) {
    if (!adapter?.id || !['video', 'image'].includes(adapter.kind)
      || ['prepare', 'submit', 'query', 'normalize'].some((name) => typeof adapter[name] !== 'function')
      || byId.has(adapter.id)) {
      throw new ProviderError('渠道适配器登记无效或重复。', { code: 'PROVIDER_CONFIG_INVALID', submitted: false });
    }
    byId.set(adapter.id, adapter);
  }
  return Object.freeze({
    get(id) {
      const adapter = byId.get(id);
      if (!adapter) throw new ProviderError('渠道适配器不存在。', { code: 'PROVIDER_NOT_FOUND', submitted: false });
      return adapter;
    },
    list(kind) { return [...byId.values()].filter((adapter) => !kind || adapter.kind === kind); },
  });
}

export { createModelhubTransport, ProviderError } from './transport.js';
export { createModelhubVideoAdapter, createWan30Adapter, createSeedance25Adapter } from './modelhub-video.js';
export { createModelhubImageAdapter } from './modelhub-image.js';
export { createImageProvider } from './image.js';
