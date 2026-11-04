// 管理端 mock（M3-ADM-01 演示/走查用）：内存数据模拟 API.md §8，不连后端、不产生费用。
// 管理员任意用户名 + 6 位密码可登录；试生成返回「演示模式不产生真实费用」。
// M3-ADM-02：§8.1 用户与余额 / §8.2 订单与人工退款同步实现（错误码与校验口径与后端一致）。
import { MivApiError } from './http';
import type { AdminApi, AdminLedgerItem, AdminOrder, AdminUser, Channel, DriverInfo, LedgerKind, RouteRow, UserStatus } from './admin';

const now = () => new Date().toISOString();
const uid = (prefix: string) => `${prefix}_${Math.random().toString(36).slice(2, 12)}`;

const DRIVERS: DriverInfo[] = [
  { id: 'aiide-ark', kinds: ['video'], configSchema: { baseUrl: 'url（如 https://www.aiide.com）', credential: 'secret',
    params: { generateAudio: 'bool（是否生成原生音频，缺省 true）' } } },
  { id: 'openai-images', kinds: ['image'], configSchema: { baseUrl: 'url', credential: 'secret',
    params: { resolution: 'string（缺省 1k）', ratio: 'string（缺省 1:1）', quality: 'string（可空）', maxReferences: 'int（缺省 1）' } } },
  { id: 'openai-compatible', kinds: ['llm'], configSchema: { baseUrl: 'url（如 https://open.bigmodel.cn/api/paas/v4）', credential: 'secret' } },
  { id: 'openai-videos', kinds: ['video'], configSchema: { baseUrl: 'url', credential: 'secret',
    params: { model: 'string（缺省 seedance-2.5-deal）', requestTimeoutMs: 'int（缺省 180000）' } } },
  { id: 'openai-image-tasks', kinds: ['image'], configSchema: { baseUrl: 'url', credential: 'secret',
    params: { model: 'string（缺省 GPT-image-2）', pollIntervalMs: 'int（缺省 5000）', pollTimeoutMs: 'int（缺省 600000）' } } },
];

function seedChannels(): Channel[] {
  return [
    { id: 'pch_demo_aiide_video', kind: 'video', name: 'aiide', driver: 'aiide-ark', baseUrl: 'https://www.aiide.com',
      credentialMask: '****a9f2', modelMap: { video: 'dreamina-seedance-2-5-hc' }, params: { generateAudio: true },
      costFen: { 'video.480p': 68, 'video.720p': 151 }, status: 'active', remark: '火山方舟视频协议 + 素材库过审',
      inFlight: 2, recent: { total: 36, failed: 1, avgQueueSeconds: 1620 },
      costVsPrice: [{ capability: 'video.720p', costFen: 151, priceFen: 200 }], createdAt: now(), updatedAt: now() },
    { id: 'pch_demo_aiide_image', kind: 'image', name: 'aiide', driver: 'openai-images', baseUrl: 'https://www.aiide.com',
      credentialMask: '****a9f2', modelMap: { image: 'gpt-image-2' },
      params: { resolution: '1k', ratio: '1:1', quality: '', maxReferences: 1 },
      costFen: { 'image.look': 36 }, status: 'active', inFlight: 0,
      recent: { total: 58, failed: 2, avgQueueSeconds: 28 }, createdAt: now(), updatedAt: now() },
    { id: 'pch_demo_zhipu_llm', kind: 'llm', name: 'zhipu', driver: 'openai-compatible',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4', credentialMask: '****3c7d',
      modelMap: { llm: 'glm-5.3-flash' }, params: {}, status: 'active', remark: '智谱 OpenAI Compatible',
      inFlight: 0, recent: { total: 120, failed: 0, avgQueueSeconds: null }, createdAt: now(), updatedAt: now() },
    { id: 'pch_demo_miaowu_video', kind: 'video', name: 'miaowuai', driver: 'openai-videos',
      baseUrl: 'https://api.miaowuai.store', credentialMask: '****ee01', modelMap: { video: 'seedance-2.5-deal' },
      params: {}, costFen: { 'video.480p': 38, 'video.720p': 63 }, status: 'disabled', remark: '备用（手动切换）',
      inFlight: 0, recent: { total: 0, failed: 0, avgQueueSeconds: null }, createdAt: now(), updatedAt: now() },
    { id: 'pch_demo_old', kind: 'image', name: '旧渠道', driver: 'openai-image-tasks', baseUrl: 'https://old.example',
      credentialMask: '****', modelMap: { image: 'GPT-image-1' }, params: {}, status: 'retired',
      inFlight: 0, recent: null, createdAt: now(), updatedAt: now() },
  ];
}

const state: {
  loggedIn: boolean; adminName: string | null;
  channels: Channel[]; routes: Record<string, string[]>;
  users: MockUser[]; ledger: MockLedgerEntry[]; orders: MockOrder[]; idem: Map<string, string>;
} = {
  loggedIn: false,
  adminName: null,
  channels: seedChannels(),
  routes: {
    video: ['pch_demo_aiide_video', 'pch_demo_miaowu_video'],
    image: ['pch_demo_aiide_image'],
    llm: ['pch_demo_zhipu_llm'],
  },
  users: [], ledger: [], orders: [], idem: new Map(),
};
seedDemoData(); // 用户/流水/订单演示数据（users 在上面对象里先初始化为空数组，这里填充）

const wait = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms));
// 与真实后端同形：抛 MivApiError（code/status），前端按 e.status/e.code 判断
const fail = (status: number, code: string, message: string): never => { throw new MivApiError(status, { code, message }); };
const requireLogin = () => { if (!state.loggedIn) fail(401, 'ADMIN_AUTH_REQUIRED', '请先登录管理后台'); };
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
/** 去掉私有字段（_phone/_stats 等；mock 里存明文手机号与统计，接口输出不带）。 */
const strip = <T>(value: T): T => {
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!key.startsWith('_')) out[key] = entry;
  }
  return out as T;
};

// ── §8.1/§8.2 演示数据 ──
interface MockUser extends AdminUser {
  _phone: string;
  _stats: { projects: number; delivered: number; characters: number; activeProjects: number };
  _consents: { terms: string | null; photo: string | null };
  _wechatBound: boolean;
}
interface MockLedgerEntry extends AdminLedgerItem { _userId: string }
interface MockOrder extends AdminOrder { _notifyCount: number; _lastNotifyAt: string | null; _ledgerId: string | null }

// function 声明（非 const）：seedDemoData() 在模块初始化时执行，必须先于其可用
function daysAgo(days: number, hours = 0): string {
  return new Date(Date.now() - days * 86_400_000 - hours * 3_600_000).toISOString();
}

/** 填充 state.users / state.ledger / state.orders（调用时机在 state 初始化之后）。 */
function seedDemoData(): void {
  state.users = [
    { id: 'usr_demo0000000001', phoneMasked: '158****0001', _phone: '15811110001', nickname: '小满', status: 'active',
      balanceFen: 45600, frozenFen: 0, createdAt: daysAgo(26), lastLoginAt: daysAgo(0, 2),
      _stats: { projects: 6, delivered: 4, characters: 3, activeProjects: 1 },
      _consents: { terms: 'terms-v1', photo: 'photo-v1' }, _wechatBound: true },
    { id: 'usr_demo0000000002', phoneMasked: '137****2210', _phone: '13711112210', nickname: '阿澈', status: 'active',
      balanceFen: 3200, frozenFen: 3600, createdAt: daysAgo(12), lastLoginAt: daysAgo(1, 5),
      _stats: { projects: 2, delivered: 1, characters: 1, activeProjects: 1 },
      _consents: { terms: 'terms-v1', photo: null }, _wechatBound: false },
    { id: 'usr_demo0000000003', phoneMasked: '186****6635', _phone: '18611116635', nickname: '用户6635', status: 'disabled',
      balanceFen: 0, frozenFen: 0, createdAt: daysAgo(9), lastLoginAt: daysAgo(3),
      _stats: { projects: 1, delivered: 0, characters: 0, activeProjects: 0 },
      _consents: { terms: 'terms-v1', photo: null }, _wechatBound: false },
    { id: 'usr_demo0000000004', phoneMasked: '已注销', _phone: '', nickname: '已注销用户', status: 'deactivated',
      balanceFen: 0, frozenFen: 0, createdAt: daysAgo(31), lastLoginAt: daysAgo(20),
      _stats: { projects: 3, delivered: 2, characters: 1, activeProjects: 0 },
      _consents: { terms: 'terms-v1', photo: 'photo-v1' }, _wechatBound: false },
    { id: 'usr_demo0000000005', phoneMasked: '189****0921', _phone: '18911110921', nickname: '用户0921', status: 'active',
      balanceFen: 5000, frozenFen: 0, createdAt: daysAgo(1), lastLoginAt: daysAgo(1),
      _stats: { projects: 0, delivered: 0, characters: 0, activeProjects: 0 },
      _consents: { terms: 'terms-v1', photo: null }, _wechatBound: false },
  ];
  // 流水（新在前）；余额与流水自洽（演示数据，不追求严格对账）
  state.ledger = [
    { _userId: 'usr_demo0000000001', id: 'led_demo0000000001', kind: 'adjust', amountFen: 500, frozenDeltaFen: 0,
      title: '客服调整', refType: null, refId: null, reason: '活动奖励补偿', adminUsername: 'admin', createdAt: daysAgo(0, 5) },
    { _userId: 'usr_demo0000000001', id: 'led_demo0000000002', kind: 'recharge', amountFen: 50000, frozenDeltaFen: 0,
      title: '余额充值', refType: 'payment_order', refId: 'po_demo0000000002', createdAt: daysAgo(2) },
    { _userId: 'usr_demo0000000001', id: 'led_demo0000000003', kind: 'settle', amountFen: 0, frozenDeltaFen: -5400,
      title: '从冻结中扣除', refType: 'project', refId: 'prj_demo0000000001', createdAt: daysAgo(2, 6) },
    { _userId: 'usr_demo0000000001', id: 'led_demo0000000004', kind: 'reserve', amountFen: -5400, frozenDeltaFen: 5400,
      title: '作品《春天的野餐》预占', refType: 'project', refId: 'prj_demo0000000001', createdAt: daysAgo(2, 7) },
    { _userId: 'usr_demo0000000002', id: 'led_demo0000000005', kind: 'reserve', amountFen: -3600, frozenDeltaFen: 3600,
      title: '作品《城市夜跑》预占', refType: 'project', refId: 'prj_demo0000000002', createdAt: daysAgo(1, 3) },
    { _userId: 'usr_demo0000000002', id: 'led_demo0000000006', kind: 'redeem', amountFen: 6800, frozenDeltaFen: 0,
      title: '兑换码充值', refType: 'redeem_code', refId: 'demo-hash', createdAt: daysAgo(4) },
    { _userId: 'usr_demo0000000005', id: 'led_demo0000000007', kind: 'recharge', amountFen: 5000, frozenDeltaFen: 0,
      title: '余额充值', refType: 'payment_order', refId: 'po_demo0000000004', createdAt: daysAgo(1) },
  ];
  state.orders = [
    { id: 'po_demo0000000002', userId: 'usr_demo0000000001', phoneMasked: '158****0001',
      outTradeNo: 'po_demo0000000002', transactionId: 'demo_tx_4200a1', amountFen: 50000, refundedFen: 0,
      scene: 'native', status: 'paid', createdAt: daysAgo(2), paidAt: daysAgo(2, -1), _notifyCount: 2, _lastNotifyAt: daysAgo(2), _ledgerId: 'led_demo0000000002' },
    { id: 'po_demo0000000003', userId: 'usr_demo0000000002', phoneMasked: '137****2210',
      outTradeNo: 'po_demo0000000003', transactionId: null, amountFen: 10000, refundedFen: 0,
      scene: 'jsapi', status: 'created', createdAt: daysAgo(0, 1), paidAt: null, _notifyCount: 0, _lastNotifyAt: null, _ledgerId: null },
    { id: 'po_demo0000000004', userId: 'usr_demo0000000005', phoneMasked: '189****0921',
      outTradeNo: 'po_demo0000000004', transactionId: 'demo_tx_4200b2', amountFen: 5000, refundedFen: 0,
      scene: 'h5', status: 'paid', createdAt: daysAgo(1), paidAt: daysAgo(0, 23), _notifyCount: 1, _lastNotifyAt: daysAgo(0, 23), _ledgerId: 'led_demo0000000007' },
    { id: 'po_demo0000000001', userId: 'usr_demo0000000001', phoneMasked: '158****0001',
      outTradeNo: 'po_demo0000000001', transactionId: null, amountFen: 50000, refundedFen: 0,
      scene: 'native', status: 'expired', createdAt: daysAgo(8), paidAt: null, _notifyCount: 1, _lastNotifyAt: daysAgo(8), _ledgerId: null },
  ];
}

function requireUser(id: string): MockUser {
  const user = state.users.find((u) => u.id === id);
  if (!user) throw fail(404, 'USER_NOT_FOUND', '用户不存在');
  return user;
}

function newLedger(userId: string, kind: LedgerKind, amountFen: number, title: string,
  extra: { reason?: string; adminUsername?: string; refType?: string; refId?: string } = {}): MockLedgerEntry {
  const entry: MockLedgerEntry = { _userId: userId, id: uid('led'), kind, amountFen, frozenDeltaFen: 0,
    title, refType: extra.refType ?? null, refId: extra.refId ?? null, createdAt: now(),
    ...(extra.reason ? { reason: extra.reason } : {}), ...(extra.adminUsername ? { adminUsername: extra.adminUsername } : {}) };
  state.ledger.unshift(entry);
  return entry;
}

/** 游标编码（演示用 offset；真实后端是 created_us~id keyset，前端只当不透明字符串）。 */
const encodeCursor = (offset: number) => btoa(String(offset));
const decodeCursor = (cursor?: string) => (cursor ? Number(atob(cursor)) || 0 : 0);

export const adminMock: AdminApi = {
  async login(username, password) {
    await wait();
    if (!username || String(password).length < 6) fail(401, 'ADMIN_AUTH_REQUIRED', '用户名或密码不正确（演示：任意用户名 + 6 位以上密码）');
    state.loggedIn = true;
    state.adminName = username;
    return { admin: { id: 'adm_demo0000000001', username }, csrfToken: 'mock-csrf' };
  },
  async logout() { state.loggedIn = false; state.adminName = null; },
  async drivers() { await wait(80); return { items: clone(DRIVERS) }; },
  async channels(kind, includeRetired) {
    await wait(120); requireLogin();
    return { items: clone(state.channels.filter((c) => (!kind || c.kind === kind)
      && (includeRetired || c.status !== 'retired'))) };
  },
  async createChannel(body) {
    await wait(); requireLogin();
    if (!DRIVERS.some((d) => d.id === body.driver)) fail(400, 'DRIVER_NOT_FOUND', '指定的协议驱动不存在');
    const { credential, params, ...rest } = body;
    const channel: Channel = { id: uid('pch'), credentialMask: `****${credential.slice(-4)}`, status: 'active',
      inFlight: 0, recent: null, ...rest, params: params ?? {}, createdAt: now(), updatedAt: now() };
    state.channels.unshift(channel);
    return clone(channel);
  },
  async updateChannel(id, body) {
    await wait(); requireLogin();
    const channel = state.channels.find((c) => c.id === id);
    if (!channel) throw fail(404, 'CHANNEL_NOT_FOUND', '渠道不存在');
    if (body.credential) channel.credentialMask = `****${body.credential.slice(-4)}`;
    Object.assign(channel, { ...body, credential: undefined, updatedAt: now() });
    return clone(channel);
  },
  async testChannel(id) {
    await wait(600); requireLogin();
    const channel = state.channels.find((c) => c.id === id);
    if (!channel) throw fail(404, 'CHANNEL_NOT_FOUND', '渠道不存在');
    const model = Object.values(channel.modelMap)[0] ?? 'demo-model';
    return { ok: true, latencyMs: 120 + Math.floor(Math.random() * 300),
      models: [{ name: model, priceFenPerUnit: null }, { name: `${model}-hd`, priceFenPerUnit: null }],
      mismatches: [] };
  },
  async trialChannel(id, capability) {
    await wait(900); requireLogin();
    if (!state.channels.some((c) => c.id === id)) throw fail(404, 'CHANNEL_NOT_FOUND', '渠道不存在');
    return { ok: true, message: '演示模式：试生成不产生真实费用（真实环境按最小成本计费并写审计）', capability };
  },
  async routes(kind) {
    await wait(80); requireLogin();
    const ids = state.routes[kind] ?? [];
    const items: RouteRow[] = ids
      .map((id, index) => {
        const channel = state.channels.find((c) => c.id === id);
        return channel ? { capability: '*', rank: index, id: channel.id, name: channel.name,
          status: channel.status, driver: channel.driver } : null;
      })
      .filter((x): x is RouteRow => x !== null);
    return { items };
  },
  async setRoutes(kind, channelIds) {
    await wait(); requireLogin();
    // 与后端同口径：渠道列表有重复直接拒绝（VALIDATION_FAILED）
    if (new Set(channelIds).size !== channelIds.length) {
      throw fail(400, 'VALIDATION_FAILED', '渠道列表有重复');
    }
    state.routes[kind] = [...channelIds];
    return adminMock.routes(kind);
  },
  async setChannelStatus(id, status) {
    await wait(); requireLogin();
    const channel = state.channels.find((c) => c.id === id);
    if (!channel) throw fail(404, 'CHANNEL_NOT_FOUND', '渠道不存在');
    if (channel.status === 'retired') throw fail(400, 'VALIDATION_FAILED', '渠道已删除，不能变更状态（与后端一致）');
    channel.status = status;
    return clone(channel);
  },
  async retireChannel(id) {
    await wait(); requireLogin();
    const channel = state.channels.find((c) => c.id === id);
    if (!channel) throw fail(404, 'CHANNEL_NOT_FOUND', '渠道不存在');
    channel.status = 'retired';
    for (const kind of Object.keys(state.routes)) {
      state.routes[kind] = state.routes[kind].filter((cid) => cid !== id);
    }
    return clone(channel);
  },

  // ───────────── §8.1 用户与余额 / §8.2 订单与人工退款（M3-ADM-02 演示数据） ─────────────

  async users(query = {}) {
    await wait(120); requireLogin();
    let list = [...state.users];
    if (query.phone) list = list.filter((u) => u._phone === query.phone); // 只支持完整号码精确匹配
    if (query.userId) list = list.filter((u) => u.id === query.userId);
    if (query.status) list = list.filter((u) => u.status === query.status);
    const limit = query.limit ?? 20;
    const offset = decodeCursor(query.cursor);
    const page = list.slice(offset, offset + limit);
    const next = offset + limit;
    return { items: page.map((u) => clone(strip(u))), nextCursor: next < list.length ? encodeCursor(next) : null };
  },

  async user(id) {
    await wait(120); requireLogin();
    const found = state.users.find((u) => u.id === id);
    if (!found) throw fail(404, 'USER_NOT_FOUND', '用户不存在');
    const ledger = state.ledger.filter((e) => e._userId === id);
    const recharged = ledger.filter((e) => e.kind === 'recharge' || e.kind === 'redeem').reduce((sum, e) => sum + e.amountFen, 0);
    const spent = ledger.filter((e) => (e.kind === 'settle' && e.frozenDeltaFen < 0) || (e.kind === 'charge' && e.amountFen < 0))
      .reduce((sum, e) => sum + (e.kind === 'settle' ? -e.frozenDeltaFen : -e.amountFen), 0);
    return {
      ...clone(strip(found)),
      stats: { projects: found._stats.projects, delivered: found._stats.delivered, characters: found._stats.characters,
        rechargedFen: recharged, spentFen: spent },
      consents: { ...found._consents },
      wechatBound: found._wechatBound,
    };
  },

  async userLedger(id, cursor) {
    await wait(100); requireLogin();
    const all = state.ledger.filter((e) => e._userId === id);
    const offset = decodeCursor(cursor);
    const limit = 20;
    const page = all.slice(offset, offset + limit);
    const next = offset + limit;
    return { items: page.map((e) => clone(strip(e))), nextCursor: next < all.length ? encodeCursor(next) : null };
  },

  async adjustBalance(id, body) {
    await wait(); requireLogin();
    const user = requireUser(id);
    if (!Number.isSafeInteger(body.amountFen) || body.amountFen === 0) {
      throw fail(400, 'VALIDATION_FAILED', '调整金额必须是非 0 的整数（分）');
    }
    if (!body.reason?.trim()) throw fail(400, 'VALIDATION_FAILED', '请填写调整原因');
    const first = state.idem.get(body.idempotencyKey);
    if (first) {
      const hit = JSON.parse(first);
      if (hit.amountFen !== body.amountFen) throw fail(409, 'IDEMPOTENCY_CONFLICT', '请求重复，请刷新后重试');
      return clone(hit.result);
    }
    if (body.amountFen < 0 && user.balanceFen + body.amountFen < 0) {
      throw fail(400, 'ADJUST_EXCEEDS_BALANCE', '可用余额不足，不能扣减这么多');
    }
    user.balanceFen += body.amountFen;
    const entry = newLedger(id, 'adjust', body.amountFen, '客服调整', { reason: body.reason, adminUsername: state.adminName ?? 'admin' });
    const result = { wallet: { availableFen: user.balanceFen, frozenFen: user.frozenFen }, entry: clone(strip(entry)) };
    state.idem.set(body.idempotencyKey, JSON.stringify({ amountFen: body.amountFen, result }));
    return result;
  },

  async setUserStatus(id, action, reason) {
    await wait(); requireLogin();
    const user = requireUser(id);
    if (!reason?.trim()) throw fail(400, 'VALIDATION_FAILED', '请填写原因');
    if (action === 'disable') {
      if (user.status === 'deactivated') throw fail(400, 'VALIDATION_FAILED', '该账号已注销，不能变更状态');
      if (user.status !== 'active') throw fail(400, 'VALIDATION_FAILED', '账号状态已变化，请刷新后重试');
      user.status = 'disabled';
    } else if (action === 'enable') {
      if (user.status === 'deactivated') throw fail(400, 'VALIDATION_FAILED', '已注销账号不能恢复使用');
      if (user.status !== 'disabled') throw fail(400, 'VALIDATION_FAILED', '账号状态已变化，请刷新后重试');
      user.status = 'active';
    } else {
      if (user.status === 'deactivated') return clone(strip(user)); // 幂等：已注销直接返回
      if (user._stats.activeProjects > 0) {
        throw fail(409, 'USER_HAS_ACTIVE_PROJECTS', '该用户还有进行中的作品，暂不能注销');
      }
      if (user.balanceFen > 0) {
        newLedger(id, 'adjust', -user.balanceFen, '客服调整', { reason, adminUsername: state.adminName ?? 'admin' });
        user.balanceFen = 0;
      }
      user.status = 'deactivated';
      user.phoneMasked = '已注销';
    }
    return clone(strip(user));
  },

  async orders(query = {}) {
    await wait(120); requireLogin();
    let list = [...state.orders];
    if (query.status) list = list.filter((o) => o.status === query.status);
    if (query.userId) list = list.filter((o) => o.userId === query.userId);
    if (query.outTradeNo) list = list.filter((o) => o.outTradeNo === query.outTradeNo);
    if (query.from) list = list.filter((o) => o.createdAt >= query.from!);
    if (query.to) list = list.filter((o) => o.createdAt <= query.to!);
    const limit = query.limit ?? 20;
    const offset = decodeCursor(query.cursor);
    const page = list.slice(offset, offset + limit);
    const next = offset + limit;
    return { items: page.map((o) => clone(strip(o))), nextCursor: next < list.length ? encodeCursor(next) : null };
  },

  async order(id) {
    await wait(120); requireLogin();
    const order = state.orders.find((o) => o.id === id);
    if (!order) throw fail(404, 'ORDER_NOT_FOUND', '订单不存在');
    return { ...clone(strip(order)), notifyCount: order._notifyCount, lastNotifyAt: order._lastNotifyAt ?? null, ledgerId: order._ledgerId ?? null };
  },

  async reconcileOrder(id) {
    await wait(600); requireLogin();
    const order = state.orders.find((o) => o.id === id);
    if (!order) throw fail(404, 'ORDER_NOT_FOUND', '订单不存在');
    if (order.status === 'created') {
      // 演示：模拟「微信侧已支付」→ 补入账
      order.status = 'paid';
      order.paidAt = now();
      order.transactionId = `demo_tx_${Math.random().toString(36).slice(2, 10)}`;
      order._notifyCount += 1;
      order._lastNotifyAt = now();
      const user = state.users.find((u) => u.id === order.userId);
      const entry = newLedger(order.userId, 'recharge', order.amountFen, '余额充值');
      if (user) user.balanceFen += order.amountFen;
      order._ledgerId = entry.id;
    }
    return clone(strip(order));
  },

  async refundOrder(id, body) {
    await wait(); requireLogin();
    const order = state.orders.find((o) => o.id === id);
    if (!order) throw fail(404, 'ORDER_NOT_FOUND', '订单不存在');
    if (!Number.isSafeInteger(body.amountFen) || body.amountFen <= 0) {
      throw fail(400, 'VALIDATION_FAILED', '退款金额必须是非 0 的整数（分）');
    }
    if (!body.reason?.trim()) throw fail(400, 'VALIDATION_FAILED', '请填写退款原因');
    const first = state.idem.get(body.idempotencyKey);
    if (first) {
      const hit = JSON.parse(first);
      if (hit.amountFen !== body.amountFen) throw fail(409, 'IDEMPOTENCY_CONFLICT', '请求重复，请刷新后重试');
      return clone(hit.result);
    }
    if (order.status !== 'paid') throw fail(409, 'ORDER_NOT_PAID', '订单未支付，不能登记退款');
    if (order.refundedFen + body.amountFen > order.amountFen) {
      throw fail(400, 'REFUND_EXCEEDS_ORDER', '退款金额超过订单可退金额');
    }
    const user = state.users.find((u) => u.id === order.userId);
    if (user && user.balanceFen < body.amountFen) {
      throw fail(400, 'REFUND_EXCEEDS_BALANCE', '用户可用余额不足，无法登记退款');
    }
    if (user) user.balanceFen -= body.amountFen;
    order.refundedFen += body.amountFen;
    const entry = newLedger(order.userId, 'adjust', -body.amountFen, '充值退款',
      { reason: body.reason, adminUsername: state.adminName ?? 'admin', refType: 'payment_order', refId: order.id });
    const result = { order: clone(strip(order)), entry: clone(strip(entry)) };
    state.idem.set(body.idempotencyKey, JSON.stringify({ amountFen: body.amountFen, result }));
    return result;
  },
};
