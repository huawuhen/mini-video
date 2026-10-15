import type { MivApi } from './types';
import { httpApi } from './http';
import { mockApi } from './mock';

/** 默认使用 mock；联调时设置 VITE_USE_MOCK=false。 */
export const useMock = import.meta.env.VITE_USE_MOCK !== 'false';
export const api: MivApi = useMock ? mockApi : httpApi;
export * from './types';
export { MivApiError } from './http';
