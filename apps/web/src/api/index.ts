import type { MivApi } from './types';
import { httpApi } from './http';
import { mockApi } from './mock';

/** 默认使用 mock；联调时设置 VITE_USE_MOCK=false。 */
export const useMock = import.meta.env.VITE_USE_MOCK !== 'false';
export const api: MivApi = useMock ? mockApi : httpApi;
export * from './types';
export { MivApiError } from './http';
// 管理端（API.md §8）：独立会话与接口，mock 模式给美工演示（M3-ADM-01）
import { adminHttp } from './admin';
import { adminMock } from './adminMock';
export const adminApi = useMock ? adminMock : adminHttp;
