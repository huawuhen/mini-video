// 管理端 API 层（docs/API.md §8，独立于用户端 MivApi）：
// 独立管理员会话（miv_admin Cookie + CSRF），前端用户端不调用这些接口。
import { MivApiError } from './http';

export interface AdminSession { id: string; username: string }
export type ChannelKind = 'video' | 'image' | 'llm';
export type ChannelStatus = 'active' | 'disabled' | 'retired';
/** 驱动的 params 配置说明（文档型 schema：键 → 用法描述，如 'int（缺省 800）'）。 */
export type ConfigSchema = { baseUrl?: string; credential?: string; modelMap?: string; params?: Record<string, string> };
export interface DriverInfo { id: string; kinds: ChannelKind[]; configSchema: ConfigSchema }
export interface ChannelRecent { total: number; failed: number; avgQueueSeconds: number | null }
export interface Channel {
  id: string; kind: ChannelKind; name: string; driver: string; baseUrl: string;
  credentialMask: string; modelMap: Record<string, string>; params: Record<string, unknown>;
  costFen?: Record<string, number>; status: ChannelStatus; remark?: string;
  unavailable?: boolean; inFlight: number; recent: ChannelRecent | null;
  costVsPrice?: { capability: string; costFen: number | null; priceFen: number | null }[];
  createdAt?: string; updatedAt?: string;
}
export interface RouteRow { capability: string; rank: number; id: string; name: string; status: ChannelStatus; driver: string }
export interface TestResult { ok: boolean; latencyMs: number; models: { name: string; priceFenPerUnit: number | null }[]; mismatches: { capability: string; model: string; reason: string }[] }
export interface TrialResult { ok: boolean; message: string; capability: string }

// ── 用户与余额 / 订单与人工退款（M3-ADM-02，API.md §8.1~8.2） ──
export type UserStatus = 'active' | 'disabled' | 'deactivated';
export type LedgerKind = 'recharge' | 'redeem' | 'reserve' | 'settle' | 'refund' | 'charge' | 'adjust';
export interface AdminUser {
  id: string; phoneMasked: string; nickname: string; status: UserStatus;
  balanceFen: number; frozenFen: number; createdAt: string; lastLoginAt: string | null;
}
export interface AdminUserDetail extends AdminUser {
  stats: { projects: number; delivered: number; characters: number; rechargedFen: number; spentFen: number };
  consents: { terms: string | null; photo: string | null };
  wechatBound: boolean;
}
export interface AdminLedgerItem {
  id: string; kind: LedgerKind; amountFen: number; frozenDeltaFen: number; title: string;
  refType: string | null; refId: string | null; reason?: string; adminUsername?: string; createdAt: string;
}
export type OrderStatus = 'created' | 'paid' | 'expired' | 'failed';
export type PayScene = 'jsapi' | 'h5' | 'native';
export interface AdminOrder {
  id: string; userId: string; phoneMasked: string; outTradeNo: string; transactionId: string | null;
  amountFen: number; refundedFen: number; scene: PayScene; status: OrderStatus;
  createdAt: string; paidAt: string | null;
}
export interface AdminOrderDetail extends AdminOrder { notifyCount: number; lastNotifyAt: string | null; ledgerId: string | null }
export interface UsersQuery { phone?: string; userId?: string; status?: UserStatus | ''; cursor?: string; limit?: number }
export interface OrdersQuery { status?: OrderStatus | ''; userId?: string; outTradeNo?: string; from?: string; to?: string; cursor?: string; limit?: number }

// ── 作品与失败/待核对处理（M3-ADM-03，API.md §8.3） ──
export type ProjectStatus = 'understanding' | 'story_review' | 'casting' | 'cast_review' | 'rendering'
  | 'composing' | 'delivered' | 'expired' | 'paused' | 'failed' | 'canceled';
export interface AdminProject {
  id: string; userId: string; phoneMasked: string; title: string; status: ProjectStatus;
  progress: { percent: number; message: string };
  unknownTakes: number; createdAt: string; updatedAt: string;
}
export interface AdminTakeInfo {
  id: string; status: 'pending' | 'running' | 'succeeded' | 'failed' | 'unknown';
  genTaskStatus: string | null; channel: string | null; upstreamTaskId: string | null;
  frozenFen: number; error: { code?: string; message?: string } | null;
  resolvedOutcome?: 'not_charged' | 'charged'; resolvedNote?: string; resolvedAt?: string;
  createdAt: string;
}
export interface AdminSegmentInfo {
  id: string; index: number; durationSeconds: number; plot: string;
  selectedTakeId: string | null; takes: AdminTakeInfo[];
}
export interface AdminProjectDetail extends AdminProject {
  money: { reservedFen: number; settledFen: number; refundedFen: number; frozenFen: number };
  segments: AdminSegmentInfo[];
  events: { id: number; status: string; progress: { percent?: number; message?: string }; createdAt: string }[];
}
export interface ProjectsQuery { status?: ProjectStatus | ''; userId?: string; hasUnknown?: boolean; cursor?: string; limit?: number }
export type ResolveOutcome = 'not_charged' | 'charged';

// ── 价格、档位、风格、音色、运营参数（M3-ADM-04，API.md §8.4） ──
export type SkuKind = 'video' | 'image' | 'llm';
export type SkuUnit = 'second' | 'image' | 'ktoken';
export interface AdminSku {
  skuCode: string; kind: SkuKind; model: string; resolution: string | null; unit: SkuUnit;
  priceFen: number; costFen: number; version: number; versions: number;
  effectiveAt: string; marginRate: number | null;
}
export interface AdminTierMapping {
  id: string; videoSkuCode: string; version: number; effectiveAt: string;
  priceFen: number | null;
}
export interface AdminTier {
  id: string; name: string; note: string; sort: number; status: 'active' | 'inactive';
  currentMapping: AdminTierMapping | null;
}
export interface AdminStyle {
  id: string; name: string; description: string; coverUploadId: string | null;
  coverUrl?: string; promptHint: string; sort: number; status: 'active' | 'inactive';
}
export interface AdminVoice {
  id: string; name: string; category: string; gender: string; ageGroup: string; description: string;
  sampleUploadId: string | null; refAudioUploadId: string | null; sampleUrl?: string;
  sort: number; status: 'active' | 'inactive';
}
export interface AdminSettingItem {
  key: string; label: string; type: 'int'; min: number; max: number; value: number | null;
}
export interface StyleDraft {
  name: string; description?: string; coverUploadId?: string | null; promptHint?: string; sort?: number;
}
export interface VoiceDraft {
  name: string; category: string; gender: string; ageGroup: string; description?: string;
  sampleUploadId?: string | null; refAudioUploadId?: string | null; sort?: number;
}
export interface AuditQuery {
  adminId?: string; action?: string; targetType?: string; targetId?: string;
  from?: string; to?: string; cursor?: string; limit?: number;
}
export interface AdminAuditItem {
  id: number; adminUsername: string; action: string; targetType: string; targetId: string;
  detail: Record<string, unknown>; ip: string | null; createdAt: string;
}

export interface AdminApi {
  login(username: string, password: string): Promise<{ admin: AdminSession; csrfToken: string }>;
  logout(): Promise<void>;
  drivers(): Promise<{ items: DriverInfo[] }>;
  channels(kind?: ChannelKind, includeRetired?: boolean): Promise<{ items: Channel[] }>;
  createChannel(body: { kind: ChannelKind; name: string; driver: string; baseUrl: string; credential: string;
    modelMap: Record<string, string>; params?: Record<string, unknown>; costFen?: Record<string, number>; remark?: string }): Promise<Channel>;
  updateChannel(id: string, body: Partial<{ name: string; baseUrl: string; credential: string;
    modelMap: Record<string, string>; params: Record<string, unknown>; costFen: Record<string, number>; remark: string }>): Promise<Channel>;
  testChannel(id: string): Promise<TestResult>;
  trialChannel(id: string, capability: string): Promise<TrialResult>;
  routes(kind: ChannelKind): Promise<{ items: RouteRow[] }>;
  setRoutes(kind: ChannelKind, channelIds: string[]): Promise<{ items: RouteRow[] }>;
  setChannelStatus(id: string, status: 'active' | 'disabled'): Promise<Channel>;
  retireChannel(id: string): Promise<Channel>;
  // §8.1 用户与余额
  users(query?: UsersQuery): Promise<{ items: AdminUser[]; nextCursor: string | null }>;
  user(id: string): Promise<AdminUserDetail>;
  userLedger(id: string, cursor?: string): Promise<{ items: AdminLedgerItem[]; nextCursor: string | null }>;
  adjustBalance(id: string, body: { amountFen: number; reason: string; idempotencyKey: string }): Promise<{ wallet: { availableFen: number; frozenFen: number }; entry: AdminLedgerItem }>;
  setUserStatus(id: string, action: 'disable' | 'enable' | 'deactivate', reason: string): Promise<AdminUser>;
  // §8.2 订单与人工退款
  orders(query?: OrdersQuery): Promise<{ items: AdminOrder[]; nextCursor: string | null }>;
  order(id: string): Promise<AdminOrderDetail>;
  reconcileOrder(id: string): Promise<AdminOrder>;
  refundOrder(id: string, body: { amountFen: number; reason: string; idempotencyKey: string }): Promise<{ order: AdminOrder; entry: AdminLedgerItem }>;
  // §8.3 作品与失败/待核对处理
  projects(query?: ProjectsQuery): Promise<{ items: AdminProject[]; nextCursor: string | null }>;
  project(id: string): Promise<AdminProjectDetail>;
  resolveTake(takeId: string, body: { outcome: ResolveOutcome; note: string; idempotencyKey: string }): Promise<AdminProjectDetail>;
  cancelProject(id: string, reason: string): Promise<AdminProjectDetail>;
  // §8.4 价格与配置
  skus(): Promise<{ items: AdminSku[] }>;
  createSkuVersion(skuCode: string, body: { priceFen: number; costFen?: number; effectiveAt?: string; idempotencyKey: string }): Promise<AdminSku>;
  tiers(): Promise<{ items: AdminTier[] }>;
  updateTier(id: string, body: Partial<{ name: string; note: string; sort: number; status: 'active' | 'inactive' }>): Promise<AdminTier>;
  createTierMapping(id: string, videoSkuCode: string): Promise<AdminTierMapping>;
  styles(): Promise<{ items: AdminStyle[] }>;
  createStyle(body: StyleDraft): Promise<{ id: string }>;
  updateStyle(id: string, body: Partial<StyleDraft & { status: 'active' | 'inactive' }>): Promise<{ ok: boolean }>;
  voices(): Promise<{ items: AdminVoice[] }>;
  createVoice(body: VoiceDraft): Promise<{ id: string }>;
  updateVoice(id: string, body: Partial<VoiceDraft & { status: 'active' | 'inactive' }>): Promise<{ ok: boolean }>;
  settings(): Promise<{ items: AdminSettingItem[] }>;
  updateSettings(changes: Record<string, number>): Promise<{ items: AdminSettingItem[] }>;
  upload(file: File): Promise<{ uploadId: string; url?: string }>;
  // §8.5 审计（只读）
  audit(query?: AuditQuery): Promise<{ items: AdminAuditItem[]; nextCursor: string | null }>;
}

const BASE = '/api/v1'; // 管理端接口同挂在 /api/v1（真实后端联调发现：原 /api 缺 v1，全 404）

async function request<T>(method: string, path: string, body?: unknown, csrf?: string): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET' && csrf) headers['X-CSRF-Token'] = csrf;
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, { method, headers, credentials: 'same-origin',
      body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new MivApiError(0, { code: 'NETWORK_ERROR', message: '网络连接失败，请检查网络后重试' });
  }
  const data = response.status === 204 ? undefined : await response.json().catch(() => undefined);
  if (!response.ok) throw new MivApiError(response.status, data || {});
  return data as T;
}

/** multipart 上传（§8.4 管理端上传）：Content-Type 交给浏览器（带 boundary），CSRF 照常携带。 */
async function uploadFile(path: string, file: File, csrf?: string): Promise<{ uploadId: string; url?: string }> {
  const headers: Record<string, string> = {};
  if (csrf) headers['X-CSRF-Token'] = csrf;
  const form = new FormData();
  form.append('file', file, file.name);
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, { method: 'POST', headers, credentials: 'same-origin', body: form });
  } catch {
    throw new MivApiError(0, { code: 'NETWORK_ERROR', message: '网络连接失败，请检查网络后重试' });
  }
  const data = await response.json().catch(() => undefined);
  if (!response.ok) throw new MivApiError(response.status, data || {});
  return data as { uploadId: string; url?: string };
}

/** 管理端会话令牌存内存（后台是低频操作，刷新后重新登录即可，避免长期票据落 localStorage）。 */
let adminCsrf = '';
const remember = <T extends { csrfToken: string }>(session: T): T => { adminCsrf = session.csrfToken; return session; };

/** 查询串：跳过空值（保持与 channels() 的口径一致）。 */
const qs = (query: object) => {
  const entries = Object.entries(query) as [string, string | number | undefined][];
  const params = new URLSearchParams();
  for (const [key, value] of entries) {
    if (value !== undefined && value !== '') params.set(key, String(value));
  }
  const s = params.toString();
  return s ? `?${s}` : '';
};

export const adminHttp: AdminApi = {
  login: async (username, password) => remember(await request<{ admin: AdminSession; csrfToken: string }>('POST', '/admin/auth/login', { username, password })),
  logout: async () => { await request('POST', '/admin/auth/logout', undefined, adminCsrf); adminCsrf = ''; },
  drivers: () => request<{ items: DriverInfo[] }>('GET', '/admin/drivers'),
  channels: (kind, includeRetired) =>
    request<{ items: Channel[] }>('GET', `/admin/channels${qs({ kind: kind ?? '', includeRetired: includeRetired ? 'true' : '' })}`),
  createChannel: (body) => request<Channel>('POST', '/admin/channels', body, adminCsrf),
  updateChannel: (id, body) => request<Channel>('PATCH', `/admin/channels/${encodeURIComponent(id)}`, body, adminCsrf),
  testChannel: (id) => request<TestResult>('POST', `/admin/channels/${encodeURIComponent(id)}/test`, undefined, adminCsrf),
  trialChannel: (id, capability) =>
    request<TrialResult>('POST', `/admin/channels/${encodeURIComponent(id)}/trial`, { capability, confirm: true }, adminCsrf),
  routes: (kind) => request<{ items: RouteRow[] }>('GET', `/admin/routes/${kind}`),
  setRoutes: (kind, channelIds) => request<{ items: RouteRow[] }>('PUT', `/admin/routes/${kind}/*`, { channelIds }, adminCsrf),
  setChannelStatus: (id, status) =>
    request<Channel>('POST', `/admin/channels/${encodeURIComponent(id)}/${status === 'active' ? 'enable' : 'disable'}`, undefined, adminCsrf),
  retireChannel: (id) => request<Channel>('DELETE', `/admin/channels/${encodeURIComponent(id)}`, undefined, adminCsrf),
  // §8.1 用户与余额
  users: (query = {}) => request<{ items: AdminUser[]; nextCursor: string | null }>('GET', `/admin/users${qs(query)}`),
  user: (id) => request<AdminUserDetail>('GET', `/admin/users/${encodeURIComponent(id)}`),
  userLedger: (id, cursor) => request<{ items: AdminLedgerItem[]; nextCursor: string | null }>('GET', `/admin/users/${encodeURIComponent(id)}/ledger${qs({ cursor })}`),
  adjustBalance: (id, body) => request('POST', `/admin/users/${encodeURIComponent(id)}/adjust`, body, adminCsrf),
  setUserStatus: (id, action, reason) => request<AdminUser>(`POST`, `/admin/users/${encodeURIComponent(id)}/${action}`, { reason, ...(action === 'deactivate' ? { confirm: true } : {}) }, adminCsrf),
  // §8.2 订单与人工退款
  orders: (query = {}) => request<{ items: AdminOrder[]; nextCursor: string | null }>('GET', `/admin/orders${qs(query)}`),
  order: (id) => request<AdminOrderDetail>('GET', `/admin/orders/${encodeURIComponent(id)}`),
  reconcileOrder: (id) => request<AdminOrder>('POST', `/admin/orders/${encodeURIComponent(id)}/reconcile`, undefined, adminCsrf),
  refundOrder: (id, body) => request('POST', `/admin/orders/${encodeURIComponent(id)}/refund`, body, adminCsrf),
  // §8.3 作品与失败/待核对处理
  projects: (query = {}) => request<{ items: AdminProject[]; nextCursor: string | null }>('GET', `/admin/projects${qs(query)}`),
  project: (id) => request<AdminProjectDetail>('GET', `/admin/projects/${encodeURIComponent(id)}`),
  resolveTake: (takeId, body) => request('POST', `/admin/takes/${encodeURIComponent(takeId)}/resolve`, body, adminCsrf),
  cancelProject: (id, reason) => request<AdminProjectDetail>('POST', `/admin/projects/${encodeURIComponent(id)}/cancel`, { reason }, adminCsrf),
  // §8.4 价格与配置
  skus: () => request<{ items: AdminSku[] }>('GET', '/admin/skus'),
  createSkuVersion: (skuCode, body) =>
    request<AdminSku>('POST', `/admin/skus/${encodeURIComponent(skuCode)}/versions`, body, adminCsrf),
  tiers: () => request<{ items: AdminTier[] }>('GET', '/admin/tiers'),
  updateTier: (id, body) => request<AdminTier>('PATCH', `/admin/tiers/${encodeURIComponent(id)}`, body, adminCsrf),
  createTierMapping: (id, videoSkuCode) =>
    request<AdminTierMapping>('POST', `/admin/tiers/${encodeURIComponent(id)}/mappings`, { videoSkuCode }, adminCsrf),
  styles: () => request<{ items: AdminStyle[] }>('GET', '/admin/styles'),
  createStyle: (body) => request<{ id: string }>('POST', '/admin/styles', body, adminCsrf),
  updateStyle: (id, body) => request<{ ok: boolean }>('PATCH', `/admin/styles/${encodeURIComponent(id)}`, body, adminCsrf),
  voices: () => request<{ items: AdminVoice[] }>('GET', '/admin/voices'),
  createVoice: (body) => request<{ id: string }>('POST', '/admin/voices', body, adminCsrf),
  updateVoice: (id, body) => request<{ ok: boolean }>('PATCH', `/admin/voices/${encodeURIComponent(id)}`, body, adminCsrf),
  settings: () => request<{ items: AdminSettingItem[] }>('GET', '/admin/settings'),
  updateSettings: (changes) => request<{ items: AdminSettingItem[] }>('PATCH', '/admin/settings', changes, adminCsrf),
  upload: (file) => uploadFile('/admin/uploads', file, adminCsrf),
  // §8.5 审计（只读）
  audit: (query = {}) => request<{ items: AdminAuditItem[]; nextCursor: string | null }>('GET', `/admin/audit${qs(query)}`),
};

export const csrfOf = () => adminCsrf;
