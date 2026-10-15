// 内存 mock：让前端在没有后端时完整走通一键 / 精修两种流程。
// 进度按时间推进：每次读取项目时根据阶段停留时长前进，不依赖定时器。
// 状态保存到 localStorage（失败时只在内存），刷新后仍可继续演示。
import { MivApiError } from '../http';
import type {
  Asset, AssetVersion, Catalog, ConfirmStage, CreateProjectRequest, LedgerEntry, MivApi, Plan,
  ProjectDetail, ProjectStatus, Quote, QuoteRequest, Render, Session, Shot, ShotTake, Wallet,
} from '../types';
import { placeholderImage } from './placeholder';

interface MockProject extends ProjectDetail { stageEnteredAt: number }
interface MockState {
  session: Session | null;
  wallet: Wallet;
  ledger: LedgerEntry[];
  projects: MockProject[];
  quotes: Record<string, Quote & { request: QuoteRequest }>;
  readyAt: Record<string, number>; // 资产版本 / take 的完成时间
}

const STORAGE_KEY = 'miv-mock-v1';
const STAGE_MS: Partial<Record<ProjectStatus, number>> = {
  planning: 3000, assets_generating: 4000, storyboarding: 2500, shots_generating: 6000, composing: 3000,
};
const FLOW: ProjectStatus[] = [
  'planning', 'plan_review', 'assets_generating', 'asset_review', 'storyboarding',
  'shot_review', 'shots_generating', 'composing', 'delivered',
];
const STAGE_PERCENT: Record<string, [number, number, string]> = {
  planning: [0, 15, 'AI 正在阅读剧本、撰写方案'],
  plan_review: [15, 15, '剧本已就绪，等你确认'],
  assets_generating: [15, 35, '正在生成角色和场景'],
  asset_review: [35, 35, '角色和场景已就绪，等你确认'],
  storyboarding: [35, 45, '正在设计分镜'],
  shot_review: [45, 45, '分镜已就绪，等你确认'],
  shots_generating: [45, 85, '正在逐镜生成视频'],
  composing: [85, 99, '正在拼接成片'],
  delivered: [100, 100, '成片已完成'],
};
const RETAKE_MS = 3500;
const now = () => Date.now();
const iso = (ms = now()) => new Date(ms).toISOString();
const id = (prefix: string) => `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
const wait = (ms = 250) => new Promise((resolve) => setTimeout(resolve, ms));
const fail = (status: number, code: string, message: string): never => { throw new MivApiError(status, { code, message }); };

function load(): MockState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as MockState;
  } catch { /* 隐私模式等情况：退回内存 */ }
  return {
    session: null,
    wallet: { availableFen: 5000, frozenFen: 0 },
    ledger: [{ id: id('led'), kind: 'recharge', amountFen: 5000, title: '新用户体验金（演示）', createdAt: iso() }],
    projects: [],
    quotes: {},
    readyAt: {},
  };
}
const state = load();
function save() { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* ignore */ } }

function requireLogin(): Session { return state.session || fail(401, 'UNAUTHENTICATED', '请先登录'); }
function findProject(projectId: string): MockProject {
  return state.projects.find((p) => p.id === projectId) || fail(404, 'NOT_FOUND', '作品不存在');
}
function addLedger(kind: LedgerEntry['kind'], amountFen: number, title: string) {
  state.ledger.unshift({ id: id('led'), kind, amountFen, title, createdAt: iso() });
}
function price(request: QuoteRequest): Quote['breakdown'] {
  if (request.kind === 'project') {
    const seconds = request.options.durationSeconds;
    return [
      { label: '角色与场景生成', amountFen: 200 },
      { label: `视频生成（${seconds} 秒）`, amountFen: seconds * 40 },
      { label: '成片合成', amountFen: 0 },
    ];
  }
  if (request.kind === 'asset_version') return [{ label: '重新生成一张图', amountFen: 20 }];
  const shot = findProject(request.projectId).shots.find((s) => s.id === request.shotId);
  const seconds = shot?.durationSeconds || 10;
  return [{ label: `重拍镜头（${seconds} 秒）`, amountFen: seconds * 40 }];
}
function consumeQuote(quoteId: string): Quote {
  const quote = state.quotes[quoteId] || fail(400, 'QUOTE_EXPIRED', '报价已失效，请重新获取');
  if (Date.parse(quote.expiresAt) < now()) fail(400, 'QUOTE_EXPIRED', '报价已失效，请重新获取');
  if (state.wallet.availableFen < quote.amountFen) fail(402, 'INSUFFICIENT_BALANCE', '余额不足，请先充值');
  delete state.quotes[quoteId];
  state.wallet.availableFen -= quote.amountFen;
  state.wallet.frozenFen += quote.amountFen;
  addLedger('reserve', -quote.amountFen, '制作预占');
  return quote;
}
function settle(project: MockProject, amountFen: number, title: string) {
  state.wallet.frozenFen -= amountFen;
  project.billing.frozenFen -= amountFen;
  project.billing.settledFen += amountFen;
  addLedger('settle', 0, `${title}（结算 ${(amountFen / 100).toFixed(2)} 元）`);
}

// ---------- 阶段产物 ----------
function buildPlan(project: MockProject): Plan {
  const lines = project.sourceText.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const title = project.title || lines[0]?.slice(0, 16) || '未命名短片';
  return {
    version: 1,
    title,
    logline: lines[0]?.slice(0, 40) || '一个关于选择与成长的小故事',
    synopsis: lines.slice(0, 3).join(' ').slice(0, 160) || '故事梗概将由 AI 根据剧本生成。',
    scenes: [
      { id: id('scn'), title: '开场', location: '城市街角', description: '主角登场，交代处境。', dialogue: [{ speaker: '小林', line: '今天一定要把话说出口。' }] },
      { id: id('scn'), title: '转折', location: '咖啡馆', description: '意外的相遇让事情出现转机。', dialogue: [{ speaker: '阿青', line: '你怎么在这儿？' }, { speaker: '小林', line: '我在等你。' }] },
    ],
  };
}
function buildAssets(): Asset[] {
  const make = (kind: Asset['kind'], name: string, description: string, hue: number): Asset => {
    const version: AssetVersion = { id: id('asv'), source: 'generated', status: 'succeeded', imageUrl: placeholderImage(name, hue), createdAt: iso() };
    return { id: id('ast'), kind, name, description, locked: false, selectedVersionId: version.id, versions: [version] };
  };
  return [
    make('character', '小林', '25 岁男生，短发，白衬衫，温和内向', 170),
    make('character', '阿青', '24 岁女生，齐肩发，米色风衣，开朗', 20),
    make('scene', '咖啡馆', '午后阳光，木质桌椅，落地窗', 200),
  ];
}
function buildShots(project: MockProject): Shot[] {
  const count = project.options.durationSeconds <= 30 ? 1 : 2;
  const each = Math.round(project.options.durationSeconds / count);
  return Array.from({ length: count }, (_, i) => ({
    id: id('shot'), index: i + 1, durationSeconds: each,
    description: i === 0 ? '街角中景，小林握着手机犹豫，镜头缓慢推近。' : '咖啡馆内，两人对视，镜头环绕。',
    voiceover: i === 0 ? '小林：今天一定要把话说出口。' : '阿青：你怎么在这儿？ 小林：我在等你。',
    assetRefs: project.assets.map((a) => a.id),
    firstFrameUrl: placeholderImage(`镜头 ${i + 1}`, 180 + i * 40, project.options.ratio),
    takes: [],
  }));
}
function addTake(project: MockProject, shot: Shot, readyAt: number): ShotTake {
  const take: ShotTake = { id: id('take'), source: 'generated', status: 'running', createdAt: iso() };
  shot.takes.unshift(take);
  state.readyAt[take.id] = readyAt;
  if (!shot.selectedTakeId) shot.selectedTakeId = take.id;
  void project;
  return take;
}
function finishTakes(project: MockProject) {
  for (const shot of project.shots) for (const take of shot.takes) {
    if (take.status === 'running' && (state.readyAt[take.id] || 0) <= now()) {
      take.status = 'succeeded';
      take.posterUrl = placeholderImage(`镜头 ${shot.index} · 第 ${shot.takes.length - shot.takes.indexOf(take)} 版`, 160 + shot.index * 30, project.options.ratio);
    }
  }
  for (const asset of project.assets) for (const version of asset.versions) {
    if (version.status === 'running' && (state.readyAt[version.id] || 0) <= now()) {
      version.status = 'succeeded';
      version.imageUrl = placeholderImage(`${asset.name} · 新版本`, (asset.name.charCodeAt(0) * 7) % 360);
    }
  }
}

function enter(project: MockProject, status: ProjectStatus, at = now()) {
  project.status = status;
  project.stageEnteredAt = at;
  project.updatedAt = iso(at);
  if (status === 'assets_generating') project.plan ||= buildPlan(project);
  if (status === 'asset_review' || status === 'storyboarding') project.assets = project.assets.length ? project.assets : buildAssets();
  if (status === 'storyboarding') project.assets.forEach((a) => { a.locked = true; });
  if (status === 'shot_review' || status === 'shots_generating') project.shots = project.shots.length ? project.shots : buildShots(project);
  if (status === 'shots_generating') {
    const ready = at + (STAGE_MS.shots_generating || 0);
    project.shots.forEach((shot) => { if (!shot.takes.length) addTake(project, shot, ready); });
  }
  if (status === 'delivered') {
    const render: Render = {
      id: id('rnd'), status: 'succeeded', options: { subtitles: true }, createdAt: iso(at),
      coverUrl: placeholderImage(project.plan?.title || '成片', 175, project.options.ratio),
      durationSeconds: project.shots.reduce((sum, s) => sum + s.durationSeconds, 0),
    };
    project.renders.unshift(render);
    project.coverUrl = render.coverUrl;
    project.durationSeconds = render.durationSeconds;
    settle(project, project.billing.frozenFen, `《${project.plan?.title || project.title}》制作完成`);
  }
}
function advance(project: MockProject) {
  finishTakes(project);
  for (let guard = 0; guard < FLOW.length; guard++) {
    const status = project.status;
    const index = FLOW.indexOf(status);
    if (index < 0 || status === 'delivered') break;
    if (status.endsWith('_review')) {
      if (project.mode !== 'auto') break;
      if (status === 'plan_review') project.plan ||= buildPlan(project);
      enter(project, FLOW[index + 1], project.stageEnteredAt);
      continue;
    }
    const duration = STAGE_MS[status] || 0;
    if (now() - project.stageEnteredAt < duration) break;
    if (status === 'planning') project.plan = buildPlan(project);
    if (status === 'assets_generating') project.assets = buildAssets();
    if (status === 'storyboarding') project.shots = project.shots.length ? project.shots : buildShots(project);
    finishTakes(project);
    enter(project, FLOW[index + 1], project.stageEnteredAt + duration);
  }
  const [from, to, message] = STAGE_PERCENT[project.status] || [project.progress.percent, project.progress.percent, project.progress.message];
  const duration = STAGE_MS[project.status];
  const ratio = duration ? Math.min(1, (now() - project.stageEnteredAt) / duration) : 1;
  project.progress = { percent: Math.round(from + (to - from) * ratio), message };
}

function publicProject(project: MockProject): ProjectDetail {
  const { stageEnteredAt: _ignored, ...detail } = project;
  return structuredClone(detail);
}

export const mockApi: MivApi = {
  async me() { await wait(100); return requireLogin(); },
  async sendSms(phone) {
    await wait();
    if (!/^1\d{10}$/.test(phone)) fail(400, 'PHONE_INVALID', '请输入正确的手机号');
    return { cooldownSeconds: 60 };
  },
  async login(phone, code) {
    await wait();
    if (!/^\d{6}$/.test(code)) fail(400, 'SMS_CODE_INVALID', '验证码不正确（演示环境输入任意 6 位数字）');
    state.session = {
      user: { id: id('usr'), phoneMasked: `${phone.slice(0, 3)}****${phone.slice(-4)}`, nickname: `用户${phone.slice(-4)}` },
      csrfToken: 'mock',
    };
    save();
    return state.session;
  },
  async logout() { state.session = null; save(); },
  async catalog(): Promise<Catalog> {
    return {
      ratios: ['9:16', '16:9', '1:1'],
      durations: [30, 40, 50],
      styles: [
        { id: 'realistic', name: '写实电影', coverUrl: placeholderImage('写实电影', 200) },
        { id: 'anime', name: '日系动漫', coverUrl: placeholderImage('日系动漫', 320) },
        { id: 'guofeng', name: '国风水墨', coverUrl: placeholderImage('国风水墨', 150) },
        { id: 'pixar', name: '3D 动画', coverUrl: placeholderImage('3D 动画', 30) },
      ],
      qualities: [{ id: 'standard', name: '标准', note: '720p' }, { id: 'hd', name: '高清', note: '1080p' }],
      limits: { minScriptChars: 50, maxScriptChars: 2000 },
    };
  },
  async wallet() { requireLogin(); return { ...state.wallet }; },
  async ledger() { requireLogin(); return { items: structuredClone(state.ledger), nextCursor: null }; },
  async redeem(code) {
    requireLogin(); await wait();
    if (code.trim().toUpperCase() !== 'DEMO100') fail(400, 'REDEEM_INVALID', '兑换码无效（演示环境可用 DEMO100）');
    state.wallet.availableFen += 10000;
    addLedger('redeem', 10000, '兑换码充值');
    save();
    return { amountFen: 10000, wallet: { ...state.wallet } };
  },
  async quote(request) {
    requireLogin(); await wait(150);
    const breakdown = price(request);
    const quote: Quote = { quoteId: id('quo'), amountFen: breakdown.reduce((s, b) => s + b.amountFen, 0), breakdown, expiresAt: iso(now() + 10 * 60_000) };
    state.quotes[quote.quoteId] = { ...quote, request };
    save();
    return quote;
  },
  async uploadScript(file) {
    requireLogin();
    const text = await file.text();
    return { title: file.name.replace(/\.[^.]+$/, ''), text: text.slice(0, 2000) };
  },
  async listProjects() {
    requireLogin(); await wait(150);
    state.projects.forEach(advance); save();
    return {
      items: state.projects.map(({ id: pid, title, status, coverUrl, durationSeconds, createdAt, updatedAt }) =>
        ({ id: pid, title, status, coverUrl, durationSeconds, createdAt, updatedAt })),
      nextCursor: null,
    };
  },
  async createProject(request: CreateProjectRequest) {
    requireLogin(); await wait();
    const quote = consumeQuote(request.quoteId);
    const at = now();
    const project: MockProject = {
      id: id('prj'), title: request.title || request.sourceText.trim().split('\n')[0].slice(0, 16) || '未命名短片',
      status: 'planning', createdAt: iso(at), updatedAt: iso(at), stageEnteredAt: at,
      mode: request.mode, options: request.options, sourceText: request.sourceText,
      progress: { percent: 0, message: STAGE_PERCENT.planning[2] },
      billing: { quotedFen: quote.amountFen, frozenFen: quote.amountFen, settledFen: 0 },
      assets: [], shots: [], renders: [],
    };
    state.projects.unshift(project);
    save();
    return publicProject(project);
  },
  async getProject(projectId) {
    requireLogin(); await wait(80);
    const project = findProject(projectId); advance(project); save();
    return publicProject(project);
  },
  async confirm(projectId, stage: ConfirmStage) {
    requireLogin(); await wait();
    const project = findProject(projectId); advance(project);
    const expected: Record<ConfirmStage, ProjectStatus> = { plan: 'plan_review', assets: 'asset_review', shots: 'shot_review' };
    if (project.status !== expected[stage]) fail(409, 'PROJECT_STATE_INVALID', '当前步骤已变化，请刷新');
    enter(project, FLOW[FLOW.indexOf(project.status) + 1]);
    advance(project); save();
    return publicProject(project);
  },
  async pause(projectId) {
    requireLogin();
    const project = findProject(projectId); advance(project);
    if (['delivered', 'failed', 'canceled', 'paused'].includes(project.status)) fail(409, 'PROJECT_STATE_INVALID', '当前状态不能暂停');
    project.pausedFrom = project.status;
    project.status = 'paused';
    project.progress = { ...project.progress, message: '已暂停，可以修改后继续' };
    save();
    return publicProject(project);
  },
  async resume(projectId) {
    requireLogin();
    const project = findProject(projectId);
    if (project.status !== 'paused' || !project.pausedFrom) fail(409, 'PROJECT_STATE_INVALID', '作品未处于暂停状态');
    const from = project.pausedFrom as ProjectStatus;
    project.pausedFrom = undefined;
    // 暂停后恢复：一键模式也在当前确认点停一下，方便修改。
    enter(project, from);
    advance(project); save();
    return publicProject(project);
  },
  async retry(projectId) { return mockApi.resume(projectId); },
  async cancel(projectId) {
    requireLogin();
    const project = findProject(projectId);
    if (project.billing.frozenFen > 0) {
      state.wallet.frozenFen -= project.billing.frozenFen;
      state.wallet.availableFen += project.billing.frozenFen;
      addLedger('refund', project.billing.frozenFen, '取消制作，退回预占');
      project.billing.frozenFen = 0;
    }
    project.status = 'canceled';
    save();
    return publicProject(project);
  },
  async updatePlan(projectId, patch) {
    requireLogin();
    const project = findProject(projectId);
    if (project.status !== 'plan_review' && project.status !== 'paused') fail(409, 'PROJECT_STATE_INVALID', '当前步骤不能修改剧本');
    project.plan = { ...(project.plan || buildPlan(project)), ...patch, version: (project.plan?.version || 1) + 1 };
    save();
    return structuredClone(project.plan);
  },
  async regeneratePlan(projectId) {
    requireLogin();
    const project = findProject(projectId);
    project.plan = undefined;
    enter(project, 'planning');
    save();
    return publicProject(project);
  },
  async generateAssetVersion(projectId, assetId, quoteId) {
    requireLogin(); await wait();
    const project = findProject(projectId);
    const asset = project.assets.find((a) => a.id === assetId) || fail(404, 'NOT_FOUND', '资产不存在');
    const quote = consumeQuote(quoteId);
    project.billing.frozenFen += quote.amountFen;
    const version: AssetVersion = { id: id('asv'), source: 'generated', status: 'running', createdAt: iso() };
    asset.versions.unshift(version);
    state.readyAt[version.id] = now() + RETAKE_MS;
    save();
    return structuredClone(version);
  },
  async selectAssetVersion(projectId, assetId, versionId) {
    requireLogin();
    const asset = findProject(projectId).assets.find((a) => a.id === assetId) || fail(404, 'NOT_FOUND', '资产不存在');
    if (!asset.versions.some((v) => v.id === versionId && v.status === 'succeeded')) fail(409, 'VERSION_NOT_READY', '这个版本还没生成好');
    asset.selectedVersionId = versionId;
    save();
    return structuredClone(asset);
  },
  async updateShot(projectId, shotId, patch) {
    requireLogin();
    const project = findProject(projectId);
    if (project.status !== 'shot_review' && project.status !== 'paused') fail(409, 'PROJECT_STATE_INVALID', '当前步骤不能修改分镜');
    const shot = project.shots.find((s) => s.id === shotId) || fail(404, 'NOT_FOUND', '镜头不存在');
    Object.assign(shot, patch);
    save();
    return structuredClone(shot);
  },
  async generateShotTake(projectId, shotId, quoteId) {
    requireLogin(); await wait();
    const project = findProject(projectId);
    const shot = project.shots.find((s) => s.id === shotId) || fail(404, 'NOT_FOUND', '镜头不存在');
    const quote = consumeQuote(quoteId);
    project.billing.frozenFen += quote.amountFen;
    const take = addTake(project, shot, now() + RETAKE_MS);
    save();
    return structuredClone(take);
  },
  async selectShotTake(projectId, shotId, takeId) {
    requireLogin();
    const shot = findProject(projectId).shots.find((s) => s.id === shotId) || fail(404, 'NOT_FOUND', '镜头不存在');
    if (!shot.takes.some((t) => t.id === takeId && t.status === 'succeeded')) fail(409, 'TAKE_NOT_READY', '这一版还没生成好');
    shot.selectedTakeId = takeId;
    save();
    return structuredClone(shot);
  },
  async createRender(projectId, options) {
    requireLogin(); await wait();
    const project = findProject(projectId);
    const render: Render = {
      id: id('rnd'), status: 'succeeded', options, createdAt: iso(),
      coverUrl: placeholderImage(`${project.plan?.title || '成片'} · 新版`, 140, project.options.ratio),
      durationSeconds: project.shots.reduce((sum, s) => sum + s.durationSeconds, 0),
    };
    project.renders.unshift(render);
    save();
    return structuredClone(render);
  },
};
