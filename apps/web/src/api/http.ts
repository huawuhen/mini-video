// 真实后端实现：/api/v1 + Cookie 会话 + X-CSRF-Token（docs/API.md 通用约定）。
import type { ApiError, MivApi, Session } from './types';

const BASE = '/api/v1';
let csrfToken = '';

export class MivApiError extends Error implements ApiError {
  code: string;
  requestId?: string;
  status: number;
  constructor(status: number, body: Partial<ApiError>) {
    super(body.message || '网络开小差了，请稍后再试');
    this.status = status;
    this.code = body.code || 'NETWORK_ERROR';
    this.requestId = body.requestId;
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  if (method !== 'GET' && csrfToken) headers['X-CSRF-Token'] = csrfToken;
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, { method, headers, body: payload, credentials: 'same-origin' });
  } catch {
    throw new MivApiError(0, { code: 'NETWORK_ERROR', message: '网络连接失败，请检查网络后重试' });
  }
  const data = response.status === 204 ? undefined : await response.json().catch(() => undefined);
  if (!response.ok) throw new MivApiError(response.status, data || {});
  return data as T;
}

function remember(session: Session): Session { csrfToken = session.csrfToken; return session; }
const q = (cursor?: string) => (cursor ? `?cursor=${encodeURIComponent(cursor)}` : '');

export const httpApi: MivApi = {
  me: async () => remember(await request('GET', '/auth/me')),
  sendSms: (phone) => request('POST', '/auth/sms', { phone }),
  login: async (phone, code) => remember(await request('POST', '/auth/login', { phone, code, agreeTerms: true })),
  logout: async () => { await request('POST', '/auth/logout'); csrfToken = ''; },
  catalog: () => request('GET', '/catalog'),
  wallet: () => request('GET', '/wallet'),
  ledger: (cursor) => request('GET', `/wallet/ledger${q(cursor)}`),
  redeem: (code) => request('POST', '/wallet/redeem', { code, idempotencyKey: crypto.randomUUID() }),
  quote: (body) => request('POST', '/quotes', body),
  uploadScript: (file) => { const form = new FormData(); form.append('file', file); return request('POST', '/uploads/script', form); },
  listProjects: (cursor) => request('GET', `/projects${q(cursor)}`),
  createProject: (body) => request('POST', '/projects', body),
  getProject: (id) => request('GET', `/projects/${id}`),
  confirm: (id, stage) => request('POST', `/projects/${id}/confirm`, { stage }),
  pause: (id) => request('POST', `/projects/${id}/pause`),
  resume: (id) => request('POST', `/projects/${id}/resume`),
  retry: (id) => request('POST', `/projects/${id}/retry`),
  cancel: (id) => request('POST', `/projects/${id}/cancel`),
  updatePlan: (id, patch) => request('PATCH', `/projects/${id}/plan`, patch),
  regeneratePlan: (id, instruction) => request('POST', `/projects/${id}/plan/regenerate`, { instruction }),
  generateAssetVersion: (id, assetId, quoteId, idempotencyKey) =>
    request('POST', `/projects/${id}/assets/${assetId}/versions`, { source: 'generated', quoteId, idempotencyKey }),
  selectAssetVersion: (id, assetId, versionId) => request('PUT', `/projects/${id}/assets/${assetId}/selection`, { versionId }),
  updateShot: (id, shotId, patch) => request('PATCH', `/projects/${id}/shots/${shotId}`, patch),
  generateShotTake: (id, shotId, quoteId, idempotencyKey) =>
    request('POST', `/projects/${id}/shots/${shotId}/takes`, { source: 'generated', quoteId, idempotencyKey }),
  selectShotTake: (id, shotId, takeId) => request('PUT', `/projects/${id}/shots/${shotId}/selection`, { takeId }),
  createRender: (id, options, idempotencyKey) => request('POST', `/projects/${id}/renders`, { ...options, idempotencyKey }),
};
