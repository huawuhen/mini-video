# 接口契约（v1.0，2026-10-16，对应 PRD v2.2）

> 前后端唯一接口事实来源。前端类型定义见 `apps/web/src/api/types.ts`，两者必须一致。修改流程见 AGENTS.md §3。
> v0.1（剧本/资产/分镜/镜头模型）已废弃，不要再按旧接口开发。

## 0. 通用约定

- 前缀 `/api/v1`；请求和响应都是 JSON（上传接口除外）。
- 认证：登录后服务端设置 HttpOnly Cookie `miv_sid`；**所有写请求**（POST/PUT/PATCH/DELETE）带 `X-CSRF-Token`（从登录响应或 `GET /auth/me` 取得），服务端同时校验 `Origin`。
- 金额：`*Fen` 整数（分，CNY）。时间：ISO 8601 UTC 字符串。时长：`*Seconds` 整数。
- ID：带前缀的字符串，前端只当不透明字符串使用。

| 前缀 | 对象 | 前缀 | 对象 |
|---|---|---|---|
| `usr_` | 用户 | `prj_` | 作品 |
| `chr_` | 数字人（数字资产） | `cast_` | 作品中的角色 |
| `lkv_` | 数字人形象版本 | `seg_` | 片段 |
| `vc_` | 平台音色 | `take_` | 片段版本 |
| `upl_` | 上传文件 | `rnd_` | 成片 |
| `qt_` | 报价 | `led_` | 账本流水 |
| `po_` | 充值订单 | | |

- 风格 ID、画质档位 ID 是可读短码（如 `realistic`、`standard`），由 `GET /catalog` 下发。
- 幂等：会产生费用或创建资源的 POST 带 `idempotencyKey`（客户端生成的 UUID）。同键同参数返回首次结果；同键不同参数返回 409 `IDEMPOTENCY_CONFLICT`。
- 错误：HTTP 状态码 + `{ "code": "INSUFFICIENT_BALANCE", "message": "余额不足，请先充值", "requestId": "req_xxx" }`。`message` 是面向用户的中文；可选 `details`（仅技术详情折叠区使用）。
- 分页：`?cursor=&limit=`（limit 默认 20，最大 50），响应 `{ items, nextCursor }`，`nextCursor` 为 `null` 表示没有更多。
- 媒体 URL：私有资源返回七牛**签名链接**（有效期 1 小时），前端不要持久化，过期后重新拉取对象即可。素材尚未生成或上传时，对应 `*Url` 字段**缺省**（不返回空字符串）。

## 1. 认证与用户

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| POST | `/auth/sms` | `{ phone }` | `{ cooldownSeconds }` |
| POST | `/auth/login` | `{ phone, code, agreeTerms: true }` | `{ user: User, csrfToken, isNewUser }` |
| POST | `/auth/logout` | – | `{ ok: true }` |
| GET | `/auth/me` | – | `{ user: User, csrfToken }`；未登录 401 `UNAUTHENTICATED` |
| PATCH | `/me/onboarding` | `{ tourCompleted?: true, tipSeen?: TipKey }` | `{ onboarding: Onboarding }` |

```ts
type User = { id: string; phoneMasked: string; nickname: string; avatarUrl?: string; onboarding: Onboarding };
type TipKey = 'story_review' | 'cast_review' | 'delivery';
type Onboarding = {
  tourCompletedAt: string | null;   // 主引导完成或跳过的时间；null 表示首页要自动开始主引导
  tipsSeen: TipKey[];               // 已看过的场景小提示
};
```

- 首次登录（新注册）时 `onboarding.tourCompletedAt = null`。「完成」和「跳过」都调用 `{ tourCompleted: true }`。
- 「我的 → 重新查看新手引导」只在前端重播，不修改服务端状态。

## 2. 目录（无需登录）

`GET /catalog` →

```ts
type Catalog = {
  styles: { id: string; name: string; description: string; coverUrl?: string }[];       // 6 种，按运营排序；封面未上传时缺省
  qualityTiers: { id: string; name: string; note: string; pricePer30sFen: number }[];   // 「标准 / 高清」；不暴露模型名
  ratios: ('9:16' | '16:9' | '1:1')[];          // 默认 9:16
  limits: {
    minStoryChars: number; maxStoryChars: number;
    maxDurationSeconds: number;                 // 单部作品最长时长，当前 90
    dailyFreeUnderstanding: number;             // 每天免费故事理解次数，当前 20
    retentionDays: number;                      // 作品视频保存天数，当前 90
    expiryRemindDays: number;                   // 到期前多少天提醒，当前 7
    maxCharacterPhotos: number;                 // 5
  };
};
```

`GET /voices?category=` →（无需登录）

```ts
type VoiceCategory = 'girl' | 'boy' | 'child_f' | 'child_m' | 'young_f' | 'young_m' | 'middle_f' | 'middle_m' | 'elder_f' | 'elder_m';
type Voice = { id: string; name: string; category: VoiceCategory; categoryName: string; description: string; sampleUrl?: string };  // 试听素材未上传时缺省
// 响应：{ items: Voice[] }（全量返回，数量少，不分页）
```

分类中文名：少女 / 少年 / 儿童女 / 儿童男 / 青年女 / 青年男 / 中年女 / 中年男 / 老人女 / 老人男。

## 3. 钱包与报价

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| GET | `/wallet` | – | `Wallet` |
| GET | `/wallet/ledger` | `?cursor&limit` | `{ items: LedgerEntry[], nextCursor }` |
| POST | `/wallet/redeem` | `{ code, idempotencyKey }` | `{ amountFen, wallet: Wallet }` |
| POST | `/quotes/estimate` | `EstimateRequest` | `{ minFen, maxFen }`（首页价格区间，不生成报价单） |
| POST | `/quotes` | `QuoteRequest` | `Quote` |

```ts
type Wallet = { availableFen: number; frozenFen: number };
type LedgerEntry = {
  id: string; kind: 'recharge' | 'redeem' | 'reserve' | 'settle' | 'refund' | 'charge' | 'adjust';
  amountFen: number;      // 对可用余额的变化，扣减为负
  title: string;          // 中文说明，如「作品《春天的野餐》预占」
  createdAt: string;
};
type EstimateRequest = { qualityTierId: string; styleId: string; characterIds: string[] };
type QuoteRequest =
  | { kind: 'cast_looks'; projectId: string }                           // 确认点 A：为缺形象的角色生成形象
  | { kind: 'project_render'; projectId: string }                       // 确认点 B：本片全部片段的视频费
  | { kind: 'look_regenerate'; characterId: string; styleId: string }   // 资产库或确认点 B 重新生成形象
  | { kind: 'segment_take'; projectId: string; segmentId: string };     // 交付后重新生成单个片段
type Quote = {
  quoteId: string; kind: QuoteRequest['kind'];
  amountFen: number;
  breakdown: { label: string; amountFen: number }[];   // 中文明细，如「片段 1 · 30 秒 · 高清」
  expiresAt: string;                                   // 默认 15 分钟
};
```

- 报价锁定价格版本；用报价执行时服务端会重算，参数或价格变化返回 409 `QUOTE_MISMATCH`，前端重新报价并让用户确认，**不静默多扣**。
- 扣费方式：`cast_looks` / `look_regenerate` 生成前预占、成功结算、失败退回（形象永久归入资产库，作品取消不退）；`project_render` / `segment_take` 同样预占→逐片段结算→失败退回。
- 提交结果未知（`SUBMISSION_UNKNOWN`）的片段保持冻结，不自动重提，等待对账。

### 3.1 在线充值（易支付，M3；PRD 6.4）

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| GET | `/wallet/recharge/options` | – | `RechargeOptions` |
| POST | `/wallet/recharge` | `{ amountFen, payType, device, idempotencyKey }` | `RechargeOrder`（201） |
| GET | `/wallet/recharge/:orderId` | – | `RechargeOrder`（前端支付后轮询） |
| GET | `/wallet/recharge` | `?cursor&limit` | `{ items: RechargeOrder[], nextCursor }` |

```ts
type PayType = 'alipay' | 'wxpay';
type RechargeOptions = {
  amountsFen: number[];                       // 预设档位，默认 [5000, 10000, 50000, 100000]（50/100/500/1000 元）
  maxAmountFen: number;
  payTypes: { id: PayType; name: string }[];  // 后台启用的支付方式；为空表示充值暂不可用
};
type RechargeOrder = {
  id: string; status: 'created' | 'paid' | 'expired' | 'failed';
  amountFen: number; payType: PayType; createdAt: string; expiresAt: string; paidAt?: string;
  // 仅 created 状态返回：前端按 type 展示
  pay?: { type: 'jump' | 'html' | 'qrcode' | 'urlscheme'; info: string };
  wallet?: Wallet;                            // 仅 paid 状态返回，用于结果页直接刷新余额
};
```

- `amountFen` 必须是 `amountsFen` 中的值，否则 400 `VALIDATION_FAILED`；`device` 取 `pc`（返回二维码或跳转）或 `mobile`（返回跳转）。
- 同一 `idempotencyKey` 重放返回同一订单；每用户同时最多 3 笔 `created` 订单，每小时最多创建 10 笔，超出 429 `RATE_LIMITED`。
- 易支付不可用或下单失败返回 502 `PAYMENT_UNAVAILABLE`，**不留下 `created` 订单**。
- `return_url` 为 `{WEB_BASE_URL}/wallet/recharge/result?orderId=<id>`；前端结果页只用 `GET /wallet/recharge/:orderId` 轮询，**不以浏览器跳转参数判断是否支付成功**。
- 到账只由服务端的异步通知（加主动查单核验）和对账任务完成，前端没有「确认已支付」接口。
- 实现提示：`/wallet/recharge/options` 必须先于 `/wallet/recharge/:orderId` 注册，否则 `options` 会被当成订单号；订单 ID 只接受 `po_` 前缀，其他一律 404。

**易支付异步通知**（不属于前端接口，列出供后端、运维对接）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/payments/ezfp/notify` | 易支付服务器回调；**不要求登录和 CSRF**，挂载在会话中间件之前；成功（含重复通知）返回 `text/plain` 的 `success`，其余返回其他内容并写审计日志；不记录签名和密钥 |

## 4. 上传

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| POST | `/uploads/story` | multipart `file`（txt/docx，≤2MB） | `{ title, text }`（只提取文字，不保存文件） |
| POST | `/uploads/image` | multipart `file`（jpg/png/webp，≤10MB） | `{ uploadId, url }` |

上传的图片只在被 `characters` 引用后才长期保存；24 小时内未被引用的自动清理。

## 5. 我的数字资产库（数字人）

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| GET | `/characters` | – | `{ items: Character[] }` |
| POST | `/characters` | `CreateCharacterRequest` | `Character`（201） |
| GET | `/characters/:id` | – | `CharacterDetail` |
| PATCH | `/characters/:id` | `{ name?, tags?, description?, defaultVoiceId?: string \| null }` | `CharacterDetail` |
| PUT | `/characters/:id/photos` | `{ uploadIds: string[] }`（1~5 张，整体替换） | `CharacterDetail` |
| POST | `/characters/:id/looks/:styleId/versions` | `{ quoteId, idempotencyKey }`（报价 kind=`look_regenerate`） | `LookVersion`（202，异步生成） |
| PUT | `/characters/:id/looks/:styleId/selection` | `{ versionId }` | `CharacterDetail` |
| DELETE | `/characters/:id` | – | `{ ok: true }`（软删除；历史作品不受影响） |

```ts
type CreateCharacterRequest = {
  name: string;                    // 昵称：妈妈、宝宝……
  tags?: string[];
  description?: string;            // 无照片时必填，如「5 岁小女孩，短发，爱穿黄色裙子」
  photoUploadIds: string[];        // 0~5 张；为 0 时 description 必填
  defaultVoiceId?: string;
};
type LookVersion = { id: string; status: 'pending' | 'running' | 'succeeded' | 'failed'; imageUrl?: string; viewUrls?: string[]; error?: string; createdAt: string };
type Look = { styleId: string; selectedVersionId?: string; imageUrl?: string; versions: LookVersion[] };
type Character = {
  id: string; name: string; tags: string[];
  avatarUrl?: string;              // 优先最近使用风格的当前形象，否则第一张参考照片
  styleIds: string[];              // 已有形象的风格（角标）
  worksCount: number;              // 已参与作品数
  defaultVoiceId?: string;
  createdAt: string;
};
type CharacterDetail = Character & { description?: string; photos: { uploadId: string; url: string }[]; looks: Look[] };
```

- 生成形象的创建流程：`POST /characters` → `POST /quotes {kind:'look_regenerate'}` → `POST …/looks/:styleId/versions`。
- 重新生成永远新增版本，不覆盖；切换用 `selection`。

## 6. 作品

### 6.1 列表与创建

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| GET | `/projects` | `?group=&cursor&limit` | `{ items: ProjectSummary[], nextCursor }` |
| POST | `/projects` | `CreateProjectRequest` | `ProjectDetail`（201，状态 `understanding`） |
| GET | `/projects/:id` | – | `ProjectDetail` |
| GET | `/projects/:id/events` | SSE | `event: project`，`data: ProjectEvent` |
| DELETE | `/projects/:id` | – | `{ ok: true }`（进行中的作品先取消；立即删除视频文件） |

```ts
type ProjectGroup = 'active' | 'review' | 'done' | 'failed' | 'expired';
type ProjectStatus =
  | 'understanding'   // 故事理解 + 片段规划中（免费）
  | 'story_review'    // ◆A 等待确认
  | 'casting'         // 角色形象生成中
  | 'cast_review'     // ◆B 等待确认
  | 'rendering'       // 角色绑定 + 片段生成中
  | 'composing'       // 拼接中
  | 'delivered'       // 已交付
  | 'expired'         // 已过期，视频已清理
  | 'paused' | 'failed' | 'canceled';
type CreateProjectRequest = {
  storyText: string; sourceType: 'text' | 'file'; title?: string;
  styleId: string; qualityTierId: string; ratio?: '9:16' | '16:9' | '1:1';
  characterIds: string[];          // 首页托盘里手动勾选的数字人
  idempotencyKey: string;
};
type ProjectSummary = {
  id: string; title: string; status: ProjectStatus; group: ProjectGroup;
  coverUrl?: string; durationSeconds?: number;
  progress: { percent: number; message: string };
  expiresAt?: string;              // 已交付作品的视频到期时间
  createdAt: string; updatedAt: string;
};
```

- 分组：`active` = understanding/casting/rendering/composing/paused；`review` = story_review/cast_review；`done` = delivered；`failed` = failed/canceled；`expired` = expired。
- 创建作品会消耗 1 次当日免费故事理解次数，用完返回 429 `FREE_QUOTA_EXHAUSTED`。创建不扣费。

### 6.2 作品详情

```ts
type ProjectDetail = ProjectSummary & {
  storyText: string; sourceType: 'text' | 'file';
  styleId: string; qualityTierId: string; ratio: '9:16' | '16:9' | '1:1';
  pausedFrom?: ProjectStatus;
  error?: { code: string; message: string; step: ProjectStatus };
  story?: StoryResult;             // understanding 完成后出现
  cast: CastMember[];
  segments: Segment[];
  voicesEnabled: boolean;          // 片段数 ≥2 时为 true；为 false 时前端隐藏「声音」
  pricing: Pricing;
  render?: Render;                 // 当前成片
  deliveredAt?: string;
};
type StoryResult = {
  inputKind: 'script' | 'idea';    // 用户输入被判定为剧本还是一句话想法
  expanded: boolean;               // 一句话想法是否已被 AI 编剧扩写
  script: string;                  // 确认点 A 展示并可编辑的剧本全文（扩写结果或用户原文的整理版）
  synopsis: string;                // AI 整理后的故事梗概
  totalSeconds: number; segmentCount: number;
  compressed: boolean;             // 超过最长时长被精简
  notice?: string;                 // 如「故事较长，已为您精简为 90 秒」
};
type CastMember = {
  id: string; name: string; description: string;
  gender: 'female' | 'male' | 'unknown';
  ageGroup: 'child' | 'teen' | 'young' | 'middle' | 'elder';
  characterId?: string;            // 绑定的数字人；故事确认后对未匹配角色自动新建
  matchSource: 'user' | 'ai' | 'new';   // 用户勾选 / AI 自动匹配 / 将新建
  look: { status: 'ready' | 'missing' | 'generating' | 'failed'; versionId?: string; imageUrl?: string; versions: LookVersion[] };
  voice?: { voiceId: string; source: 'user' | 'ai' | 'default' };   // voicesEnabled=false 时不返回
};
type Segment = {
  id: string; index: number; durationSeconds: number;
  plot: string;                    // 剧情描述（中文，可在交付后修改）
  dialogue: { castId: string; line: string }[];
  transition: 'prev_tail' | 'hard_cut';
  castIds: string[];
  selectedTakeId?: string; takes: Take[];
};
type Take = {
  id: string; status: 'pending' | 'running' | 'succeeded' | 'failed' | 'unknown';
  videoUrl?: string; posterUrl?: string; error?: string; createdAt: string;
};
type Pricing = {
  looksToGenerate: number;         // 需要新生成形象的角色数
  looksFen: number;                // 形象费（确认点 A 后单独扣）
  videoFen: number;                // 视频费（确认点 B 预占）
  totalFen: number;                // looksFen + videoFen，确认点 B 展示
  reservedFen: number; settledFen: number; refundedFen: number;
};
type Render = { id: string; status: 'pending' | 'running' | 'succeeded' | 'failed'; videoUrl?: string; coverUrl?: string; durationSeconds?: number; createdAt: string };
type ProjectEvent = { projectId: string; status: ProjectStatus; progress: { percent: number; message: string }; changed: ('story' | 'cast' | 'segments' | 'render' | 'pricing')[] };
```

### 6.3 确认点 A：故事确认（`story_review`）

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| POST | `/projects/:id/story/reanalyze` | `{ storyText }`（用户在确认点 A 编辑后的剧本全文） | `ProjectDetail`（回到 `understanding`，消耗 1 次免费次数；**按剧本处理，不会再次扩写**，`story.inputKind` 变为 `script`） |
| PUT | `/projects/:id/cast/:castId/character` | `{ characterId: string \| null }`（纠正匹配；null 表示新建） | `ProjectDetail` |
| POST | `/projects/:id/confirm-story` | `{ quoteId?, idempotencyKey }` | `ProjectDetail` |

- `pricing.looksToGenerate > 0` 时必须带 `kind: 'cast_looks'` 的 `quoteId`，确认后扣形象费 → `casting`；为 0 时直接进入 `cast_review`。
- 余额不足返回 402 `INSUFFICIENT_BALANCE`，作品停在 `story_review`。

### 6.4 确认点 B：角色确认（`cast_review`）

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| PUT | `/projects/:id/cast/:castId` | `{ lookVersionId?, voiceId? }` | `ProjectDetail` |
| POST | `/projects/:id/cast/:castId/looks` | `{ quoteId, idempotencyKey }`（kind=`look_regenerate`，作品风格） | `ProjectDetail`（新增形象版本，写入数字资产库） |
| POST | `/projects/:id/confirm-cast` | `{ quoteId, idempotencyKey }`（kind=`project_render`） | `ProjectDetail`（预占视频费 → `rendering`） |

- `voiceId` 仅在 `voicesEnabled` 时可设置；同一作品两个角色不能用同一音色（409 `VOICE_DUPLICATED`）。
- 确认后锁定「角色 → 形象版本、音色」，后续重新生成片段沿用。

### 6.5 进行中控制

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/projects/:id/pause` | 暂停（仅 understanding/casting/rendering；已提交上游的片段继续完成） |
| POST | `/projects/:id/resume` | 恢复到 `pausedFrom` |
| POST | `/projects/:id/retry` | `failed` 时从失败步骤续跑（不重复扣已结算的部分） |
| POST | `/projects/:id/cancel` | 取消；未开始的片段退回预占 |

均返回 `ProjectDetail`；状态不允许时 409 `PROJECT_STATE_INVALID`。

### 6.6 交付后（`delivered`）

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| PATCH | `/projects/:id/segments/:segmentId` | `{ plot }` | `ProjectDetail` |
| POST | `/projects/:id/segments/:segmentId/takes` | `{ quoteId, idempotencyKey }`（kind=`segment_take`） | `ProjectDetail`（新版本成功后自动选中并重新拼接） |
| PUT | `/projects/:id/segments/:segmentId/selection` | `{ takeId }` | `ProjectDetail`（自动重新拼接，免费） |
| GET | `/projects/:id/download` | – | 302 到带签名、`attachment` 的成片地址 |

- 已过期（`expired`）作品以上接口返回 410 `PROJECT_EXPIRED`。
- 重新拼接期间 `render.status = 'running'`，`status` 仍为 `delivered`。

## 7. 错误码

| HTTP | code | 说明 |
|---|---|---|
| 400 | `VALIDATION_FAILED` | 参数错误（`details.fields` 列出字段） |
| 400 | `STORY_TOO_SHORT` / `STORY_TOO_LONG` | 故事字数超出范围 |
| 400 | `UPLOAD_TYPE_INVALID` / `UPLOAD_TOO_LARGE` | 上传文件不符合要求 |
| 401 | `UNAUTHENTICATED` | 未登录 |
| 403 | `CSRF_INVALID` | CSRF 或 Origin 校验失败 |
| 402 | `INSUFFICIENT_BALANCE` | 余额不足 |
| 404 | `NOT_FOUND` | 对象不存在或不属于当前用户 |
| 409 | `IDEMPOTENCY_CONFLICT` / `QUOTE_MISMATCH` / `QUOTE_EXPIRED` | 幂等或报价冲突 |
| 409 | `PROJECT_STATE_INVALID` / `VOICE_DUPLICATED` | 状态或业务冲突 |
| 410 | `PROJECT_EXPIRED` | 作品视频已过期清理 |
| 422 | `CONTENT_REJECTED` | 内容审核不通过（M3） |
| 429 | `RATE_LIMITED` / `SMS_COOLDOWN` / `FREE_QUOTA_EXHAUSTED` | 频率限制 |
| 400 | `SMS_CODE_INVALID` | 验证码错误或过期 |
| 500 | `INTERNAL` | 服务器错误 |
| 502 | `UPSTREAM_FAILED` / `SUBMISSION_UNKNOWN` | 上游失败 / 提交结果未知（冻结待对账） |
| 502 | `PAYMENT_UNAVAILABLE` | 支付通道暂不可用（M3） |
