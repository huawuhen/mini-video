// 与 docs/API.md v1.0 一一对应；改这里之前先改文档（AGENTS.md §3）。

// ── 通用 ──
export interface ApiError { code: string; message: string; requestId?: string; details?: unknown }
export interface Page<T> { items: T[]; nextCursor: string | null }
export type Ratio = '9:16' | '16:9' | '1:1';

// ── §1 认证与用户 ──
export type TipKey = 'story_review' | 'cast_review' | 'delivery';
export interface Onboarding { tourCompletedAt: string | null; tipsSeen: TipKey[] }
export interface Consents {
  terms: string | null;   // 已同意的《用户协议》《隐私政策》版本（登录 agreeTerms 记录）
  photo: string | null;   // 已同意的照片使用说明版本（人脸/儿童照片单独同意）
  current: { terms: string; photo: string };  // 服务端当前版本（判断「已同意」的唯一依据，前端不自带常量）
}
export interface User { id: string; phoneMasked: string; nickname: string; avatarUrl?: string; onboarding: Onboarding; consents: Consents }
export interface Session { user: User; csrfToken: string }
export interface LoginResult extends Session { isNewUser: boolean }

// ── §2 目录 ──
export interface Style { id: string; name: string; description: string; coverUrl?: string }
export interface QualityTier { id: string; name: string; note: string; pricePer30sFen: number }
export interface Catalog {
  styles: Style[];
  qualityTiers: QualityTier[];
  ratios: Ratio[];
  limits: {
    minStoryChars: number; maxStoryChars: number; maxDurationSeconds: number; dailyFreeUnderstanding: number;
    retentionDays: number; expiryRemindDays: number; maxCharacterPhotos: number;
  };
}
export type VoiceCategory = 'girl' | 'boy' | 'child_f' | 'child_m' | 'young_f' | 'young_m' | 'middle_f' | 'middle_m' | 'elder_f' | 'elder_m';
export interface Voice { id: string; name: string; category: VoiceCategory; categoryName: string; description: string; sampleUrl?: string }

// ── §3 钱包与报价 ──
export interface Wallet { availableFen: number; frozenFen: number }
export interface LedgerEntry {
  id: string; kind: 'recharge' | 'redeem' | 'reserve' | 'settle' | 'refund' | 'charge' | 'adjust';
  amountFen: number;      // 对可用余额的变化，扣减为负
  frozenFen: number;      // 对冻结金额的变化（预占为正，结算/退回为负）；结算行 amountFen=0、frozenFen=-实扣
  title: string; createdAt: string;
}
export interface EstimateRequest { qualityTierId: string; styleId: string; characterIds: string[] }
export type QuoteRequest =
  | { kind: 'cast_looks'; projectId: string }
  | { kind: 'project_render'; projectId: string }
  | { kind: 'look_regenerate'; characterId: string; styleId: string }
  | { kind: 'segment_take'; projectId: string; segmentId: string };
export interface Quote {
  quoteId: string; kind: QuoteRequest['kind']; amountFen: number;
  breakdown: { label: string; amountFen: number }[]; expiresAt: string;
}

// ── §4 上传 ──
export interface UploadedImage { uploadId: string; url: string }

// ── §5 数字资产库 ──
export type GenStatus = 'pending' | 'running' | 'succeeded' | 'failed';
export interface LookVersion { id: string; status: GenStatus; imageUrl?: string; viewUrls?: string[]; error?: string; createdAt: string }
export interface Look { styleId: string; selectedVersionId?: string; imageUrl?: string; versions: LookVersion[] }
export interface Character {
  id: string; name: string; tags: string[]; avatarUrl?: string; styleIds: string[];
  worksCount: number; defaultVoiceId?: string; createdAt: string;
}
export interface CharacterDetail extends Character { description?: string; photos: { uploadId: string; url: string }[]; looks: Look[] }
export interface CreateCharacterRequest { name: string; tags?: string[]; description?: string; photoUploadIds: string[]; defaultVoiceId?: string }
export interface UpdateCharacterRequest { name?: string; tags?: string[]; description?: string; defaultVoiceId?: string | null }

// ── §6 作品 ──
export type ProjectGroup = 'active' | 'review' | 'done' | 'failed' | 'expired';
export type ProjectStatus =
  | 'understanding' | 'story_review' | 'casting' | 'cast_review' | 'rendering' | 'composing'
  | 'delivered' | 'expired' | 'paused' | 'failed' | 'canceled';
export interface Progress { percent: number; message: string }
export interface CreateProjectRequest {
  storyText: string; sourceType: 'text' | 'file'; title?: string;
  styleId: string; qualityTierId: string; ratio?: Ratio; characterIds: string[]; idempotencyKey: string;
}
export interface ProjectSummary {
  id: string; title: string; status: ProjectStatus; group: ProjectGroup;
  coverUrl?: string; durationSeconds?: number; progress: Progress; expiresAt?: string;
  createdAt: string; updatedAt: string;
}
export interface StoryResult {
  inputKind: 'script' | 'idea';    // 用户输入被判定为剧本还是一句话想法
  expanded: boolean;               // 一句话想法是否已被 AI 编剧扩写成剧本
  script: string;                  // 确认点 A 展示并可编辑的剧本全文（扩写结果或用户原文的整理版）
  synopsis: string;                // AI 整理后的故事梗概
  totalSeconds: number; segmentCount: number;
  compressed: boolean;             // 超过最长时长被精简
  notice?: string;                 // 如「故事较长，已为您精简为 90 秒」
}
export type Gender = 'female' | 'male' | 'unknown';
export type AgeGroup = 'child' | 'teen' | 'young' | 'middle' | 'elder';
export interface CastMember {
  id: string; name: string; description: string; gender: Gender; ageGroup: AgeGroup;
  characterId?: string; matchSource: 'user' | 'ai' | 'new';
  look: { status: 'ready' | 'missing' | 'generating' | 'failed'; versionId?: string; imageUrl?: string; versions: LookVersion[] };
  voice?: { voiceId: string; source: 'user' | 'ai' | 'default' };
}
export type TakeStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'unknown';
export interface Take { id: string; status: TakeStatus; videoUrl?: string; posterUrl?: string; error?: string; createdAt: string }
export interface Segment {
  id: string; index: number; durationSeconds: number; plot: string;
  dialogue: { castId: string; line: string }[]; transition: 'prev_tail' | 'hard_cut'; castIds: string[];
  selectedTakeId?: string; takes: Take[];
}
export interface Pricing {
  looksToGenerate: number; looksFen: number;   // 尚需生成的形象费（确认点 A）
  looksPaidFen: number;                        // 已结算的形象费（确认点 B「已支付」行；2026-10-31 新增）
  videoFen: number; totalFen: number;          // totalFen = looksFen + videoFen（不含已支付形象费）
  reservedFen: number; settledFen: number; refundedFen: number;
}
export interface Render { id: string; status: GenStatus; videoUrl?: string; coverUrl?: string; durationSeconds?: number; createdAt: string }
export interface ProjectDetail extends ProjectSummary {
  storyText: string; sourceType: 'text' | 'file'; styleId: string; qualityTierId: string; ratio: Ratio;
  pausedFrom?: ProjectStatus;
  error?: { code: string; message: string; step: ProjectStatus };
  story?: StoryResult;
  cast: CastMember[];
  segments: Segment[];
  voicesEnabled: boolean;
  pricing: Pricing;
  render?: Render;
  deliveredAt?: string;
}
export interface ProjectEvent { projectId: string; status: ProjectStatus; progress: Progress; changed: ('story' | 'cast' | 'segments' | 'render' | 'pricing')[] }

// ── §3.1 在线充值（M3-PAY-03，API.md §3.1）──
export type PayScene = 'jsapi' | 'h5' | 'native'; // 微信内 / 手机系统浏览器 / PC
export interface RechargeOptions {
  amountsFen: number[];      // 预设档位（分）
  maxAmountFen: number;
  scenes: PayScene[];        // 当前开通的支付方式；空 = 在线充值不可用（只能用兑换码）
  wechatOpenidReady: boolean; // 微信内 JSAPI 需先静默授权拿 openid
}
export interface JsapiPayParams { appId: string; timeStamp: string; nonceStr: string; package: string; signType: 'RSA'; paySign: string }
export type RechargeOrderPay =
  | { type: 'jsapi'; params: JsapiPayParams }
  | { type: 'h5'; url: string }
  | { type: 'native'; codeUrl: string };
export interface RechargeOrder {
  id: string; status: 'created' | 'paid' | 'expired' | 'failed';
  amountFen: number; scene: PayScene; createdAt: string; expiresAt: string; paidAt?: string;
  pay?: RechargeOrderPay; // 仅 created 状态返回，按 scene 三选一
  wallet?: Wallet;        // 仅 paid 状态返回（结果页直接刷新余额）
}

/** 前端统一 API 接口；mock 与 http 两套实现必须同时满足（src/api/index.ts 选择）。 */
export interface MivApi {
  // §1
  me(): Promise<Session>;
  sendSms(phone: string): Promise<{ cooldownSeconds: number }>;
  login(phone: string, code: string): Promise<LoginResult>;
  logout(): Promise<void>;
  updateOnboarding(patch: { tourCompleted?: true; tipSeen?: TipKey }): Promise<{ onboarding: Onboarding }>;
  // §1 同意记录（M3-LEGAL-01）：照片单独同意；返回最新 consents
  photoConsent(version: string): Promise<{ consents: Consents }>;
  // §2
  catalog(): Promise<Catalog>;
  voices(category?: VoiceCategory): Promise<{ items: Voice[] }>;
  // §3
  wallet(): Promise<Wallet>;
  ledger(cursor?: string): Promise<Page<LedgerEntry>>;
  redeem(code: string): Promise<{ amountFen: number; wallet: Wallet }>;
  estimate(body: EstimateRequest): Promise<{ minFen: number; maxFen: number }>;
  quote(body: QuoteRequest): Promise<Quote>;
  // §3.1 在线充值（M3-PAY-03）
  rechargeOptions(): Promise<RechargeOptions>;
  createRechargeOrder(body: { amountFen: number; scene: PayScene; idempotencyKey: string }): Promise<RechargeOrder>;
  getRechargeOrder(orderId: string): Promise<RechargeOrder>;
  listRechargeOrders(cursor?: string): Promise<Page<RechargeOrder>>;
  /** 仅 mock 实现提供：模拟用户支付完成（联调/走查用，真实 API 不存在）。 */
  mockPayOrder?(orderId: string): Promise<RechargeOrder>;
  // §4
  uploadStory(file: File): Promise<{ title: string; text: string }>;
  uploadImage(file: File): Promise<UploadedImage>;
  // §5
  listCharacters(): Promise<{ items: Character[] }>;
  createCharacter(body: CreateCharacterRequest): Promise<Character>;
  getCharacter(id: string): Promise<CharacterDetail>;
  updateCharacter(id: string, body: UpdateCharacterRequest): Promise<CharacterDetail>;
  replaceCharacterPhotos(id: string, uploadIds: string[]): Promise<CharacterDetail>;
  generateLook(id: string, styleId: string, quoteId: string, idempotencyKey: string): Promise<LookVersion>;
  selectLook(id: string, styleId: string, versionId: string): Promise<CharacterDetail>;
  deleteCharacter(id: string): Promise<{ ok: true }>;
  // §6
  listProjects(group?: ProjectGroup, cursor?: string): Promise<Page<ProjectSummary>>;
  createProject(body: CreateProjectRequest): Promise<ProjectDetail>;
  getProject(id: string): Promise<ProjectDetail>;
  deleteProject(id: string): Promise<{ ok: true }>;
  reanalyzeStory(id: string, storyText: string): Promise<ProjectDetail>;
  setCastCharacter(id: string, castId: string, characterId: string | null): Promise<ProjectDetail>;
  confirmStory(id: string, quoteId: string | undefined, idempotencyKey: string): Promise<ProjectDetail>;
  updateCast(id: string, castId: string, patch: { lookVersionId?: string; voiceId?: string }): Promise<ProjectDetail>;
  regenerateCastLook(id: string, castId: string, quoteId: string, idempotencyKey: string): Promise<ProjectDetail>;
  confirmCast(id: string, quoteId: string, idempotencyKey: string): Promise<ProjectDetail>;
  pause(id: string): Promise<ProjectDetail>;
  resume(id: string): Promise<ProjectDetail>;
  retry(id: string): Promise<ProjectDetail>;
  cancel(id: string): Promise<ProjectDetail>;
  updateSegment(id: string, segmentId: string, plot: string): Promise<ProjectDetail>;
  regenerateSegment(id: string, segmentId: string, quoteId: string, idempotencyKey: string): Promise<ProjectDetail>;
  selectTake(id: string, segmentId: string, takeId: string): Promise<ProjectDetail>;
  downloadUrl(id: string): string;
}
