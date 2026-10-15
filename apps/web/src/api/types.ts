// 与 docs/API.md 一一对应。改动必须先改 docs/API.md（AGENTS.md §3）。

export interface ApiError { code: string; message: string; requestId?: string }
export interface Page<T> { items: T[]; nextCursor?: string | null }

// 1. 认证
export interface User { id: string; phoneMasked: string; nickname: string; avatarUrl?: string }
export interface Session { user: User; csrfToken: string }

// 2. 目录
export interface StyleOption { id: string; name: string; coverUrl?: string }
export interface QualityOption { id: string; name: string; note?: string }
export interface Catalog {
  ratios: string[];
  durations: number[];
  styles: StyleOption[];
  qualities: QualityOption[];
  limits: { minScriptChars: number; maxScriptChars: number };
}

// 3. 钱包与报价
export interface Wallet { availableFen: number; frozenFen: number }
export type LedgerKind = 'recharge' | 'redeem' | 'reserve' | 'settle' | 'refund' | 'adjust';
export interface LedgerEntry { id: string; kind: LedgerKind; amountFen: number; title: string; createdAt: string }
export type QuoteRequest =
  | { kind: 'project'; sourceText: string; options: ProjectOptions }
  | { kind: 'asset_version'; projectId: string; assetId: string }
  | { kind: 'shot_take'; projectId: string; shotId: string };
export interface Quote { quoteId: string; amountFen: number; breakdown: { label: string; amountFen: number }[]; expiresAt: string }

// 4. 项目
export interface ProjectOptions { ratio: string; durationSeconds: number; styleId: string; qualityId: string }
export type SourceType = 'text' | 'file' | 'idea';
export type ProjectMode = 'auto' | 'guided';
export interface CreateProjectRequest {
  title?: string;
  sourceType: SourceType;
  sourceText: string;
  options: ProjectOptions;
  mode: ProjectMode;
  quoteId: string;
  idempotencyKey: string;
}
export type ProjectStatus =
  | 'draft' | 'planning' | 'plan_review' | 'assets_generating' | 'asset_review' | 'storyboarding'
  | 'shot_review' | 'shots_generating' | 'composing' | 'delivered' | 'paused' | 'failed' | 'canceled';
export interface ProjectSummary {
  id: string; title: string; status: ProjectStatus; coverUrl?: string; durationSeconds?: number;
  createdAt: string; updatedAt: string;
}
export interface ProjectProgress { percent: number; message: string }
export interface ProjectDetail extends ProjectSummary {
  mode: ProjectMode;
  options: ProjectOptions;
  sourceText: string;
  pausedFrom?: ProjectStatus;
  progress: ProjectProgress;
  error?: { code: string; message: string };
  billing: { quotedFen: number; frozenFen: number; settledFen: number };
  plan?: Plan;
  assets: Asset[];
  shots: Shot[];
  renders: Render[];
}
export type ProjectSection = 'plan' | 'assets' | 'shots' | 'renders';
export interface ProjectEvent { projectId: string; status: ProjectStatus; progress: ProjectProgress; changed: ProjectSection[] }
export type ConfirmStage = 'plan' | 'assets' | 'shots';

// 5. 剧本
export interface DialogueLine { speaker: string; line: string }
export interface Scene { id: string; title: string; location: string; description: string; dialogue: DialogueLine[] }
export interface Plan { version: number; title: string; logline: string; synopsis: string; scenes: Scene[] }

// 6. 资产
export type GenStatus = 'pending' | 'running' | 'succeeded' | 'failed';
export interface AssetVersion { id: string; source: 'generated' | 'uploaded'; status: GenStatus; imageUrl?: string; createdAt: string }
export interface Asset {
  id: string; kind: 'character' | 'scene' | 'prop'; name: string; description: string;
  locked: boolean; selectedVersionId?: string; versions: AssetVersion[];
}

// 7. 镜头
export interface ShotTake {
  id: string; source: 'generated' | 'uploaded'; status: GenStatus;
  videoUrl?: string; posterUrl?: string; error?: string; createdAt: string;
}
export interface Shot {
  id: string; index: number; durationSeconds: number; description: string; voiceover: string;
  assetRefs: string[]; firstFrameUrl?: string; selectedTakeId?: string; takes: ShotTake[];
}

// 8. 成片
export interface RenderOptions { subtitles: boolean; bgmId?: string }
export interface Render {
  id: string; status: GenStatus; videoUrl?: string; coverUrl?: string; durationSeconds?: number;
  options: RenderOptions; createdAt: string;
}

/** 前端调用的完整 API 面，http 与 mock 两种实现都必须满足。 */
export interface MivApi {
  me(): Promise<Session>;
  sendSms(phone: string): Promise<{ cooldownSeconds: number }>;
  login(phone: string, code: string): Promise<Session>;
  logout(): Promise<void>;
  catalog(): Promise<Catalog>;
  wallet(): Promise<Wallet>;
  ledger(cursor?: string): Promise<Page<LedgerEntry>>;
  redeem(code: string): Promise<{ amountFen: number; wallet: Wallet }>;
  quote(request: QuoteRequest): Promise<Quote>;
  uploadScript(file: File): Promise<{ title: string; text: string }>;
  listProjects(cursor?: string): Promise<Page<ProjectSummary>>;
  createProject(request: CreateProjectRequest): Promise<ProjectDetail>;
  getProject(id: string): Promise<ProjectDetail>;
  confirm(id: string, stage: ConfirmStage): Promise<ProjectDetail>;
  pause(id: string): Promise<ProjectDetail>;
  resume(id: string): Promise<ProjectDetail>;
  retry(id: string): Promise<ProjectDetail>;
  cancel(id: string): Promise<ProjectDetail>;
  updatePlan(id: string, patch: Partial<Pick<Plan, 'title' | 'logline' | 'synopsis' | 'scenes'>>): Promise<Plan>;
  regeneratePlan(id: string, instruction?: string): Promise<ProjectDetail>;
  generateAssetVersion(id: string, assetId: string, quoteId: string, idempotencyKey: string): Promise<AssetVersion>;
  selectAssetVersion(id: string, assetId: string, versionId: string): Promise<Asset>;
  updateShot(id: string, shotId: string, patch: Partial<Pick<Shot, 'voiceover' | 'description' | 'durationSeconds'>>): Promise<Shot>;
  generateShotTake(id: string, shotId: string, quoteId: string, idempotencyKey: string): Promise<ShotTake>;
  selectShotTake(id: string, shotId: string, takeId: string): Promise<Shot>;
  createRender(id: string, options: RenderOptions, idempotencyKey: string): Promise<Render>;
}
