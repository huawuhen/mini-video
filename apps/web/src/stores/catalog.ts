import { defineStore } from 'pinia';
import { api, type Catalog, type Voice } from '@/api';

/** 目录与音色只需加载一次（后端有 60 秒缓存）。 */
export const useCatalogStore = defineStore('catalog', {
  state: () => ({ catalog: null as Catalog | null, voices: [] as Voice[] }),
  getters: {
    styleName: (s) => (id: string) => s.catalog?.styles.find((x) => x.id === id)?.name ?? '',
    tierName: (s) => (id: string) => s.catalog?.qualityTiers.find((x) => x.id === id)?.name ?? '',
    voiceById: (s) => (id?: string) => s.voices.find((v) => v.id === id),
  },
  actions: {
    async load() {
      if (!this.catalog) {
        const [catalog, voices] = await Promise.all([api.catalog(), api.voices()]);
        this.catalog = catalog;
        this.voices = voices.items;
      }
      return this.catalog;
    },
  },
});
