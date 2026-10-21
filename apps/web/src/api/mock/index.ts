// 内存 mock：没有后端时完整演示 PRD v2.2 流程（docs/API.md v1.0）。
// 进度按时间推进：每次调用接口先 tick()，根据时间戳完成形象、片段和阶段迁移，不依赖定时器。
// 状态保存在 localStorage（失败时只在内存）。新用户登录时自动放入两个数字人和两部示例作品。
import { groupOf } from '@/utils/status';
import { MivApiError } from '../http';
import type {
  AgeGroup, CastMember, Catalog, Character, CharacterDetail, CreateProjectRequest, Gender, LedgerEntry, LookVersion,
  MivApi, ProjectDetail, ProjectStatus, ProjectSummary, Quote, QuoteRequest, Segment, Session, TipKey, Voice, VoiceCategory, Wallet,
} from '../types';
import { placeholderAudio, placeholderImage, shrinkImage } from './placeholder';

// ── 演示参数 ──
const STORAGE_KEY = 'miv-mock-v2';
const LOOK_FEN = 50;                                     // 每个形象（与 001-init.sql 占位 SKU 一致）
const FEN_PER_SECOND: Record<string, number> = { standard: 20, hd: 40 };
const UNDERSTAND_MS = 3500;
const LOOK_MS = 3000;
const TAKE_MS = 3500;
const COMPOSE_MS = 2500;
const RETENTION_DAYS = 90;
const MAX_SECONDS = 90;
const DAILY_FREE = 20;
const DAY = 86_400_000;

const CATALOG: Catalog = {
  styles: [
    { id: 'realistic', name: '真人写实', description: '接近真实拍摄的家庭影像' },
    { id: 'manga_drama', name: '漫剧', description: '国漫或短剧漫画风，适合剧情类' },
    { id: 'cartoon_3d', name: '卡通 3D', description: '类皮克斯 3D 动画，温馨' },
    { id: 'anime', name: '日系动漫', description: '2D 赛璐璐' },
    { id: 'picture_book', name: '绘本水彩', description: '儿童绘本质感' },
    { id: 'clay', name: '黏土 / 定格', description: '趣味风格' },
  ].map((s, i) => ({ ...s, coverUrl: placeholderImage(s.name, 20 + i * 55, '3:4') })),
  qualityTiers: [
    { id: 'standard', name: '标准', note: '清晰流畅', pricePer30sFen: FEN_PER_SECOND.standard * 30 },
    { id: 'hd', name: '高清', note: '画面更细腻', pricePer30sFen: FEN_PER_SECOND.hd * 30 },
  ],
  ratios: ['9:16', '16:9', '1:1'],
  limits: { minStoryChars: 5, maxStoryChars: 3000, maxDurationSeconds: MAX_SECONDS, dailyFreeUnderstanding: DAILY_FREE, retentionDays: RETENTION_DAYS, expiryRemindDays: 7, maxCharacterPhotos: 5 },
};
const CATEGORY_NAMES: Record<VoiceCategory, string> = {
  girl: '少女', boy: '少年', child_f: '儿童女', child_m: '儿童男', young_f: '青年女', young_m: '青年男', middle_f: '中年女', middle_m: '中年男', elder_f: '老人女', elder_m: '老人男',
};
const VOICE_SEED: [string, string, VoiceCategory, string, number][] = [
  ['vc_girl_gentle', '温柔少女', 'girl', '轻柔细腻，适合温馨叙述', 660], ['vc_girl_lively', '元气少女', 'girl', '明亮活泼，充满朝气', 740],
  ['vc_boy_sunny', '阳光少年', 'boy', '开朗爽快', 440], ['vc_boy_calm', '沉稳少年', 'boy', '安静沉着', 392],
  ['vc_childf_sweet', '甜美女童', 'child_f', '奶声奶气，甜甜的', 880], ['vc_childf_lively', '活泼女童', 'child_f', '爱笑爱闹', 988],
  ['vc_childm_naughty', '调皮男童', 'child_m', '机灵调皮', 784], ['vc_childm_good', '乖巧男童', 'child_m', '懂事乖巧', 698],
  ['vc_youngf_smart', '知性女声', 'young_f', '温和知性', 587], ['vc_youngm_warm', '温暖男声', 'young_m', '温暖亲切', 330],
  ['vc_middlef_mom', '慈爱妈妈', 'middle_f', '温柔有耐心', 523], ['vc_middlem_dad', '沉稳爸爸', 'middle_m', '稳重可靠', 294],
  ['vc_elderf_grandma', '和蔼奶奶', 'elder_f', '慈祥和蔼', 494], ['vc_elderm_grandpa', '慈祥爷爷', 'elder_m', '慢悠悠，很亲切', 262],
];
let voiceCache: Voice[] | null = null;
const voices = () => (voiceCache ??= VOICE_SEED.map(([id, name, category, description, freq]) => ({
  id, name, category, categoryName: CATEGORY_NAMES[category], description, sampleUrl: placeholderAudio(freq),
})));
const ROLE_WORDS: { word: string; gender: Gender; age: AgeGroup }[] = [
  { word: '宝宝', gender: 'unknown', age: 'child' }, { word: '妈妈', gender: 'female', age: 'middle' }, { word: '爸爸', gender: 'male', age: 'middle' },
  { word: '奶奶', gender: 'female', age: 'elder' }, { word: '爷爷', gender: 'male', age: 'elder' }, { word: '外婆', gender: 'female', age: 'elder' },
  { word: '外公', gender: 'male', age: 'elder' }, { word: '姐姐', gender: 'female', age: 'teen' }, { word: '哥哥', gender: 'male', age: 'teen' },
  { word: '妹妹', gender: 'female', age: 'child' }, { word: '弟弟', gender: 'male', age: 'child' },
];

// ── 内部状态 ──
interface MockCharacter extends CharacterDetail { deleted?: boolean }
interface MockProject extends ProjectDetail {
  stageAt: number;                      // 进入当前阶段的时间
  pausedAt?: number;
  readyAt: Record<string, number>;      // take id → 完成时间
  rerenderAt?: number;                  // 交付后重新拼接完成时间
  lookTargets?: Record<string, string>; // cast id → 正在生成的形象版本 id
  selectedCharacterIds: string[];       // 首页托盘勾选
  deletedAt?: string;
}
interface MockState {
  session: Session | null;
  knownPhones: string[];
  wallet: Wallet;
  ledger: LedgerEntry[];
  characters: MockCharacter[];
  projects: MockProject[];
  quotes: Record<string, Quote & { request: QuoteRequest }>;
  lookReadyAt: Record<string, number>;  // look version id → 完成时间
  freeUsage: { day: string; count: number };
}

const now = () => Date.now();
const iso = (ms = now()) => new Date(ms).toISOString();
const uid = (prefix: string) => `${prefix}_${Math.random().toString(36).slice(2, 12)}`;
const wait = (ms = 200) => new Promise((resolve) => setTimeout(resolve, ms));
const fail = (status: number, code: string, message: string): never => { throw new MivApiError(status, { code, message }); };
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const today = () => new Date().toISOString().slice(0, 10);
const hueOf = (text: string) => [...text].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 360, 7);
const styleName = (styleId: string) => CATALOG.styles.find((s) => s.id === styleId)?.name || styleId;

function emptyState(): MockState {
  return {
    session: null, knownPhones: [], wallet: { availableFen: 5000, frozenFen: 0 }, ledger: [], characters: [], projects: [],
    quotes: {}, lookReadyAt: {}, freeUsage: { day: today(), count: 0 },
  };
}
function load(): MockState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...emptyState(), ...(JSON.parse(raw) as MockState) };
  } catch { /* 隐私模式等：退回内存 */ }
  return emptyState();
}
const state = load();
const pendingUploads = new Map<string, string>(); // uploadId → 压缩后的 data URL（只在本次会话）
function save() { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* 存储满或被禁用：只保留内存 */ } }

function requireLogin(): Session { return state.session || fail(401, 'UNAUTHENTICATED', '请先登录'); }
function findProject(id: string): MockProject {
  return state.projects.find((p) => p.id === id && !p.deletedAt) || fail(404, 'NOT_FOUND', '作品不存在或已被删除');
}
function findCharacter(id: string): MockCharacter {
  return state.characters.find((c) => c.id === id && !c.deleted) || fail(404, 'NOT_FOUND', '数字人不存在或已被删除');
}
function addLedger(kind: LedgerEntry['kind'], amountFen: number, title: string) {
  state.ledger.unshift({ id: uid('led'), kind, amountFen, title, createdAt: iso() });
}
function charge(amountFen: number, title: string) {
  if (state.wallet.availableFen < amountFen) fail(402, 'INSUFFICIENT_BALANCE', '余额不足，请先充值');
  state.wallet.availableFen -= amountFen;
  addLedger('charge', -amountFen, title);
}
function expectState(p: MockProject, ...allowed: ProjectStatus[]) {
  if (p.status === 'expired') fail(410, 'PROJECT_EXPIRED', '作品已过期，视频已清理');
  if (!allowed.includes(p.status)) fail(409, 'PROJECT_STATE_INVALID', '作品当前状态不能进行这个操作，请刷新后重试');
}
function setStatus(p: MockProject, status: ProjectStatus, message: string, percent: number) {
  p.status = status;
  p.group = groupOf(status);
  p.progress = { percent, message };
  p.stageAt = now();
  p.updatedAt = iso();
}
function consumeQuote(quoteId: string | undefined, kind: QuoteRequest['kind'], refId: string): Quote {
  const quote = (quoteId && state.quotes[quoteId]) || fail(409, 'QUOTE_EXPIRED', '报价已过期，请重新确认');
  const ref = 'projectId' in quote.request ? quote.request.projectId : quote.request.characterId;
  if (quote.kind !== kind || ref !== refId) fail(409, 'QUOTE_MISMATCH', '价格有变化，请重新确认');
  if (Date.parse(quote.expiresAt) < now()) fail(409, 'QUOTE_EXPIRED', '报价已过期，请重新确认');
  delete state.quotes[quoteId!];
  return quote;
}

// ── 数字人 ──
function lookOf(c: MockCharacter, styleId: string) {
  let look = c.looks.find((l) => l.styleId === styleId);
  if (!look) { look = { styleId, versions: [] }; c.looks.push(look); }
  return look;
}
function readyLook(c: MockCharacter | undefined, styleId: string) {
  const look = c?.looks.find((l) => l.styleId === styleId);
  const version = look?.versions.find((v) => v.id === look.selectedVersionId && v.status === 'succeeded');
  return version ? { look: look!, version } : null;
}
function startLook(c: MockCharacter, styleId: string): LookVersion {
  const version: LookVersion = { id: uid('lkv'), status: 'running', createdAt: iso() };
  lookOf(c, styleId).versions.push(version);
  state.lookReadyAt[version.id] = now() + LOOK_MS;
  return version;
}
function refreshCharacter(c: MockCharacter) {
  c.styleIds = c.looks.filter((l) => l.selectedVersionId).map((l) => l.styleId);
  const firstLook = c.looks.find((l) => l.imageUrl);
  c.avatarUrl = firstLook?.imageUrl || c.photos[0]?.url;
  c.worksCount = state.projects.filter((p) => !p.deletedAt && p.cast.some((m) => m.characterId === c.id)).length;
}
function summary(c: MockCharacter): Character {
  refreshCharacter(c);
  const { id, name, tags, avatarUrl, styleIds, worksCount, defaultVoiceId, createdAt } = c;
  return clone({ id, name, tags, avatarUrl, styleIds, worksCount, defaultVoiceId, createdAt });
}

// ── 故事理解（模拟 pi agent）──
function inferRole(name: string) {
  return ROLE_WORDS.find((r) => name.includes(r.word)) || { gender: 'unknown' as Gender, age: 'young' as AgeGroup };
}
function voiceFor(gender: Gender, age: AgeGroup, used: Set<string>): string | undefined {
  const female = gender !== 'male';
  const category: VoiceCategory = age === 'child' ? (female ? 'child_f' : 'child_m') : age === 'teen' ? (female ? 'girl' : 'boy')
    : age === 'elder' ? (female ? 'elder_f' : 'elder_m') : age === 'middle' ? (female ? 'middle_f' : 'middle_m') : (female ? 'young_f' : 'young_m');
  const pick = voices().find((v) => v.category === category && !used.has(v.id)) || voices().find((v) => !used.has(v.id));
  if (pick) used.add(pick.id);
  return pick?.id;
}
function understand(p: MockProject) {
  const text = p.storyText.replace(/\s+/g, '');
  const segmentCount = Math.min(MAX_SECONDS / 30, Math.max(1, Math.ceil(text.length / 120)));
  const compressed = text.length > 360;
  const library = state.characters.filter((c) => !c.deleted);
  const selected = library.filter((c) => p.selectedCharacterIds.includes(c.id));
  const cast: CastMember[] = selected.map((c) => {
    const role = inferRole(c.name);
    return { id: uid('cast'), name: c.name, description: c.description || '', gender: role.gender, ageGroup: role.age, characterId: c.id, matchSource: 'user', look: { status: 'missing', versions: [] } };
  });
  for (const role of ROLE_WORDS) {
    if (!text.includes(role.word) || cast.some((m) => m.name.includes(role.word))) continue;
    const match = library.find((c) => c.name.includes(role.word));
    cast.push({ id: uid('cast'), name: match?.name || role.word, description: match ? '' : `故事中的${role.word}`, gender: role.gender, ageGroup: role.age, characterId: match?.id, matchSource: match ? 'ai' : 'new', look: { status: 'missing', versions: [] } });
  }
  if (!cast.length) cast.push({ id: uid('cast'), name: '主角', description: 'AI 根据故事设定的主角', gender: 'unknown', ageGroup: 'young', matchSource: 'new', look: { status: 'missing', versions: [] } });

  const chunk = Math.ceil(p.storyText.length / segmentCount);
  p.segments = Array.from({ length: segmentCount }, (_, i): Segment => ({
    id: uid('seg'), index: i, durationSeconds: 30,
    plot: p.storyText.slice(i * chunk, (i + 1) * chunk).trim() || p.storyText.slice(0, 60),
    dialogue: [{ castId: cast[i % cast.length].id, line: i === 0 ? '今天天气真好呀！' : '我们再玩一会儿吧～' }],
    transition: i === 0 ? 'hard_cut' : 'prev_tail',
    castIds: cast.map((m) => m.id), takes: [],
  }));
  p.voicesEnabled = segmentCount >= 2;
  p.cast = cast;
  syncCast(p);
  const totalSeconds = segmentCount * 30;
  p.story = {
    synopsis: `${p.storyText.replace(/\s+/g, ' ').slice(0, 80)}${p.storyText.length > 80 ? '…' : ''}（AI 已补全画面细节和情绪）`,
    totalSeconds, segmentCount, compressed,
    notice: compressed ? `故事较长，已为您精简为 ${totalSeconds} 秒` : undefined,
  };
  p.title ||= p.storyText.replace(/\s+/g, '').slice(0, 10);
  p.durationSeconds = totalSeconds;
  priceProject(p);
}
/** 根据资产库刷新角色的形象状态与音色。 */
function syncCast(p: MockProject) {
  const used = new Set(p.cast.map((m) => m.voice?.voiceId).filter((v): v is string => !!v));
  for (const m of p.cast) {
    const c = m.characterId ? state.characters.find((x) => x.id === m.characterId) : undefined;
    const target = p.lookTargets?.[m.id];
    const look = c?.looks.find((l) => l.styleId === p.styleId);
    m.look.versions = clone(look?.versions || []);
    const targetVersion = target ? look?.versions.find((v) => v.id === target) : undefined;
    if (targetVersion && targetVersion.status !== 'succeeded') {
      m.look.status = targetVersion.status === 'failed' ? 'failed' : 'generating';
    } else {
      if (targetVersion) { m.look.versionId = targetVersion.id; delete p.lookTargets![m.id]; }
      const chosen = look?.versions.find((v) => v.id === (m.look.versionId || look.selectedVersionId) && v.status === 'succeeded');
      m.look.status = chosen ? 'ready' : 'missing';
      m.look.versionId = chosen?.id;
      m.look.imageUrl = chosen?.imageUrl;
    }
    if (!p.voicesEnabled) { delete m.voice; continue; }
    if (!m.voice) {
      if (c?.defaultVoiceId && !used.has(c.defaultVoiceId)) { m.voice = { voiceId: c.defaultVoiceId, source: 'default' }; used.add(c.defaultVoiceId); }
      else { const v = voiceFor(m.gender, m.ageGroup, used); if (v) m.voice = { voiceId: v, source: 'ai' }; }
    }
  }
}
function priceProject(p: MockProject) {
  const looksToGenerate = p.status === 'story_review' || p.status === 'understanding' ? p.cast.filter((m) => m.look.status === 'missing').length : p.pricing.looksToGenerate;
  const videoFen = p.segments.reduce((sum, s) => sum + s.durationSeconds * FEN_PER_SECOND[p.qualityTierId], 0);
  const looksFen = looksToGenerate * LOOK_FEN;
  p.pricing = { ...p.pricing, looksToGenerate, looksFen, videoFen, totalFen: looksFen + videoFen };
}

// ── 时间推进 ──
function tick() {
  const t = now();
  for (const c of state.characters) {
    for (const look of c.looks) {
      for (const v of look.versions) {
        if (v.status !== 'running' || (state.lookReadyAt[v.id] ?? Infinity) > t) continue;
        v.status = 'succeeded';
        v.imageUrl = placeholderImage(`${c.name}·${styleName(look.styleId)}`, hueOf(c.name + look.styleId), '1:1');
        look.selectedVersionId = v.id;
        look.imageUrl = v.imageUrl;
        delete state.lookReadyAt[v.id];
      }
    }
  }
  for (const p of state.projects) {
    if (p.deletedAt || p.status === 'paused') continue;
    if (p.status === 'understanding' && t - p.stageAt > UNDERSTAND_MS) {
      setStatus(p, 'story_review', '故事已整理好，等你确认', 20);
      understand(p);
    }
    if (p.status === 'casting') {
      syncCast(p);
      if (p.cast.every((m) => m.look.status === 'ready')) setStatus(p, 'cast_review', '角色形象已就绪，等你确认', 40);
    }
    if (p.status === 'rendering') {
      let done = 0;
      for (const s of p.segments) {
        const take = s.takes[s.takes.length - 1];
        if (take?.status === 'running' && p.readyAt[take.id] <= t) {
          take.status = 'succeeded';
          take.posterUrl = placeholderImage(`片段 ${s.index + 1}`, hueOf(p.id + s.index), p.ratio);
          s.selectedTakeId = take.id;
        }
        if (take?.status === 'succeeded') done++;
      }
      const total = p.segments.length;
      if (done === total) {
        setStatus(p, 'composing', '正在拼接成片…', 92);
      } else {
        p.progress = { percent: 45 + Math.round((done / total) * 45), message: `正在为您生成第 ${Math.min(done + 1, total)}/${total} 段视频与自然原声…` };
      }
    }
    if (p.status === 'composing' && t - p.stageAt > COMPOSE_MS) {
      state.wallet.frozenFen -= p.pricing.reservedFen;
      p.pricing.settledFen += p.pricing.reservedFen;
      p.pricing.reservedFen = 0;
      setStatus(p, 'delivered', '成片已完成', 100);
      p.deliveredAt = iso();
      p.expiresAt = iso(t + RETENTION_DAYS * DAY);
      finishRender(p);
    }
    if (p.status === 'delivered') {
      for (const s of p.segments) {
        const take = s.takes[s.takes.length - 1];
        if (take?.status === 'running' && p.readyAt[take.id] <= t) {
          take.status = 'succeeded';
          take.posterUrl = placeholderImage(`片段 ${s.index + 1}·新版`, hueOf(take.id), p.ratio);
          s.selectedTakeId = take.id;
          startRerender(p);
        }
      }
      if (p.rerenderAt && p.rerenderAt <= t) { p.rerenderAt = undefined; finishRender(p); }
      if (p.expiresAt && Date.parse(p.expiresAt) <= t) expire(p);
    }
  }
  save();
}
function finishRender(p: MockProject) {
  const cover = placeholderImage(p.title || '成片', hueOf(p.id), p.ratio);
  p.render = { id: uid('rnd'), status: 'succeeded', coverUrl: cover, durationSeconds: p.durationSeconds, createdAt: iso() };
  p.coverUrl = cover;
  p.updatedAt = iso();
}
function startRerender(p: MockProject) {
  p.rerenderAt = now() + COMPOSE_MS;
  if (p.render) p.render = { ...p.render, status: 'running' };
}
function expire(p: MockProject) {
  setStatus(p, 'expired', '已过期，视频已清理', 100);
  if (p.render) { delete p.render.videoUrl; }
  for (const s of p.segments) for (const take of s.takes) { delete take.videoUrl; }
}

// ── 视图 ──
function toSummary(p: MockProject): ProjectSummary {
  const { id, title, status, group, coverUrl, durationSeconds, progress, expiresAt, createdAt, updatedAt } = p;
  return clone({ id, title, status, group, coverUrl, durationSeconds, progress, expiresAt, createdAt, updatedAt });
}
function toDetail(p: MockProject): ProjectDetail {
  const { stageAt, pausedAt, readyAt, rerenderAt, lookTargets, selectedCharacterIds, ...detail } = p;
  void stageAt; void pausedAt; void readyAt; void rerenderAt; void lookTargets; void selectedCharacterIds;
  return clone(detail);
}

// ── 新用户示例数据 ──
function seedDemo() {
  const mk = (name: string, description: string, defaultVoiceId: string): MockCharacter => {
    const c: MockCharacter = { id: uid('chr'), name, tags: ['家人'], description, photos: [], looks: [], styleIds: [], worksCount: 0, defaultVoiceId, createdAt: iso(now() - 30 * DAY) };
    const v: LookVersion = { id: uid('lkv'), status: 'succeeded', imageUrl: placeholderImage(`${name}·卡通 3D`, hueOf(name + 'cartoon_3d')), createdAt: c.createdAt };
    c.looks.push({ styleId: 'cartoon_3d', selectedVersionId: v.id, imageUrl: v.imageUrl, versions: [v] });
    return c;
  };
  const baby = mk('宝宝', '4 岁女孩，圆脸短发，爱穿黄色裙子', 'vc_childf_sweet');
  const mom = mk('妈妈', '30 岁左右，长发，笑容温柔', 'vc_middlef_mom');
  state.characters.push(baby, mom);
  const demo = (title: string, deliveredDaysAgo: number): MockProject => {
    const delivered = now() - deliveredDaysAgo * DAY;
    const cover = placeholderImage(title, hueOf(title), '9:16');
    const segs: Segment[] = [0, 1].map((i) => {
      const takeId = uid('take');
      return { id: uid('seg'), index: i, durationSeconds: 30, plot: i ? '宝宝和妈妈一起在草地上奔跑、放风筝。' : '阳光明媚的周末，一家人来到公园铺开野餐垫。', dialogue: [], transition: i ? 'prev_tail' : 'hard_cut', castIds: [], selectedTakeId: takeId, takes: [{ id: takeId, status: 'succeeded', posterUrl: placeholderImage(`片段 ${i + 1}`, hueOf(title + i), '9:16'), createdAt: iso(delivered) }] };
    });
    const p: MockProject = {
      id: uid('prj'), title, status: 'delivered', group: 'done', coverUrl: cover, durationSeconds: 60, progress: { percent: 100, message: '成片已完成' },
      expiresAt: iso(delivered + RETENTION_DAYS * DAY), createdAt: iso(delivered - 600_000), updatedAt: iso(delivered),
      storyText: '周末带宝宝去公园野餐，宝宝第一次放风筝，开心得不得了。', sourceType: 'text', styleId: 'cartoon_3d', qualityTierId: 'standard', ratio: '9:16',
      story: { synopsis: '周末一家人去公园野餐，宝宝第一次放风筝。', totalSeconds: 60, segmentCount: 2, compressed: false },
      cast: [baby, mom].map((c) => ({ id: uid('cast'), name: c.name, description: c.description || '', gender: c === mom ? 'female' : 'unknown', ageGroup: c === mom ? 'middle' : 'child', characterId: c.id, matchSource: 'user', look: { status: 'ready', versionId: c.looks[0].selectedVersionId, imageUrl: c.looks[0].imageUrl, versions: clone(c.looks[0].versions) }, voice: { voiceId: c.defaultVoiceId!, source: 'default' } })),
      segments: segs, voicesEnabled: true,
      pricing: { looksToGenerate: 0, looksFen: 0, videoFen: 1200, totalFen: 1200, reservedFen: 0, settledFen: 1200, refundedFen: 0 },
      render: { id: uid('rnd'), status: 'succeeded', coverUrl: cover, durationSeconds: 60, createdAt: iso(delivered) },
      deliveredAt: iso(delivered), stageAt: delivered, readyAt: {}, selectedCharacterIds: [baby.id, mom.id],
    };
    return p;
  };
  state.projects.push(demo('周末公园野餐', RETENTION_DAYS - 5), demo('宝宝第一次学走路', RETENTION_DAYS + 3));
}

// ── 接口实现 ──
export const mockApi: MivApi = {
  async me() { await wait(80); tick(); return clone(requireLogin()); },
  async sendSms() { await wait(); return { cooldownSeconds: 60 }; },
  async login(phone, code) {
    await wait();
    if (!/^1\d{10}$/.test(phone)) fail(400, 'VALIDATION_FAILED', '请输入正确的手机号');
    if (!/^\d{6}$/.test(code)) fail(400, 'SMS_CODE_INVALID', '验证码错误或已过期');
    const isNewUser = !state.knownPhones.includes(phone);
    if (isNewUser) {
      Object.assign(state, { ...emptyState(), knownPhones: [...state.knownPhones, phone] });
      addLedger('recharge', 5000, '新用户体验金（演示）');
      seedDemo();
    }
    state.session = {
      csrfToken: uid('csrf'),
      user: { id: uid('usr'), phoneMasked: `${phone.slice(0, 3)}****${phone.slice(7)}`, nickname: `用户${phone.slice(7)}`, onboarding: isNewUser ? { tourCompletedAt: null, tipsSeen: [] } : state.session?.user.onboarding ?? { tourCompletedAt: iso(), tipsSeen: [] } },
    };
    tick();
    return { ...clone(state.session), isNewUser };
  },
  async logout() { await wait(80); state.session = null; save(); },
  async updateOnboarding(patch) {
    const s = requireLogin();
    if (patch.tourCompleted) s.user.onboarding.tourCompletedAt ??= iso();
    if (patch.tipSeen && !s.user.onboarding.tipsSeen.includes(patch.tipSeen)) s.user.onboarding.tipsSeen.push(patch.tipSeen as TipKey);
    save();
    return { onboarding: clone(s.user.onboarding) };
  },

  async catalog() { await wait(80); return clone(CATALOG); },
  async voices(category) { await wait(80); return { items: voices().filter((v) => !category || v.category === category) }; },

  async wallet() { await wait(80); requireLogin(); tick(); return clone(state.wallet); },
  async ledger() { await wait(80); requireLogin(); return { items: clone(state.ledger), nextCursor: null }; },
  async redeem(code) {
    await wait(); requireLogin();
    if (code.toUpperCase() !== 'DEMO100') fail(400, 'VALIDATION_FAILED', '兑换码无效或已使用（演示码：DEMO100）');
    state.wallet.availableFen += 10000;
    addLedger('redeem', 10000, '兑换码充值');
    save();
    return { amountFen: 10000, wallet: clone(state.wallet) };
  },
  async estimate({ qualityTierId, styleId, characterIds }) {
    await wait(60);
    const perSecond = FEN_PER_SECOND[qualityTierId] ?? FEN_PER_SECOND.standard;
    const missing = characterIds.filter((id) => !readyLook(state.characters.find((c) => c.id === id), styleId)).length;
    return { minFen: 30 * perSecond + missing * LOOK_FEN, maxFen: MAX_SECONDS * perSecond + (missing + 2) * LOOK_FEN };
  },
  async quote(request) {
    await wait(); requireLogin(); tick();
    let breakdown: Quote['breakdown'];
    if (request.kind === 'cast_looks') {
      const p = findProject(request.projectId);
      breakdown = p.cast.filter((m) => m.look.status === 'missing').map((m) => ({ label: `${m.name} · ${styleName(p.styleId)}形象`, amountFen: LOOK_FEN }));
    } else if (request.kind === 'project_render') {
      const p = findProject(request.projectId);
      const tier = CATALOG.qualityTiers.find((t) => t.id === p.qualityTierId)!.name;
      breakdown = p.segments.map((s) => ({ label: `片段 ${s.index + 1} · ${s.durationSeconds} 秒 · ${tier}`, amountFen: s.durationSeconds * FEN_PER_SECOND[p.qualityTierId] }));
    } else if (request.kind === 'look_regenerate') {
      const c = findCharacter(request.characterId);
      breakdown = [{ label: `${c.name} · ${styleName(request.styleId)}形象`, amountFen: LOOK_FEN }];
    } else {
      const p = findProject(request.projectId);
      const s = p.segments.find((x) => x.id === request.segmentId) || fail(404, 'NOT_FOUND', '片段不存在');
      breakdown = [{ label: `重新生成片段 ${s.index + 1} · ${s.durationSeconds} 秒`, amountFen: s.durationSeconds * FEN_PER_SECOND[p.qualityTierId] }];
    }
    const quote: Quote = { quoteId: uid('qt'), kind: request.kind, amountFen: breakdown.reduce((a, b) => a + b.amountFen, 0), breakdown, expiresAt: iso(now() + 15 * 60_000) };
    state.quotes[quote.quoteId] = { ...quote, request };
    save();
    return clone(quote);
  },

  async uploadStory(file) {
    await wait(); requireLogin();
    if (!/\.txt$/i.test(file.name)) fail(400, 'UPLOAD_TYPE_INVALID', '演示环境只支持 txt 文件');
    return { title: file.name.replace(/\.[^.]+$/, ''), text: (await file.text()).slice(0, CATALOG.limits.maxStoryChars) };
  },
  async uploadImage(file) {
    requireLogin();
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) fail(400, 'UPLOAD_TYPE_INVALID', '请上传 jpg、png 或 webp 图片');
    const result = { uploadId: uid('upl'), url: await shrinkImage(file) };
    pendingUploads.set(result.uploadId, result.url);
    return result;
  },

  async listCharacters() { await wait(80); requireLogin(); tick(); return { items: state.characters.filter((c) => !c.deleted).map(summary) }; },
  async createCharacter(body) {
    await wait(); requireLogin();
    if (!body.name.trim()) fail(400, 'VALIDATION_FAILED', '请填写昵称');
    if (!body.photoUploadIds.length && !body.description?.trim()) fail(400, 'VALIDATION_FAILED', '没有照片时请写一段外貌描述');
    const c: MockCharacter = {
      id: uid('chr'), name: body.name.trim(), tags: body.tags || [], description: body.description?.trim() || '', defaultVoiceId: body.defaultVoiceId,
      photos: body.photoUploadIds.map((uploadId) => ({ uploadId, url: pendingUploads.get(uploadId) || placeholderImage('照片', 200) })),
      looks: [], styleIds: [], worksCount: 0, createdAt: iso(),
    };
    state.characters.unshift(c);
    save();
    return summary(c);
  },
  async getCharacter(id) { await wait(80); requireLogin(); tick(); const c = findCharacter(id); refreshCharacter(c); return clone(c); },
  async updateCharacter(id, body) {
    await wait(); requireLogin();
    const c = findCharacter(id);
    if (body.name !== undefined) c.name = body.name.trim() || c.name;
    if (body.tags !== undefined) c.tags = body.tags;
    if (body.description !== undefined) c.description = body.description;
    if (body.defaultVoiceId !== undefined) c.defaultVoiceId = body.defaultVoiceId ?? undefined;
    save();
    refreshCharacter(c);
    return clone(c);
  },
  async replaceCharacterPhotos(id, uploadIds) {
    await wait(); requireLogin();
    const c = findCharacter(id);
    c.photos = uploadIds.map((uploadId) => c.photos.find((ph) => ph.uploadId === uploadId) || { uploadId, url: pendingUploads.get(uploadId) || placeholderImage('照片', 200) });
    save();
    return clone(c);
  },
  async generateLook(id, styleId, quoteId) {
    await wait(); requireLogin();
    const c = findCharacter(id);
    const quote = consumeQuote(quoteId, 'look_regenerate', id);
    charge(quote.amountFen, `${c.name} · ${styleName(styleId)}形象`);
    const version = startLook(c, styleId);
    save();
    return clone(version);
  },
  async selectLook(id, styleId, versionId) {
    await wait(); requireLogin();
    const c = findCharacter(id);
    const look = lookOf(c, styleId);
    const v = look.versions.find((x) => x.id === versionId && x.status === 'succeeded') || fail(404, 'NOT_FOUND', '形象版本不存在');
    look.selectedVersionId = v.id;
    look.imageUrl = v.imageUrl;
    save();
    refreshCharacter(c);
    return clone(c);
  },
  async deleteCharacter(id) { await wait(); requireLogin(); findCharacter(id).deleted = true; save(); return { ok: true }; },

  async listProjects(group) {
    await wait(80); requireLogin(); tick();
    const items = state.projects.filter((p) => !p.deletedAt && (!group || p.group === group)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(toSummary);
    return { items, nextCursor: null };
  },
  async createProject(body: CreateProjectRequest) {
    await wait(); requireLogin();
    const length = body.storyText.trim().length;
    if (length < CATALOG.limits.minStoryChars) fail(400, 'STORY_TOO_SHORT', '故事有点短，再多写几句吧');
    if (length > CATALOG.limits.maxStoryChars) fail(400, 'STORY_TOO_LONG', '故事太长了，请精简一些');
    useFreeQuota();
    const p: MockProject = {
      id: uid('prj'), title: body.title || '', status: 'understanding', group: 'active', progress: { percent: 5, message: 'AI 正在细读您的故事…' },
      createdAt: iso(), updatedAt: iso(), storyText: body.storyText.trim(), sourceType: body.sourceType, styleId: body.styleId,
      qualityTierId: body.qualityTierId, ratio: body.ratio || '9:16', cast: [], segments: [], voicesEnabled: false,
      pricing: { looksToGenerate: 0, looksFen: 0, videoFen: 0, totalFen: 0, reservedFen: 0, settledFen: 0, refundedFen: 0 },
      stageAt: now(), readyAt: {}, selectedCharacterIds: body.characterIds,
    };
    state.projects.unshift(p);
    save();
    return toDetail(p);
  },
  async getProject(id) { await wait(80); requireLogin(); tick(); return toDetail(findProject(id)); },
  async deleteProject(id) {
    await wait(); requireLogin();
    const p = findProject(id);
    if (!['delivered', 'expired', 'failed', 'canceled', 'story_review', 'cast_review'].includes(p.status)) fail(409, 'PROJECT_STATE_INVALID', '制作中的作品请先取消');
    p.deletedAt = iso();
    save();
    return { ok: true };
  },
  async reanalyzeStory(id, storyText) {
    await wait(); requireLogin();
    const p = findProject(id);
    expectState(p, 'story_review');
    useFreeQuota();
    p.storyText = storyText.trim();
    p.story = undefined; p.cast = []; p.segments = [];
    setStatus(p, 'understanding', 'AI 正在重新整理您的故事…', 5);
    save();
    return toDetail(p);
  },
  async setCastCharacter(id, castId, characterId) {
    await wait(); requireLogin();
    const p = findProject(id);
    expectState(p, 'story_review');
    const m = p.cast.find((x) => x.id === castId) || fail(404, 'NOT_FOUND', '角色不存在');
    if (characterId) { const c = findCharacter(characterId); m.characterId = c.id; m.matchSource = 'user'; m.name = c.name; }
    else { m.characterId = undefined; m.matchSource = 'new'; }
    m.look = { status: 'missing', versions: [] };
    delete m.voice;
    syncCast(p); priceProject(p); save();
    return toDetail(p);
  },
  async confirmStory(id, quoteId) {
    await wait(); requireLogin(); tick();
    const p = findProject(id);
    expectState(p, 'story_review');
    if (p.pricing.looksToGenerate > 0) {
      const quote = consumeQuote(quoteId, 'cast_looks', id);
      charge(quote.amountFen, `作品《${p.title}》角色形象`);
      p.lookTargets = {};
      for (const m of p.cast.filter((x) => x.look.status === 'missing')) {
        let c = m.characterId ? state.characters.find((x) => x.id === m.characterId) : undefined;
        if (!c) {
          c = { id: uid('chr'), name: m.name, tags: [], description: m.description, photos: [], looks: [], styleIds: [], worksCount: 0, createdAt: iso() };
          state.characters.unshift(c);
          m.characterId = c.id;
        }
        p.lookTargets[m.id] = startLook(c, p.styleId).id;
      }
      setStatus(p, 'casting', '正在为角色生成形象…', 30);
      syncCast(p);
    } else {
      setStatus(p, 'cast_review', '角色已就绪，等你确认', 40);
    }
    save();
    return toDetail(p);
  },
  async updateCast(id, castId, patch) {
    await wait(); requireLogin();
    const p = findProject(id);
    expectState(p, 'cast_review');
    const m = p.cast.find((x) => x.id === castId) || fail(404, 'NOT_FOUND', '角色不存在');
    if (patch.lookVersionId) {
      const v = m.look.versions.find((x) => x.id === patch.lookVersionId && x.status === 'succeeded') || fail(404, 'NOT_FOUND', '形象版本不存在');
      m.look.versionId = v.id; m.look.imageUrl = v.imageUrl;
    }
    if (patch.voiceId) {
      if (!p.voicesEnabled) fail(409, 'PROJECT_STATE_INVALID', '只有一个片段的作品不需要选择声音');
      if (p.cast.some((x) => x.id !== castId && x.voice?.voiceId === patch.voiceId)) fail(409, 'VOICE_DUPLICATED', '两个角色不能使用同一个声音');
      m.voice = { voiceId: patch.voiceId, source: 'user' };
    }
    p.updatedAt = iso(); save();
    return toDetail(p);
  },
  async regenerateCastLook(id, castId, quoteId) {
    await wait(); requireLogin();
    const p = findProject(id);
    expectState(p, 'cast_review');
    const m = p.cast.find((x) => x.id === castId) || fail(404, 'NOT_FOUND', '角色不存在');
    const c = findCharacter(m.characterId!);
    const quote = consumeQuote(quoteId, 'look_regenerate', c.id);
    charge(quote.amountFen, `${c.name} · ${styleName(p.styleId)}形象`);
    (p.lookTargets ||= {})[m.id] = startLook(c, p.styleId).id;
    setStatus(p, 'casting', `正在重新生成「${m.name}」的形象…`, 35);
    syncCast(p); save();
    return toDetail(p);
  },
  async confirmCast(id, quoteId) {
    await wait(); requireLogin();
    const p = findProject(id);
    expectState(p, 'cast_review');
    const quote = consumeQuote(quoteId, 'project_render', id);
    if (state.wallet.availableFen < quote.amountFen) fail(402, 'INSUFFICIENT_BALANCE', '余额不足，请先充值');
    state.wallet.availableFen -= quote.amountFen;
    state.wallet.frozenFen += quote.amountFen;
    p.pricing.reservedFen = quote.amountFen;
    addLedger('reserve', -quote.amountFen, `作品《${p.title}》视频费预占`);
    p.segments.forEach((s, i) => {
      const take = { id: uid('take'), status: 'running' as const, createdAt: iso() };
      s.takes.push(take);
      p.readyAt[take.id] = now() + TAKE_MS * (i + 1); // 尾帧衔接：按顺序生成
    });
    setStatus(p, 'rendering', `正在为您生成第 1/${p.segments.length} 段视频与自然原声…`, 45);
    save();
    return toDetail(p);
  },
  async pause(id) {
    await wait(); requireLogin();
    const p = findProject(id);
    expectState(p, 'understanding', 'casting', 'rendering');
    p.pausedFrom = p.status; p.pausedAt = now();
    p.status = 'paused'; p.group = 'active'; p.progress = { ...p.progress, message: '已暂停' }; p.updatedAt = iso();
    save();
    return toDetail(p);
  },
  async resume(id) {
    await wait(); requireLogin();
    const p = findProject(id);
    expectState(p, 'paused');
    const shift = now() - (p.pausedAt ?? now());
    for (const k of Object.keys(p.readyAt)) p.readyAt[k] += shift;
    p.stageAt += shift;
    p.status = p.pausedFrom!; p.group = groupOf(p.status); p.pausedFrom = undefined; p.pausedAt = undefined; p.updatedAt = iso();
    save();
    return toDetail(p);
  },
  async retry(id) {
    await wait(); requireLogin();
    const p = findProject(id);
    expectState(p, 'failed');
    setStatus(p, p.error?.step || 'understanding', '正在重试…', p.progress.percent);
    p.error = undefined; save();
    return toDetail(p);
  },
  async cancel(id) {
    await wait(); requireLogin();
    const p = findProject(id);
    expectState(p, 'understanding', 'story_review', 'casting', 'cast_review', 'rendering', 'paused');
    if (p.pricing.reservedFen) {
      state.wallet.frozenFen -= p.pricing.reservedFen;
      state.wallet.availableFen += p.pricing.reservedFen;
      addLedger('refund', p.pricing.reservedFen, `作品《${p.title}》取消退回`);
      p.pricing.refundedFen += p.pricing.reservedFen;
      p.pricing.reservedFen = 0;
    }
    setStatus(p, 'canceled', '已取消，未完成部分的费用已退回', p.progress.percent);
    save();
    return toDetail(p);
  },
  async updateSegment(id, segmentId, plot) {
    await wait(); requireLogin();
    const p = findProject(id);
    expectState(p, 'delivered');
    const s = p.segments.find((x) => x.id === segmentId) || fail(404, 'NOT_FOUND', '片段不存在');
    s.plot = plot.trim() || s.plot;
    save();
    return toDetail(p);
  },
  async regenerateSegment(id, segmentId, quoteId) {
    await wait(); requireLogin();
    const p = findProject(id);
    expectState(p, 'delivered');
    const s = p.segments.find((x) => x.id === segmentId) || fail(404, 'NOT_FOUND', '片段不存在');
    const quote = consumeQuote(quoteId, 'segment_take', id);
    charge(quote.amountFen, `作品《${p.title}》重新生成片段 ${s.index + 1}`);
    const take = { id: uid('take'), status: 'running' as const, createdAt: iso() };
    s.takes.push(take);
    p.readyAt[take.id] = now() + TAKE_MS;
    p.updatedAt = iso(); save();
    return toDetail(p);
  },
  async selectTake(id, segmentId, takeId) {
    await wait(); requireLogin();
    const p = findProject(id);
    expectState(p, 'delivered');
    const s = p.segments.find((x) => x.id === segmentId) || fail(404, 'NOT_FOUND', '片段不存在');
    if (!s.takes.some((t) => t.id === takeId && t.status === 'succeeded')) fail(404, 'NOT_FOUND', '版本不存在');
    s.selectedTakeId = takeId;
    startRerender(p);
    save();
    return toDetail(p);
  },
  downloadUrl: () => '',
};

function useFreeQuota() {
  if (state.freeUsage.day !== today()) state.freeUsage = { day: today(), count: 0 };
  if (state.freeUsage.count >= DAILY_FREE) fail(429, 'FREE_QUOTA_EXHAUSTED', '今天的免费整理次数已用完，明天再来');
  state.freeUsage.count++;
}
