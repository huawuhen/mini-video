// 真实后端实现：/api/v1 + Cookie 会话 + X-CSRF-Token（docs/API.md §0）。
import type { ApiError, LoginResult, MivApi, Session } from './types';

const BASE = '/api/v1';
let csrfToken = '';

export class MivApiError extends Error implements ApiError {
  code: string;
  requestId?: string;
  details?: unknown;
  status: number;
  constructor(status: number, body: Partial<ApiError>) {
    super(body.message || '网络开小差了，请稍后再试');
    this.status = status;
    this.code = body.code || 'NETWORK_ERROR';
    this.requestId = body.requestId;
    this.details = body.details;
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

function remember<T extends Session>(session: T): T { csrfToken = session.csrfToken; return session; }
function qs(params: Record<string, string | undefined>) {
  const search = new URLSearchParams(Object.entries(params).filter((e): e is [string, string] => !!e[1]));
  const text = search.toString();
  return text ? `?${text}` : '';
}
function upload(path: string, file: File) { const form = new FormData(); form.append('file', file); return request<never>('POST', path, form); }
const p = (id: string) => `/projects/${encodeURIComponent(id)}`;
const c = (id: string) => `/characters/${encodeURIComponent(id)}`;

export const httpApi: MivApi = {
  me: async () => remember(await request('GET', '/auth/me')),
  sendSms: (phone) => request('POST', '/auth/sms', { phone }),
  login: async (phone, code) => remember(await request<LoginResult>('POST', '/auth/login', { phone, code, agreeTerms: true })),
  logout: async () => { await request('POST', '/auth/logout'); csrfToken = ''; },
  updateOnboarding: (patch) => request('PATCH', '/me/onboarding', patch),

  catalog: () => request('GET', '/catalog'),
  voices: (category) => request('GET', `/voices${qs({ category })}`),

  wallet: () => request('GET', '/wallet'),
  ledger: (cursor) => request('GET', `/wallet/ledger${qs({ cursor })}`),
  redeem: (code) => request('POST', '/wallet/redeem', { code, idempotencyKey: crypto.randomUUID() }),
  estimate: (body) => request('POST', '/quotes/estimate', body),
  quote: (body) => request('POST', '/quotes', body),

  uploadStory: (file) => upload('/uploads/story', file),
  uploadImage: (file) => upload('/uploads/image', file),

  listCharacters: () => request('GET', '/characters'),
  createCharacter: (body) => request('POST', '/characters', body),
  getCharacter: (id) => request('GET', c(id)),
  updateCharacter: (id, body) => request('PATCH', c(id), body),
  replaceCharacterPhotos: (id, uploadIds) => request('PUT', `${c(id)}/photos`, { uploadIds }),
  generateLook: (id, styleId, quoteId, idempotencyKey) => request('POST', `${c(id)}/looks/${styleId}/versions`, { quoteId, idempotencyKey }),
  selectLook: (id, styleId, versionId) => request('PUT', `${c(id)}/looks/${styleId}/selection`, { versionId }),
  deleteCharacter: (id) => request('DELETE', c(id)),

  listProjects: (group, cursor) => request('GET', `/projects${qs({ group, cursor })}`),
  createProject: (body) => request('POST', '/projects', body),
  getProject: (id) => request('GET', p(id)),
  deleteProject: (id) => request('DELETE', p(id)),
  reanalyzeStory: (id, storyText) => request('POST', `${p(id)}/story/reanalyze`, { storyText }),
  setCastCharacter: (id, castId, characterId) => request('PUT', `${p(id)}/cast/${castId}/character`, { characterId }),
  confirmStory: (id, quoteId, idempotencyKey) => request('POST', `${p(id)}/confirm-story`, { quoteId, idempotencyKey }),
  updateCast: (id, castId, patch) => request('PUT', `${p(id)}/cast/${castId}`, patch),
  regenerateCastLook: (id, castId, quoteId, idempotencyKey) => request('POST', `${p(id)}/cast/${castId}/looks`, { quoteId, idempotencyKey }),
  confirmCast: (id, quoteId, idempotencyKey) => request('POST', `${p(id)}/confirm-cast`, { quoteId, idempotencyKey }),
  pause: (id) => request('POST', `${p(id)}/pause`),
  resume: (id) => request('POST', `${p(id)}/resume`),
  retry: (id) => request('POST', `${p(id)}/retry`),
  cancel: (id) => request('POST', `${p(id)}/cancel`),
  updateSegment: (id, segmentId, plot) => request('PATCH', `${p(id)}/segments/${segmentId}`, { plot }),
  regenerateSegment: (id, segmentId, quoteId, idempotencyKey) => request('POST', `${p(id)}/segments/${segmentId}/takes`, { quoteId, idempotencyKey }),
  selectTake: (id, segmentId, takeId) => request('PUT', `${p(id)}/segments/${segmentId}/selection`, { takeId }),
  downloadUrl: (id) => `${BASE}${p(id)}/download`,
};
