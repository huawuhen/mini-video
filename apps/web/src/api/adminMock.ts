// 管理端 mock（M3-ADM-01 演示/走查用）：内存数据模拟 API.md §8，不连后端、不产生费用。
// 管理员任意用户名 + 6 位密码可登录；试生成返回「演示模式不产生真实费用」。
// M3-ADM-02：§8.1 用户与余额 / §8.2 订单与人工退款同步实现（错误码与校验口径与后端一致）。
import { MivApiError } from './http';
import type { AdminApi, AdminAuditItem, AdminLedgerItem, AdminOrder, AdminProject, AdminProjectDetail,
  AdminSettingItem, AdminSku, AdminStyle, AdminTier, AdminUser, AdminVoice, Channel, DriverInfo,
  LedgerKind, ResolveOutcome, RouteRow, UserStatus } from './admin';

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
  users: MockUser[]; ledger: MockLedgerEntry[]; orders: MockOrder[]; projects: MockProject[]; idem: Map<string, string>;
  skus: MockSku[]; tiers: MockTier[]; styles: MockStyle[]; voices: MockVoice[];
  settings: Map<string, number>; settingsMeta: Map<string, AdminSettingItem>;
  uploads: Map<string, { kind: 'image' | 'audio'; referenced: boolean }>;
  audit: MockAudit[]; auditSeq: number; skuIdem: Map<string, number>;
} = {
  loggedIn: false,
  adminName: null,
  channels: seedChannels(),
  routes: {
    video: ['pch_demo_aiide_video', 'pch_demo_miaowu_video'],
    image: ['pch_demo_aiide_image'],
    llm: ['pch_demo_zhipu_llm'],
  },
  users: [], ledger: [], orders: [], projects: [], idem: new Map(),
  skus: [], tiers: [], styles: [], voices: [],
  settings: new Map(), settingsMeta: new Map(),
  uploads: new Map(),
  audit: [], auditSeq: 0, skuIdem: new Map(),
};
seedDemoData(); // 用户/流水/订单演示数据（users 在上面对象里先初始化为空数组，这里填充）
/** 运营参数白名单（与后端 SETTING_DEFS 同口径：label / 上下限）。 */
const SETTING_DEFS: Array<{ key: string; label: string; min: number; max: number; value: number }> = [
  { key: 'daily_free_understanding', label: '每天免费整理次数', min: 0, max: 1000, value: 20 },
  { key: 'max_story_chars', label: '故事最长字数', min: 50, max: 20000, value: 3000 },
  { key: 'min_story_chars', label: '故事最短字数', min: 1, max: 1000, value: 5 },
  { key: 'max_character_photos', label: '每个数字人照片上限', min: 1, max: 20, value: 5 },
  { key: 'max_duration_seconds', label: '作品最长时长（秒）', min: 30, max: 300, value: 90 },
  { key: 'quote_ttl_seconds', label: '报价有效期（秒）', min: 60, max: 86400, value: 900 },
  { key: 'expiry_remind_days', label: '到期前提醒（天）', min: 0, max: 90, value: 7 },
  { key: 'retention_days', label: '成片保存期（天）', min: 7, max: 365, value: 90 },
];

seedPricingData(); // §8.4 SKU/档位/风格/音色/运营参数 + §8.5 审计演示数据

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
interface MockTake {
  id: string; segmentId: string; status: 'pending' | 'running' | 'succeeded' | 'failed' | 'unknown';
  genTaskStatus: string | null; channel: string | null; upstreamTaskId: string | null;
  frozenFen: number; error?: { code?: string; message?: string } | null;
  redelivery?: boolean; // 交付后重拍：无重试入口，判定后当场退回
  resolvedOutcome?: 'not_charged' | 'charged'; resolvedNote?: string; resolvedKey?: string;
  resolvedAt?: string; createdAt: string;
}
interface MockSegment { id: string; index: number; durationSeconds: number; plot: string; selectedTakeId: string | null; takes: MockTake[] }
interface MockProject {
  id: string; userId: string; title: string; status: AdminProject['status'];
  progress: { percent: number; message: string };
  money: { reservedFen: number; settledFen: number; refundedFen: number; frozenFen: number };
  segments: MockSegment[]; events: AdminProjectDetail['events'];
  createdAt: string; updatedAt: string;
}
interface MockOrder extends AdminOrder { _notifyCount: number; _lastNotifyAt: string | null; _ledgerId: string | null }

// ── §8.4/§8.5 mock 数据结构 ──
interface MockSku extends AdminSku { status: 'active' | 'inactive'; kind: AdminSku['kind'] }
interface MockTierMapping { id: string; version: number; videoSkuCode: string; effectiveAt: string }
interface MockTier extends Omit<AdminTier, 'currentMapping'> { mappings: MockTierMapping[]; status: 'active' | 'inactive' }
interface MockStyle extends Omit<AdminStyle, 'coverUploadId'> { coverUploadId: string | null }
interface MockVoice extends Omit<AdminVoice, 'sampleUploadId' | 'refAudioUploadId'> {
  sampleUploadId: string | null; refAudioUploadId: string | null;
}
interface MockAudit extends AdminAuditItem { }

// function 声明（非 const）：seedDemoData() 在模块初始化时执行，必须先于其可用
function daysAgo(days: number, hours = 0): string {
  return new Date(Date.now() - days * 86_400_000 - hours * 3_600_000).toISOString();
}

/** 填充 state.users / state.ledger / state.orders（调用时机在 state 初始化之后）。 */
function seedDemoData(): void {
  state.users = [
    { id: 'usr_demo0000000001', phoneMasked: '158****0001', _phone: '15811110001', nickname: '小满', status: 'active',
      balanceFen: 45600, frozenFen: 5000, createdAt: daysAgo(26), lastLoginAt: daysAgo(0, 2),
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

  // 作品（M3-ADM-03）：prj1 failed 带两个待核对片段（判定演示）、prj2 rendering（取消演示）、prj3 delivered
  const mkTake = (id: string, segmentId: string, take: Partial<MockTake> & Pick<MockTake, 'status'>): MockTake => ({
    id, segmentId, genTaskStatus: null, channel: null, upstreamTaskId: null, frozenFen: 0,
    error: null, createdAt: now(), ...take,
  });
  const seg = (id: string, index: number, durationSeconds: number, plot: string, takes: MockTake[]): MockSegment =>
    ({ id, index, durationSeconds, plot, selectedTakeId: takes.find((t) => t.status === 'succeeded')?.id ?? null, takes });
  state.projects = [
    { id: 'prj_demo0000000001', userId: 'usr_demo0000000001', title: '春天的野餐（复审演示）', status: 'failed',
      progress: { percent: 45, message: '片段提交结果未知，金额已冻结，请联系客服处理' },
      money: { reservedFen: 8000, settledFen: 3000, refundedFen: 0, frozenFen: 5000 },
      segments: [
        seg('seg_demo0000000001', 0, 30, '清晨，小满和家人准备野餐篮出发。', [
          mkTake('take_demo0000000001', 'seg_demo0000000001', { status: 'unknown',
            genTaskStatus: 'unknown', channel: 'aiide', upstreamTaskId: 'task_9f8e7d6c',
            frozenFen: 3000, error: { code: 'TAKE_UNKNOWN', message: '片段提交结果未知，金额已冻结' } }),
        ]),
        seg('seg_demo0000000002', 1, 30, '一家人在草地上铺开野餐垫，小满追蝴蝶。', [
          mkTake('take_demo0000000002', 'seg_demo0000000002', { status: 'succeeded',
            genTaskStatus: 'succeeded', channel: 'aiide', upstreamTaskId: 'task_1a2b3c4d' }),
        ]),
        seg('seg_demo0000000003', 2, 20, '傍晚收摊回家，小满在车里睡着。', [
          mkTake('take_demo0000000003', 'seg_demo0000000003', { status: 'unknown',
            genTaskStatus: 'unknown', channel: 'aiide', upstreamTaskId: 'task_77aa88bb',
            frozenFen: 2000, error: { code: 'TAKE_UNKNOWN', message: '片段提交结果未知，金额已冻结' } }),
        ]),
      ],
      events: [
        { id: 3, status: 'failed', progress: { percent: 45, message: '片段提交结果未知，金额已冻结，请联系客服处理' }, createdAt: daysAgo(0, 3) },
        { id: 2, status: 'rendering', progress: { percent: 45, message: '正在生成第 1/3 段' }, createdAt: daysAgo(1) },
        { id: 1, status: 'cast_review', progress: { percent: 30, message: '等待确认角色' }, createdAt: daysAgo(2) },
      ],
      createdAt: daysAgo(2), updatedAt: daysAgo(0, 3) },
    { id: 'prj_demo0000000002', userId: 'usr_demo0000000002', title: '城市夜跑（取消演示）', status: 'rendering',
      progress: { percent: 60, message: '正在生成第 2/2 段' },
      money: { reservedFen: 3600, settledFen: 0, refundedFen: 0, frozenFen: 3600 },
      segments: [
        seg('seg_demo0000000004', 0, 18, '夜幕下的江边跑道，路灯次第亮起。', [
          mkTake('take_demo0000000004', 'seg_demo0000000004', { status: 'succeeded',
            genTaskStatus: 'succeeded', channel: 'aiide', upstreamTaskId: 'task_ccdd11ee' }),
        ]),
        seg('seg_demo0000000005', 1, 18, '主角冲过终点，汗水与笑容。', [
          mkTake('take_demo0000000005', 'seg_demo0000000005', { status: 'running',
            genTaskStatus: 'running', channel: 'aiide', upstreamTaskId: 'task_eeff2233' }),
        ]),
      ],
      events: [
        { id: 2, status: 'rendering', progress: { percent: 60, message: '正在生成第 2/2 段' }, createdAt: daysAgo(0, 6) },
        { id: 1, status: 'cast_review', progress: { percent: 30, message: '等待确认角色' }, createdAt: daysAgo(1, 2) },
      ],
      createdAt: daysAgo(1, 2), updatedAt: daysAgo(0, 6) },
    { id: 'prj_demo0000000003', userId: 'usr_demo0000000001', title: '外婆的菜园', status: 'delivered',
      progress: { percent: 100, message: '已交付' },
      money: { reservedFen: 3000, settledFen: 3000, refundedFen: 0, frozenFen: 0 },
      segments: [
        seg('seg_demo0000000006', 0, 30, '外婆在菜园里摘下第一根黄瓜。', [
          mkTake('take_demo0000000006', 'seg_demo0000000006', { status: 'succeeded',
            genTaskStatus: 'succeeded', channel: 'aiide', upstreamTaskId: 'task_abcd1234' }),
        ]),
      ],
      events: [
        { id: 2, status: 'delivered', progress: { percent: 100, message: '已交付' }, createdAt: daysAgo(5) },
        { id: 1, status: 'rendering', progress: { percent: 40, message: '正在生成片段' }, createdAt: daysAgo(6) },
      ],
      createdAt: daysAgo(6), updatedAt: daysAgo(5) },
  ];
}


/** §8.4/§8.5 演示数据：SKU 与迁移 009 同口径（video.480p 100 / video.720p 200 / image.look 60）。 */
function seedPricingData(): void {
  const sku = (skuCode: string, kind: AdminSku['kind'], unit: AdminSku['unit'], priceFen: number,
    resolution: string | null = null): MockSku => ({
    skuCode, kind, model: kind === 'llm' ? 'glm-5.3-flash' : '', resolution, unit,
    priceFen, costFen: 0, version: 1, versions: 1,
    effectiveAt: daysAgo(30), marginRate: priceFen > 0 ? 1 : null, status: 'active',
  });
  state.skus = [
    sku('video.480p', 'video', 'second', 100, '480p'),
    sku('video.720p', 'video', 'second', 200, '720p'),
    sku('image.look', 'image', 'image', 60, '1k'),
    sku('llm.story', 'llm', 'ktoken', 0),
  ];
  state.tiers = [
    { id: 'standard', name: '标准', note: '清晰流畅', sort: 10, status: 'active',
      mappings: [{ id: 'tm_standard_demo', version: 5, videoSkuCode: 'video.480p', effectiveAt: daysAgo(30) }] },
    { id: 'hd', name: '高清', note: '细节更丰富', sort: 20, status: 'active',
      mappings: [{ id: 'tm_hd_demo', version: 5, videoSkuCode: 'video.720p', effectiveAt: daysAgo(30) }] },
  ];
  state.styles = [
    { id: 'style_realistic_demo', name: '真人写实', description: '接近真实拍摄的家庭影像', coverUploadId: null, promptHint: 'photorealistic', sort: 10, status: 'active' },
    { id: 'style_manga_demo', name: '漫剧', description: '国漫或短剧漫画风，适合剧情类', coverUploadId: null, promptHint: 'manhua drama', sort: 20, status: 'active' },
    { id: 'style_cartoon3d_demo', name: '卡通 3D', description: '类皮克斯 3D 动画，温馨', coverUploadId: null, promptHint: '3d animation', sort: 30, status: 'active' },
    { id: 'style_anime_demo', name: '日系动漫', description: '2D 赛璐璐', coverUploadId: null, promptHint: 'anime cel', sort: 40, status: 'active' },
    { id: 'style_book_demo', name: '绘本水彩', description: '儿童绘本质感', coverUploadId: null, promptHint: 'picture book', sort: 50, status: 'inactive' },
  ];
  state.voices = [
    { id: 'vc_demo_1', name: '温柔少女', category: 'girl', gender: 'female', ageGroup: 'teen', description: '轻柔细腻，适合温馨叙述',
      sampleUploadId: null, refAudioUploadId: null, sort: 10, status: 'active' },
    { id: 'vc_demo_2', name: '沉稳青年男', category: 'young_m', gender: 'male', ageGroup: 'young', description: '低沉有磁性',
      sampleUploadId: null, refAudioUploadId: null, sort: 20, status: 'active' },
    { id: 'vc_demo_3', name: '亲切中年女', category: 'middle_f', gender: 'female', ageGroup: 'middle', description: '温暖亲和',
      sampleUploadId: null, refAudioUploadId: null, sort: 30, status: 'active' },
  ];
  for (const def of SETTING_DEFS) {
    state.settings.set(def.key, def.value);
    state.settingsMeta.set(def.key, { key: def.key, label: def.label, type: 'int', min: def.min, max: def.max, value: def.value });
  }
  state.audit = [
    { id: ++state.auditSeq, adminUsername: 'admin', action: 'channel.create', targetType: 'provider_channel',
      targetId: 'pch_demo_aiide_video', detail: { name: 'aiide' }, ip: '192.168.5.12', createdAt: daysAgo(6) },
    { id: ++state.auditSeq, adminUsername: 'admin', action: 'wallet.adjust', targetType: 'user',
      targetId: 'usr_demo0000000001', detail: { amountFen: 500, reason: '活动奖励补偿' }, ip: '192.168.5.12', createdAt: daysAgo(0, 5) },
  ];
}

function skuView(row: MockSku): AdminSku {
  const versions = state.skus.filter((item) => item.skuCode === row.skuCode).length;
  return { ...row, versions, marginRate: row.priceFen > 0 ? Math.round(((row.priceFen - row.costFen) / row.priceFen) * 10_000) / 10_000 : null };
}

/** 当前生效版本：active 且已到生效时间的最大 version（与后端 latestActiveSku 同口径）。 */
function currentSkuView(skuCode: string): AdminSku | null {
  const nowIso = new Date().toISOString();
  const rows = state.skus
    .filter((item) => item.skuCode === skuCode && item.status === 'active' && item.effectiveAt <= nowIso)
    .sort((a, b) => b.version - a.version);
  return rows.length ? skuView(rows[0]) : null;
}

function tierView(tier: MockTier): AdminTier {
  const mapping = [...tier.mappings].sort((a, b) => b.version - a.version)[0] ?? null;
  const price = mapping ? currentSkuView(mapping.videoSkuCode)?.priceFen ?? null : null;
  return {
    id: tier.id, name: tier.name, note: tier.note, sort: tier.sort, status: tier.status,
    currentMapping: mapping ? { ...mapping, priceFen: price } : null,
  };
}

function pushAudit(action: string, targetType: string, targetId: string, detail: Record<string, unknown>): void {
  state.audit.unshift({ id: ++state.auditSeq, adminUsername: state.adminName ?? 'admin',
    action, targetType, targetId, detail, ip: '127.0.0.1', createdAt: now() });
}

function requireUpload(uploadId: string, kinds: Array<'image' | 'audio'>): void {
  const upload = state.uploads.get(uploadId);
  if (!upload || !kinds.includes(upload.kind)) throw fail(400, 'VALIDATION_FAILED', '填写的内容有误，请检查后重试');
}

function requireUser(id: string): MockUser {
  const user = state.users.find((u) => u.id === id);
  if (!user) throw fail(404, 'USER_NOT_FOUND', '用户不存在');
  return user;
}

function newLedger(userId: string, kind: LedgerKind, amountFen: number, title: string,
  extra: { reason?: string; adminUsername?: string; refType?: string; refId?: string; frozenDeltaFen?: number } = {}): MockLedgerEntry {
  const entry: MockLedgerEntry = { _userId: userId, id: uid('led'), kind, amountFen,
    frozenDeltaFen: extra.frozenDeltaFen ?? 0,
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
    if (user.status === 'deactivated') throw fail(400, 'VALIDATION_FAILED', '该账号已注销，不能调整余额');
    if (!Number.isSafeInteger(body.amountFen) || body.amountFen === 0) {
      throw fail(400, 'VALIDATION_FAILED', '调整金额必须是非 0 的整数（分）');
    }
    if (!body.reason?.trim()) throw fail(400, 'VALIDATION_FAILED', '请填写调整原因');
    const idemKey = `admin:adjust:${body.idempotencyKey}`; // 服务端同口径：加前缀再进幂等表
    const first = state.idem.get(idemKey);
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
    state.idem.set(idemKey, JSON.stringify({ amountFen: body.amountFen, result }));
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
      if (user._stats.activeProjects > 0 || user.frozenFen > 0) {
        throw fail(409, 'USER_HAS_ACTIVE_PROJECTS', '该用户还有进行中的作品或待核对的费用，暂不能注销');
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
    const idemKey = `admin:refund:${body.idempotencyKey}`; // 服务端同口径：加前缀再进幂等表
    const first = state.idem.get(idemKey);
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
    state.idem.set(idemKey, JSON.stringify({ amountFen: body.amountFen, result }));
    return result;
  },

  // ───────────── §8.3 作品与失败/待核对处理（M3-ADM-03 演示数据） ─────────────

  async projects(query = {}) {
    await wait(120); requireLogin();
    let list = [...state.projects].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    if (query.status) list = list.filter((p) => p.status === query.status);
    if (query.userId) list = list.filter((p) => p.userId === query.userId);
    if (query.hasUnknown) list = list.filter((p) => projectUnknownTakes(p).length > 0);
    const limit = query.limit ?? 20;
    const offset = decodeCursor(query.cursor);
    const page = list.slice(offset, offset + limit);
    const next = offset + limit;
    return { items: page.map((p) => clone(projectListItem(p))), nextCursor: next < list.length ? encodeCursor(next) : null };
  },

  async project(id) {
    await wait(120); requireLogin();
    const found = state.projects.find((p) => p.id === id);
    if (!found) throw fail(404, 'PROJECT_NOT_FOUND', '作品不存在');
    return clone(projectDetail(found));
  },

  async resolveTake(takeId, body) {
    await wait(); requireLogin();
    if (body.outcome !== 'not_charged' && body.outcome !== 'charged') {
      throw fail(400, 'VALIDATION_FAILED', '判定结论取值不正确');
    }
    if (!body.note?.trim()) throw fail(400, 'VALIDATION_FAILED', '请填写判定说明');
    const project = state.projects.find((p) => p.segments.some((seg) => seg.takes.some((tk) => tk.id === takeId)));
    if (!project) throw fail(404, 'NOT_FOUND', '片段不存在');
    const segment = project.segments.find((seg) => seg.takes.some((tk) => tk.id === takeId))!;
    const take = segment.takes.find((tk) => tk.id === takeId)!;
    const resolvedKey = `admin:resolve:${body.idempotencyKey}`;
    if (take.resolvedOutcome) {
      if (take.resolvedKey !== resolvedKey) throw fail(409, 'TAKE_ALREADY_RESOLVED', '该片段已核对过，不能重复判定');
      if (take.resolvedOutcome !== body.outcome) throw fail(409, 'IDEMPOTENCY_CONFLICT', '请求重复，请刷新后重试');
      return clone(projectDetail(project)); // 同键同结论重放：返回首次结果
    }
    if (take.status !== 'unknown') throw fail(409, 'TAKE_NOT_UNKNOWN', '该片段不是待核对状态，无法判定');
    // 2026-11-05 新规则：两种结论对用户资金处理相同（不向用户结算，已扣费由平台承担）。
    // 可重试作品保持冻结（重试复用）；redelivery / 已取消过期当场退回。
    const refundNow = take.redelivery === true || project.status === 'canceled' || project.status === 'expired';
    if (refundNow) {
      const user = state.users.find((u) => u.id === project.userId);
      if (user && take.frozenFen > 0) { user.frozenFen -= take.frozenFen; user.balanceFen += take.frozenFen; }
      newLedger(project.userId, 'refund', take.frozenFen, '待核对退回',
        { refType: 'project', refId: project.id, reason: body.note, adminUsername: state.adminName ?? 'admin',
          frozenDeltaFen: -take.frozenFen });
      project.money.frozenFen -= take.frozenFen;
      project.money.refundedFen += take.frozenFen;
    }
    take.status = 'failed';
    take.resolvedOutcome = body.outcome as ResolveOutcome;
    take.resolvedNote = body.note;
    take.resolvedKey = resolvedKey;
    take.resolvedAt = now();
    project.events.unshift({ id: (project.events[0]?.id ?? 0) + 1, status: project.status,
      progress: { ...(project.progress ?? {}), message: '已核对：该片段生成失败，费用未扣除' },
      createdAt: now() });
    project.updatedAt = now();
    return clone(projectDetail(project));
  },

  async cancelProject(id, reason) {
    await wait(); requireLogin();
    if (!reason?.trim()) throw fail(400, 'VALIDATION_FAILED', '请填写取消原因');
    const project = state.projects.find((p) => p.id === id);
    if (!project) throw fail(404, 'PROJECT_NOT_FOUND', '作品不存在');
    const cancellable = ['understanding', 'story_review', 'casting', 'cast_review', 'rendering', 'composing', 'paused', 'failed'];
    if (!cancellable.includes(project.status)) throw fail(409, 'PROJECT_STATE_INVALID', '作品当前状态不能进行这个操作，请刷新后重试');
    const unknownFrozen = projectUnknownTakes(project).reduce((sum, tk) => sum + tk.frozenFen, 0);
    const refundable = Math.max(0, project.money.frozenFen - unknownFrozen); // unknown 保持冻结待判定
    if (refundable > 0) {
      const user = state.users.find((u) => u.id === project.userId);
      if (user) { user.frozenFen -= refundable; user.balanceFen += refundable; }
      newLedger(project.userId, 'refund', refundable, '作品取消退回',
        { refType: 'project', refId: project.id, adminUsername: state.adminName ?? 'admin', frozenDeltaFen: -refundable });
      project.money.frozenFen -= refundable;
      project.money.refundedFen += refundable;
    }
    project.status = 'canceled';
    project.progress = { percent: 0, message: '已取消' };
    project.events.unshift({ id: (project.events[0]?.id ?? 0) + 1, status: 'canceled', progress: { percent: 0, message: '已取消' }, createdAt: now() });
    project.updatedAt = now();
    return clone(projectDetail(project));
  },

  // ── §8.4 价格与配置 ──

  async skus() {
    await wait(); requireLogin();
    const items = [...new Set(state.skus.map((row) => row.skuCode))]
      .map((code) => currentSkuView(code))
      .filter((row): row is AdminSku => row !== null);
    return { items: clone(items) };
  },

  async createSkuVersion(skuCode, body) {
    await wait(); requireLogin();
    const rows = state.skus.filter((row) => row.skuCode === skuCode);
    if (!rows.length) throw fail(404, 'NOT_FOUND', 'SKU 不存在');
    if (!Number.isInteger(body.priceFen) || body.priceFen < 0) throw fail(400, 'VALIDATION_FAILED', '填写的内容有误，请检查后重试');
    const latest = [...rows].sort((a, b) => b.version - a.version)[0];
    if (latest.kind === 'llm' && body.priceFen !== 0) throw fail(400, 'VALIDATION_FAILED', 'LLM 的用户价固定为 0（平台承担），不能设置价格');
    if (state.skuIdem.has(body.idempotencyKey)) {
      const version = state.skuIdem.get(body.idempotencyKey)!;
      const row = rows.find((item) => item.version === version);
      const same = row && row.priceFen === body.priceFen
        && (body.costFen === undefined || row.costFen === body.costFen)
        && (body.effectiveAt === undefined || row.effectiveAt === body.effectiveAt);
      if (!same) throw fail(409, 'IDEMPOTENCY_CONFLICT', '请求重复，请刷新后重试');
      return clone(row!);
    }
    const immediate = body.effectiveAt === undefined || new Date(body.effectiveAt).getTime() <= Date.now();
    const row: MockSku = {
      ...latest, version: latest.version + 1, priceFen: body.priceFen,
      costFen: body.costFen ?? latest.costFen,
      effectiveAt: body.effectiveAt ?? now(),
      status: 'active',
    };
    state.skus.push(row);
    state.skuIdem.set(body.idempotencyKey, row.version);
    if (immediate) {
      for (const other of state.skus) {
        if (other.skuCode === skuCode && other.version < row.version) other.status = 'inactive';
      }
    }
    pushAudit('sku.version.create', 'sku', skuCode,
      { priceFen: body.priceFen, ...(body.costFen !== undefined ? { costFen: body.costFen } : {}),
        ...(body.effectiveAt ? { effectiveAt: body.effectiveAt } : {}), newVersion: row.version });
    return clone(row);
  },

  async tiers() {
    await wait(); requireLogin();
    return { items: state.tiers.map(tierView).sort((a, b) => a.sort - b.sort) };
  },

  async updateTier(id, body) {
    await wait(); requireLogin();
    const tier = state.tiers.find((row) => row.id === id);
    if (!tier) throw fail(404, 'NOT_FOUND', '档位不存在');
    if (body.name !== undefined) tier.name = body.name;
    if (body.note !== undefined) tier.note = body.note;
    if (body.sort !== undefined) tier.sort = body.sort;
    if (body.status !== undefined) tier.status = body.status;
    pushAudit('tier.update', 'quality_tier', id, { ...body });
    return clone(tierView(tier));
  },

  async createTierMapping(id, videoSkuCode) {
    await wait(); requireLogin();
    const tier = state.tiers.find((row) => row.id === id);
    if (!tier) throw fail(404, 'NOT_FOUND', '档位不存在');
    if (!currentSkuView(videoSkuCode)) throw fail(400, 'VALIDATION_FAILED', '该 SKU 暂无生效价格，不能设为档位映射');
    const version = Math.max(0, ...tier.mappings.map((row) => row.version)) + 1;
    const mapping = { id: uid('tm'), version, videoSkuCode, effectiveAt: now() };
    tier.mappings.push(mapping);
    pushAudit('tier.mapping.create', 'tier_mapping', mapping.id, { videoSkuCode, version });
    return clone({ ...mapping, priceFen: currentSkuView(videoSkuCode)?.priceFen ?? null });
  },

  async styles() {
    await wait(); requireLogin();
    return { items: clone(state.styles.map((row) => ({ ...row })).sort((a, b) => a.sort - b.sort)) };
  },

  async createStyle(body) {
    await wait(); requireLogin();
    if (!body.name?.trim()) throw fail(400, 'VALIDATION_FAILED', '填写的内容有误，请检查后重试');
    if (body.coverUploadId) requireUpload(body.coverUploadId, ['image']);
    const style: MockStyle = {
      id: uid('style'), name: body.name.trim(), description: body.description ?? '',
      coverUploadId: body.coverUploadId ?? null, promptHint: body.promptHint ?? '',
      sort: body.sort ?? 0, status: 'active',
    };
    state.styles.push(style);
    if (body.coverUploadId) {
      const upload = state.uploads.get(body.coverUploadId);
      if (upload) upload.referenced = true;
    }
    pushAudit('style.create', 'style', style.id, { name: style.name });
    return { id: style.id };
  },

  async updateStyle(id, body) {
    await wait(); requireLogin();
    const style = state.styles.find((row) => row.id === id);
    if (!style) throw fail(404, 'NOT_FOUND', '风格不存在');
    if (body.coverUploadId !== undefined) {
      if (body.coverUploadId === null) style.coverUploadId = null;
      else {
        requireUpload(body.coverUploadId, ['image']);
        style.coverUploadId = body.coverUploadId;
        const upload = state.uploads.get(body.coverUploadId);
        if (upload) upload.referenced = true;
      }
    }
    if (body.name !== undefined) style.name = body.name;
    if (body.description !== undefined) style.description = body.description;
    if (body.promptHint !== undefined) style.promptHint = body.promptHint;
    if (body.sort !== undefined) style.sort = body.sort;
    if (body.status !== undefined) style.status = body.status;
    pushAudit('style.update', 'style', id, { ...body, coverUploadId: undefined });
    return { ok: true };
  },

  async voices() {
    await wait(); requireLogin();
    return { items: clone(state.voices.map((row) => ({ ...row })).sort((a, b) => a.sort - b.sort)) };
  },

  async createVoice(body) {
    await wait(); requireLogin();
    if (!body.name?.trim() || !body.category || !body.gender || !body.ageGroup) {
      throw fail(400, 'VALIDATION_FAILED', '填写的内容有误，请检查后重试');
    }
    if (body.sampleUploadId) requireUpload(body.sampleUploadId, ['audio']);
    if (body.refAudioUploadId) requireUpload(body.refAudioUploadId, ['audio']);
    const voice: MockVoice = {
      id: uid('vc'), name: body.name.trim(), category: body.category, gender: body.gender,
      ageGroup: body.ageGroup, description: body.description ?? '',
      sampleUploadId: body.sampleUploadId ?? null, refAudioUploadId: body.refAudioUploadId ?? null,
      sort: body.sort ?? 0, status: 'active',
    };
    state.voices.push(voice);
    pushAudit('voice.create', 'voice', voice.id, { name: voice.name });
    return { id: voice.id };
  },

  async updateVoice(id, body) {
    await wait(); requireLogin();
    const voice = state.voices.find((row) => row.id === id);
    if (!voice) throw fail(404, 'NOT_FOUND', '音色不存在');
    if (body.sampleUploadId !== undefined) {
      if (body.sampleUploadId === null) voice.sampleUploadId = null;
      else { requireUpload(body.sampleUploadId, ['audio']); voice.sampleUploadId = body.sampleUploadId; }
    }
    if (body.refAudioUploadId !== undefined) {
      if (body.refAudioUploadId === null) voice.refAudioUploadId = null;
      else { requireUpload(body.refAudioUploadId, ['audio']); voice.refAudioUploadId = body.refAudioUploadId; }
    }
    if (body.name !== undefined) voice.name = body.name;
    if (body.category !== undefined) voice.category = body.category;
    if (body.gender !== undefined) voice.gender = body.gender;
    if (body.ageGroup !== undefined) voice.ageGroup = body.ageGroup;
    if (body.description !== undefined) voice.description = body.description;
    if (body.sort !== undefined) voice.sort = body.sort;
    if (body.status !== undefined) voice.status = body.status;
    pushAudit('voice.update', 'voice', id, { ...body });
    return { ok: true };
  },

  async settings() {
    await wait(); requireLogin();
    const items = [...state.settingsMeta.values()].map((meta) => ({ ...meta, value: state.settings.get(meta.key) ?? null }));
    return { items };
  },

  async updateSettings(changes) {
    await wait(); requireLogin();
    const entries = Object.entries(changes ?? {});
    if (!entries.length) throw fail(400, 'VALIDATION_FAILED', '至少要修改一项');
    const changes2: Record<string, number> = {};
    for (const [key, value] of entries) {
      const meta = state.settingsMeta.get(key);
      if (!meta) throw fail(400, 'SETTING_KEY_NOT_ALLOWED', '该配置项不允许修改');
      if (!Number.isInteger(value) || value < meta.min || value > meta.max) {
        throw fail(400, 'VALIDATION_FAILED', `「${meta.label}」需为 ${meta.min}~${meta.max} 的整数`);
      }
      changes2[key] = value;
    }
    if ((changes2.min_story_chars ?? state.settings.get('min_story_chars')!)
      > (changes2.max_story_chars ?? state.settings.get('max_story_chars')!)) {
      throw fail(400, 'VALIDATION_FAILED', '故事最短字数不能大于最长字数');
    }
    for (const [key, value] of Object.entries(changes2)) {
      pushAudit('settings.update', 'setting', key, { from: state.settings.get(key) ?? null, to: value });
      state.settings.set(key, value);
    }
    const items = [...state.settingsMeta.values()].map((meta) => ({ ...meta, value: state.settings.get(meta.key) ?? null }));
    return { items };
  },

  async upload(file) {
    await wait(); requireLogin();
    if (file.size > 5 * 1024 * 1024) throw fail(400, 'UPLOAD_TOO_LARGE', '文件太大了');
    const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
    const kind: 'image' | 'audio' | null =
      ['png', 'jpg', 'jpeg', 'webp'].includes(ext) ? 'image'
        : ['mp3', 'wav', 'm4a'].includes(ext) ? 'audio' : null;
    if (!kind) throw fail(400, 'UPLOAD_TYPE_INVALID', '只支持图片（jpg/png/webp）或音频（mp3/wav/m4a）');
    const uploadId = uid('upl');
    state.uploads.set(uploadId, { kind, referenced: false });
    pushAudit('upload.create', 'upload', uploadId, { kind, sizeBytes: file.size });
    return { uploadId };
  },

  // ── §8.5 审计（只读） ──

  async audit(query = {}) {
    await wait(); requireLogin();
    const limit = query.limit ?? 20;
    let items = [...state.audit];
    if (query.adminId) items = items.filter((row) => row.adminUsername === query.adminId);
    if (query.action) items = items.filter((row) => row.action.startsWith(query.action!));
    if (query.targetType) items = items.filter((row) => row.targetType === query.targetType);
    if (query.targetId) items = items.filter((row) => row.targetId === query.targetId);
    if (query.from) items = items.filter((row) => row.createdAt >= new Date(`${query.from}T00:00:00Z`).toISOString());
    if (query.to) items = items.filter((row) => row.createdAt < new Date(`${query.to}T00:00:00Z`).toISOString());
    const offset = decodeCursor(query.cursor);
    const page = items.slice(offset, offset + limit);
    return {
      items: clone(page),
      nextCursor: offset + limit < items.length ? encodeCursor(offset + limit) : null,
    };
  },
};

// ── §8.3 派生工具 ──

function projectUnknownTakes(project: MockProject): MockTake[] {
  return project.segments.flatMap((seg) => seg.takes).filter((tk) => tk.status === 'unknown' && !tk.resolvedOutcome);
}

function projectListItem(project: MockProject): AdminProject {
  const user = state.users.find((u) => u.id === project.userId);
  return {
    id: project.id, userId: project.userId, phoneMasked: user?.phoneMasked ?? '—',
    title: project.title, status: project.status, progress: { ...project.progress },
    unknownTakes: projectUnknownTakes(project).length,
    createdAt: project.createdAt, updatedAt: project.updatedAt,
  };
}

function projectDetail(project: MockProject): AdminProjectDetail {
  return {
    ...projectListItem(project),
    money: { ...project.money },
    segments: project.segments.map((seg) => ({
      id: seg.id, index: seg.index, durationSeconds: seg.durationSeconds, plot: seg.plot,
      selectedTakeId: seg.selectedTakeId,
      takes: seg.takes.map((tk) => ({
        id: tk.id, status: tk.status, genTaskStatus: tk.genTaskStatus, channel: tk.channel,
        upstreamTaskId: tk.upstreamTaskId,
        frozenFen: tk.status === 'unknown' && !tk.resolvedOutcome ? tk.frozenFen : 0,
        error: tk.error ?? null,
        ...(tk.resolvedOutcome ? { resolvedOutcome: tk.resolvedOutcome, resolvedNote: tk.resolvedNote, resolvedAt: tk.resolvedAt } : {}),
        createdAt: tk.createdAt,
      })),
    })),
    events: clone(project.events),
  };
}
