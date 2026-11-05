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
}

const BASE = '/api';

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
};

export const csrfOf = () => adminCsrf;
