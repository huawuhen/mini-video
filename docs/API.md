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
| POST | `/me/consents` | `{ kind: 'photo', version: string }` | `{ consents: Consents }`（人脸/儿童照片单独同意，M3-LEGAL-01；`version` 必须等于服务端当前版本，否则 400 `VALIDATION_FAILED`） |

```ts
type User = { id: string; phoneMasked: string; nickname: string; avatarUrl?: string; onboarding: Onboarding; consents: Consents };
type Consents = {
  terms: string | null;   // 已同意的《用户协议》《隐私政策》版本（登录时 agreeTerms 记录服务端当前版本，如 'terms-v1'）
  photo: string | null;   // 已同意的照片单独同意版本（如 'photo-v1'）；与当前版本不一致时视为未同意
  current: { terms: string; photo: string };  // 服务端当前版本，前端据此判断是否需要（重新）征求同意
};
type TipKey = 'story_review' | 'cast_review' | 'delivery';
type Onboarding = {
  tourCompletedAt: string | null;   // 主引导完成或跳过的时间；null 表示首页要自动开始主引导
  tipsSeen: TipKey[];               // 已看过的场景小提示
};
```

- 首次登录（新注册）时 `onboarding.tourCompletedAt = null`。「完成」和「跳过」都调用 `{ tourCompleted: true }`。
- 「我的 → 重新查看新手引导」只在前端重播，不修改服务端状态。
- 照片同意弹窗：正文为 `docs/legal/photo-consent.md` 全文（该文件只放用户可见文字），按钮「不同意」（次要，关闭不上传）｜「同意并上传」（主按钮）；当前版本 `photo-v1`，协议当前版本 `terms-v1`，正文实质变更时 Lead 升版本号。
- 同意记录（M3-LEGAL-01，PRD §11）：登录 `agreeTerms: true` 时服务端写入 `terms` 当前版本与时间；照片同意通过 `POST /me/consents` 写入。每次同意都追加一条记录（用户、类型、版本、时间、IP），不覆盖历史。协议正文以 `docs/legal/*.md` 为准，版本号变更时同步改服务端常量。

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
  frozenFen: number;      // 对冻结金额的变化（预占为正，结算/退回为负）；结算行 amountFen=0、frozenFen=-实扣（2026-10-26 新增，前端用它显示「从冻结中扣除 ¥X」）
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

### 3.1 在线充值（微信支付，M3；PRD 6.4）

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| GET | `/wallet/recharge/options` | – | `RechargeOptions` |
| POST | `/wallet/recharge` | `{ amountFen, scene, idempotencyKey }` | `RechargeOrder`（201） |
| GET | `/wallet/recharge/:orderId` | – | `RechargeOrder`（前端支付后轮询） |
| GET | `/wallet/recharge` | `?cursor&limit` | `{ items: RechargeOrder[], nextCursor }` |
| GET | `/wechat/oauth/start` | `?returnTo=/wallet/recharge` | 302 到微信网页授权（`snsapi_base`，静默）；仅微信内置浏览器使用 |
| GET | `/wechat/oauth/callback` | `?code&state` | 用 code 换 openid 绑定到当前登录用户后 302 回 `returnTo`；`state` 防 CSRF 且只允许站内相对路径。**这是浏览器整页跳转，任何失败都不返回 JSON**：一律 302 回 `returnTo`（state 无效时回 `/wallet`）并带 `?wechatAuth=failed`，前端据此提示「微信授权未完成，可重试或使用兑换码」（2026-11-02） |

```ts
type PayScene = 'jsapi' | 'h5' | 'native';   // 微信内 / 手机系统浏览器 / PC
type RechargeOptions = {
  amountsFen: number[];      // 预设档位，默认 [5000, 10000, 50000, 100000]（50/100/500/1000 元）
  maxAmountFen: number;
  scenes: PayScene[];        // 当前开通的支付方式；为空表示在线充值暂不可用（只能用兑换码）
  wechatOpenidReady: boolean; // 当前用户是否已有 openid；微信内为 false 时前端先走 /wechat/oauth/start
};
type RechargeOrder = {
  id: string; status: 'created' | 'paid' | 'expired' | 'failed';
  amountFen: number; scene: PayScene; createdAt: string; expiresAt: string; paidAt?: string;
  // 仅 created 状态返回，按 scene 三选一
  pay?:
    | { type: 'jsapi'; params: { appId: string; timeStamp: string; nonceStr: string; package: string; signType: 'RSA'; paySign: string } }
    | { type: 'h5'; url: string }          // 前端 location.href 跳转
    | { type: 'native'; codeUrl: string }; // 前端渲染二维码
  wallet?: Wallet;           // 仅 paid 状态返回，用于结果页直接刷新余额
};
```

- 前端按环境选 `scene`：UA 含 `MicroMessenger` → `jsapi`；其他手机浏览器 → `h5`（`scenes` 不含 `h5` 时提示「请在微信中打开本页面充值」）；PC → `native`。
- `jsapi` 下单而用户没有 openid 时返回 409 `WECHAT_OPENID_REQUIRED`，前端跳 `/wechat/oauth/start` 后回到充值页重试。
- 同一个微信（openid）可以绑定多个手机号账号（例如家人共用一个微信付款、或换号后重新注册）；openid 只用于付款，不是账号身份（2026-11-02）。
- 前端发起授权前必须防循环：带 `wechatAuth=failed` 回来时不再自动跳授权，改为显示提示与「重新授权」按钮。
- `amountFen` 必须是 `amountsFen` 中的值，否则 400 `VALIDATION_FAILED`。
- 同一 `idempotencyKey` 重放返回同一订单；每用户同时最多 3 笔 `created` 订单，每小时最多创建 10 笔，超出 429 `RATE_LIMITED`。
- 微信支付未配置或下单失败返回 502 `PAYMENT_UNAVAILABLE`，**不留下 `created` 订单**。
- 结果页只用 `GET /wallet/recharge/:orderId` 轮询，**不以前端支付回调或跳转判断是否支付成功**。
- 到账只由服务端的支付通知（加主动查单核验）和对账任务完成，前端没有「确认已支付」接口。
- 实现提示：`/wallet/recharge/options` 必须先于 `/wallet/recharge/:orderId` 注册，否则 `options` 会被当成订单号；订单 ID 只接受 `po_` 前缀，其他一律 404。

**微信支付回调通知**（不属于前端接口，列出供后端、运维对接）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/v1/payments/wechat/notify` | 微信支付服务器回调（JSON，需读取**原始请求体**用于验签）；**不要求登录和 CSRF**，挂载在会话中间件之前；成功（含重复通知）返回 204，失败返回 4XX/5XX 与 `{"code":"FAIL","message":"…"}` 并写审计日志；不记录签名、密钥和解密后的 openid |

## 4. 上传

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| POST | `/uploads/story` | multipart `file`（txt/docx，≤2MB） | `{ title, text }`（只提取文字，不保存文件） |
| POST | `/uploads/image` | multipart `file`（jpg/png/webp，≤10MB） | `{ uploadId, url }`；未同意当前版本的照片单独同意时 403 `PHOTO_CONSENT_REQUIRED`（M3-LEGAL-01） |

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
  looksFen: number;                // 尚需生成的形象费（确认点 A 弹窗用；形象生成后为 0）
  looksPaidFen: number;            // 本作品已结算的形象费（2026-10-31 新增；确认点 B「角色形象（已支付）」显示它）
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
| 403 | `PHOTO_CONSENT_REQUIRED` | 上传照片前需要先同意照片使用说明 |
| 401 | `UNAUTHENTICATED` | 未登录 |
| 403 | `CSRF_INVALID` | CSRF 或 Origin 校验失败 |
| 409 | `WECHAT_OPENID_REQUIRED` | 微信内充值需要先完成静默网页授权获取 openid |
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

## 8. 管理端接口（仅运营后台与运维脚本使用，**前端用户端不调用**）

- 路径前缀 `/api/v1/admin`（本节下表省略 `/api/v1`）；**独立管理员账号**（`admin_users`，用户名 + 强密码，首个管理员由 `npm run admin:create` 脚本创建，不开放注册）与独立会话 Cookie；同样校验同源 + CSRF；全部写操作写 `admin_audit_logs`。
- 渠道凭证只写不读：创建 / 更新时传明文，之后接口只返回 `credentialMask`（后 4 位）。渠道 = 驱动（代码里已有的协议）+ 地址 + 密钥 + 模型映射；见 ARCHITECTURE §5.5。

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| POST | `/admin/auth/login` · `/admin/auth/logout` | `{ username, password }` | `{ admin }` |
| GET | `/admin/drivers` | – | `{ items: [{ id, kinds, configSchema, capabilities }] }`（代码里可用的协议驱动，新增渠道表单据此渲染） |
| GET | `/admin/channels?kind=&includeRetired=` | – | `{ items: Channel[] }` |
| POST | `/admin/channels` | `{ kind, name, driver, baseUrl, credential, modelMap, params?, costFen?, remark? }` | `Channel`（`driver` 不存在返回 400） |
| PATCH | `/admin/channels/:id` | 同上可选字段；`credential` 缺省表示不改 | `Channel` |
| POST | `/admin/channels/:id/test` | – | `{ ok, latencyMs, models: [{ name, priceFenPerUnit }], mismatches: [...] }`（免费，调驱动 `catalog()`） |
| POST | `/admin/channels/:id/trial` | `{ capability, confirm: true }` | 最小成本试生成（真实费用，写审计） |
| PUT | `/admin/routes/:kind/:capability` | `{ channelIds: [有序列表] }` | 路由；第一个可用的为主用 |
| POST | `/admin/channels/:id/disable` · `/enable` | – | `Channel` |
| DELETE | `/admin/channels/:id` | – | 软删除（`retired`）；仍有在途任务时仍允许，在途任务继续轮询，清空后清除凭证 |
| GET | `/admin/channels/health` | – | 近 1 小时各渠道成功率 / 失败数 / 排队时长 |

`Channel` 字段：`id, kind, name, driver, baseUrl, credentialMask, modelMap, params, status(active|disabled|retired), unavailable, degraded, inFlight, recent: { total, failed, avgQueueSeconds }, createdAt, updatedAt`。

新增错误码：`ADMIN_AUTH_REQUIRED`(401)、`CHANNEL_NOT_FOUND`(404)、`DRIVER_NOT_FOUND`(400，指定的协议驱动不存在)、`CHANNEL_TEST_FAILED`(400)、`NO_ACTIVE_CHANNEL`(503，用户侧提示“视频/图片生成服务暂时不可用，请稍后再试”，不暴露渠道名称；上游原始错误只放作品「技术详情」，并写日志)。

### 8.1 运营后台·用户与余额（M3-ADM-02）

- 手机号**一律掩码显示**（`138****1234`）；支持按完整手机号**精确**搜索（不做模糊匹配），搜索记审计。
- 金额调整走账本 `kind='adjust'`，正数加、负数减，**必须填原因**；可用余额不能被减成负数（返回 400 `ADJUST_EXCEEDS_BALANCE`）；按 `idempotencyKey` 幂等（前端在打开表单时生成、失败重试沿用同一键）；已注销账号不能调整（400 `VALIDATION_FAILED`）。用户流水显示为「客服调整 +X / -X」，原因只在后台可见。

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| GET | `/admin/users?phone=&userId=&status=&cursor=` | – | `{ items: AdminUser[], nextCursor }`（不带条件时按注册时间倒序） |
| GET | `/admin/users/:id` | – | `AdminUserDetail` |
| GET | `/admin/users/:id/ledger?cursor=` | – | `{ items: AdminLedgerItem[], nextCursor }` |
| POST | `/admin/users/:id/adjust` | `{ amountFen, reason, idempotencyKey }` | `{ wallet, entry: AdminLedgerItem }` |
| POST | `/admin/users/:id/disable` · `/enable` | `{ reason }` | `AdminUser`（停用：立即删除该用户全部会话，不能登录；在途作品继续跑完） |
| POST | `/admin/users/:id/deactivate` | `{ reason, confirm: true }` | `AdminUser`（**注销**，不可恢复：见下） |

```ts
type AdminUser = { id: string; phoneMasked: string; nickname: string; status: 'active' | 'disabled' | 'deactivated';
  balanceFen: number; frozenFen: number; createdAt: string; lastLoginAt: string | null };
type AdminUserDetail = AdminUser & {
  stats: { projects: number; delivered: number; characters: number; rechargedFen: number; spentFen: number };
  consents: { terms: string | null; photo: string | null };
  wechatBound: boolean;
};
type AdminLedgerItem = { id: string; kind: 'recharge' | 'redeem' | 'reserve' | 'settle' | 'refund' | 'charge' | 'adjust';
  amountFen: number; frozenDeltaFen: number; title: string; refType: string | null; refId: string | null;
  reason?: string; adminUsername?: string; createdAt: string };
```

- **注销**（隐私政策「注销账号」）：要求该用户没有在途作品、且冻结金额为 0（即没有「结果待核对」的费用；否则 409 `USER_HAS_ACTIVE_PROJECTS`，提示「该用户还有进行中的作品或待核对的费用，暂不能注销」）；执行后 `status='deactivated'`、删除全部会话、`phone` 改为不可登录的占位值（原号可重新注册为新用户）、删除照片/角色卡/作品视频文件（对象存储），作品与角色记录匿名保留；**剩余可用余额记一条 `adjust` 清零流水**（原因必填，客服应先按协议与用户确认）；账务流水与支付订单保留（法定保存）。

### 8.2 运营后台·充值订单与人工退款（M3-ADM-02）

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| GET | `/admin/orders?status=&userId=&outTradeNo=&from=&to=&cursor=` | – | `{ items: AdminOrder[], nextCursor }` |
| GET | `/admin/orders/:id` | – | `AdminOrder & { notifyCount, lastNotifyAt, ledgerId }` |
| POST | `/admin/orders/:id/reconcile` | – | `AdminOrder`（立刻向微信查单并按结果更新，与定时对账同逻辑） |
| POST | `/admin/orders/:id/refund` | `{ amountFen, reason, idempotencyKey }` | `{ order: AdminOrder, entry: AdminLedgerItem }` |

```ts
type AdminOrder = { id: string; userId: string; phoneMasked: string; outTradeNo: string; transactionId: string | null;
  amountFen: number; refundedFen: number; scene: 'jsapi' | 'h5' | 'native'; status: 'created' | 'paid' | 'expired' | 'failed';
  createdAt: string; paidAt: string | null };
```

- **人工退款（第一期：记录式，用户 2026-11-05 确认）**：钱在「微信支付商户平台 → 交易中心 → 退款」由客服手工退回；本接口只在我方记账——校验订单 `paid`、`refundedFen + amountFen ≤ amountFen(订单)`、用户可用余额足够（否则 400 `REFUND_EXCEEDS_BALANCE`），写一条 `adjust` 负数流水（标题「充值退款」，ref 指向订单）并累加 `refunded_fen`。后台页面在按钮旁写明「请先在微信商户平台完成退款，再在此登记」。第二期如需一键调用微信退款接口，另开任务。

### 8.3 运营后台·作品与失败/待核对任务（M3-ADM-03）

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| GET | `/admin/projects?status=&userId=&hasUnknown=&cursor=` | – | `{ items: AdminProject[], nextCursor }`（`hasUnknown=true` 只列有待核对片段的作品） |
| GET | `/admin/projects/:id` | – | `AdminProjectDetail`（含各片段与 take、gen_task 状态、渠道名、上游任务 ID、冻结/已结算/已退回金额、事件时间线） |
| POST | `/admin/takes/:id/resolve` | `{ outcome: 'not_charged' \| 'charged', note, idempotencyKey }` | `AdminProjectDetail` |
| POST | `/admin/projects/:id/cancel` | `{ reason }` | `AdminProjectDetail`（与用户侧取消同逻辑：退还未消耗冻结；unknown 片段仍保持冻结待 resolve） |

- **待核对处理**（AGENTS §5：unknown 不自动重提、不自动退款；**用户 2026-11-05 决定：上游已扣费但没出片的费用由平台承担**）：运营在渠道后台或上游控制台查明后人工判定一次，两种结论**对用户的资金处理相同**，区别只在内部记录（`charged` 记为平台承担的上游成本）：
  - take 置 `failed`，写 `resolved_*`、`admin_audit_logs` 与作品事件；用户可见时间线统一写「已核对：该片段生成失败，费用未扣除」，不向用户暴露「上游已计费」。
  - **金额一律取该 take 下单时写入的 `gen_tasks.request.amountFen`**，不按当前价重算（与逐段结算同口径；作品取消时保留冻结的 unknown 金额、详情页 `frozenFen` 同样改用此口径）。
  - 用户冻结的去向：①作品仍可重试（未取消、未过期，且不是交付后重拍）→ **保持冻结**，与普通片段失败一致，用户点「重试」时复用这笔冻结，取消作品时随其他冻结一起退回；②交付后重拍（`redelivery`）的 take，或作品已取消 / 已过期 → **当场退回**这笔冻结（标题「待核对退回」）。**不向用户结算。**
  - 按 `idempotencyKey` 幂等：同键同结论重放返回首次结果，同键不同结论 409 `IDEMPOTENCY_CONFLICT`；**同一 take 只能判定一次**（换键重判 409 `TAKE_ALREADY_RESOLVED`）；非 unknown 的 take 409 `TAKE_NOT_UNKNOWN`。

### 8.4 运营后台·价格、档位、风格、音色、运营参数（M3-ADM-04）

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| GET | `/admin/skus` | – | `{ items: AdminSku[] }`（每个 `skuCode` 当前生效版本 + 历史版本数） |
| POST | `/admin/skus/:skuCode/versions` | `{ priceFen, costFen?, effectiveAt?, idempotencyKey }` | `AdminSku`（**新增版本**，旧版本置 `inactive`；不覆盖历史；已出的报价按原价执行） |
| GET | `/admin/tiers` · PATCH `/admin/tiers/:id` | `{ name?, note?, sort?, status? }` | 档位列表 / 更新后档位 |
| POST | `/admin/tiers/:id/mappings` | `{ videoSkuCode }` | 新增档位映射版本（同上，不覆盖） |
| GET | `/admin/styles` · POST `/admin/styles` · PATCH `/admin/styles/:id` | `{ name, description, coverUploadId?, promptHint, sort, status }` | 风格（下架 = `status:'inactive'`，不删除） |
| GET | `/admin/voices` · POST `/admin/voices` · PATCH `/admin/voices/:id` | `{ name, category, gender, ageGroup, description, sampleUploadId?, refAudioUploadId?, sort, status }` | 音色（同上） |
| GET | `/admin/settings` · PATCH `/admin/settings` | `{ [key]: value }`（只允许白名单键） | 运营参数（白名单：`daily_free_understanding`、`max_story_chars`、`min_story_chars`、`max_character_photos`、`max_duration_seconds`、`quote_ttl_seconds`、`expiry_remind_days`、`retention_days`；每个键带类型与上下限校验） |

```ts
type AdminSku = { skuCode: string; kind: 'video' | 'image' | 'llm'; model: string; resolution: string | null;
  unit: 'second' | 'image' | 'ktoken'; priceFen: number; costFen: number; version: number; versions: number;
  effectiveAt: string; marginRate: number | null };   // marginRate = (price - cost) / price，price=0 时 null
```

- 音色、风格封面上传：复用管理端上传 `POST /admin/uploads`（multipart，图片 ≤5MB、音频 mp3/wav/m4a ≤5MB），返回 `{ uploadId }`。

### 8.5 运营后台·审计（M3-ADM-04）

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| GET | `/admin/audit?adminId=&action=&targetType=&targetId=&from=&to=&cursor=` | – | `{ items: [{ id, adminUsername, action, targetType, targetId, detail, ip, createdAt }], nextCursor }`（只读） |

新增错误码（8.1~8.5）：`ADJUST_EXCEEDS_BALANCE`(400)、`REFUND_EXCEEDS_BALANCE`(400)、`REFUND_EXCEEDS_ORDER`(400)、`ORDER_NOT_PAID`(409)、`USER_HAS_ACTIVE_PROJECTS`(409)、`TAKE_ALREADY_RESOLVED`(409)、`TAKE_NOT_UNKNOWN`(409)、`USER_NOT_FOUND`/`ORDER_NOT_FOUND`/`PROJECT_NOT_FOUND`(404)、`SETTING_KEY_NOT_ALLOWED`(400)。**用户被停用 / 注销后**，用户端接口统一 401 `UNAUTHENTICATED`，登录时提示「账号不可用，请联系客服 help@redith.cn」（新错误码 `ACCOUNT_DISABLED` 403）。

