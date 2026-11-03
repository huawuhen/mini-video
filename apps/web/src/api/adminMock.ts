// 管理端 mock（M3-ADM-01 演示/走查用）：内存数据模拟 API.md §8，不连后端、不产生费用。
// 管理员任意用户名 + 6 位密码可登录；试生成返回「演示模式不产生真实费用」。
import { MivApiError } from './http';
import type { AdminApi, Channel, DriverInfo, RouteRow } from './admin';

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

const state: { loggedIn: boolean; channels: Channel[]; routes: Record<string, string[]> } = {
  loggedIn: false,
  channels: seedChannels(),
  routes: {
    video: ['pch_demo_aiide_video', 'pch_demo_miaowu_video'],
    image: ['pch_demo_aiide_image'],
    llm: ['pch_demo_zhipu_llm'],
  },
};

const wait = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms));
// 与真实后端同形：抛 MivApiError（code/status），前端按 e.status/e.code 判断
const fail = (status: number, code: string, message: string): never => { throw new MivApiError(status, { code, message }); };
const requireLogin = () => { if (!state.loggedIn) fail(401, 'ADMIN_AUTH_REQUIRED', '请先登录管理后台'); };
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export const adminMock: AdminApi = {
  async login(username, password) {
    await wait();
    if (!username || String(password).length < 6) fail(401, 'ADMIN_AUTH_REQUIRED', '用户名或密码不正确（演示：任意用户名 + 6 位以上密码）');
    state.loggedIn = true;
    return { admin: { id: 'adm_demo0000000001', username }, csrfToken: 'mock-csrf' };
  },
  async logout() { state.loggedIn = false; },
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
};
