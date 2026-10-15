# 接口契约（v0.1，2026-10-15）

> 前后端唯一接口事实来源。前端类型定义见 `apps/web/src/api/types.ts`，两者必须一致。修改流程见 AGENTS.md §3。

## 通用约定

- 前缀 `/api/v1`；请求和响应都是 JSON（上传接口除外）。
- 认证：登录后服务端设置 HttpOnly Cookie；所有写请求带 `X-CSRF-Token`（从 `GET /auth/me` 或登录响应取得）。
- 金额：`*Fen` 整数（分）。时间：ISO 8601 UTC 字符串。
- 幂等：会产生费用或创建资源的 POST 带 `idempotencyKey`（客户端生成的 UUID）。同键同参数时返回首次结果；同键不同参数时返回 409 `IDEMPOTENCY_CONFLICT`。
- 错误：`{ "code": "INSUFFICIENT_BALANCE", "message": "余额不足，请先充值", "requestId": "req_xxx" }`。
- 分页：`?cursor=&limit=`，响应 `{ items, nextCursor }`。

## 1. 认证

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| POST | `/auth/sms` | `{ phone }` | `{ cooldownSeconds }` |
| POST | `/auth/login` | `{ phone, code, agreeTerms: true }` | `{ user: User, csrfToken }` |
| POST | `/auth/logout` | – | `{ ok: true }` |
| GET | `/auth/me` | – | `{ user: User, csrfToken }`；未登录时返回 401 |

`User = { id, phoneMasked, nickname, avatarUrl? }`

## 2. 目录（无需登录）

`GET /catalog` →
```json
{
  "ratios": ["9:16", "16:9", "1:1"],
  "durations": [30, 40, 50],
  "styles": [{ "id": "realistic", "name": "写实电影", "coverUrl": "..." }],
  "qualities": [{ "id": "standard", "name": "标准", "note": "720p" }],
  "limits": { "minScriptChars": 50, "maxScriptChars": 2000 }
}
```

## 3. 钱包与报价

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| GET | `/wallet` | – | `{ availableFen, frozenFen }` |
| GET | `/wallet/ledger` | `?cursor&limit` | `{ items: LedgerEntry[], nextCursor }` |
| POST | `/wallet/redeem` | `{ code, idempotencyKey }` | `{ amountFen, wallet }` |
| POST | `/quotes` | `QuoteRequest` | `Quote` |

```ts
type QuoteRequest =
  | { kind: 'project'; sourceText: string; options: ProjectOptions }
  | { kind: 'asset_version'; projectId: string; assetId: string }
  | { kind: 'shot_take'; projectId: string; shotId: string };
type Quote = { quoteId: string; amountFen: number; breakdown: { label: string; amountFen: number }[]; expiresAt: string };
type LedgerEntry = { id: string; kind: 'recharge'|'redeem'|'reserve'|'settle'|'refund'|'adjust'; amountFen: number; title: string; createdAt: string };
```

## 4. 项目

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| POST | `/uploads/script` | multipart `file`（txt/docx，≤2MB） | `{ title, text }` |
| POST | `/uploads/image` | multipart `file`（jpg/png/webp，≤10MB） | `{ uploadId, url }` |
| POST | `/uploads/video` | multipart `file`（mp4，≤200MB） | `{ uploadId, url }` |
| GET | `/projects` | `?cursor&limit` | `{ items: ProjectSummary[], nextCursor }` |
| POST | `/projects` | `CreateProjectRequest` | `ProjectDetail`（201） |
| GET | `/projects/:id` | – | `ProjectDetail` |
| GET | `/projects/:id/events` | SSE | `event: project` `data: ProjectEvent` |
| POST | `/projects/:id/confirm` | `{ stage: 'plan'|'assets'|'shots' }` | `ProjectDetail` |
| POST | `/projects/:id/pause` | – | `ProjectDetail` |
| POST | `/projects/:id/resume` | – | `ProjectDetail` |
| POST | `/projects/:id/retry` | – | `ProjectDetail` |
| POST | `/projects/:id/cancel` | – | `ProjectDetail` |
| DELETE | `/projects/:id` | – | `{ ok: true }`（仅终态项目可删） |

```ts
type ProjectOptions = { ratio: string; durationSeconds: number; styleId: string; qualityId: string };
type CreateProjectRequest = {
  title?: string; sourceType: 'text'|'file'|'idea'; sourceText: string;
  options: ProjectOptions; mode: 'auto'|'guided'; quoteId: string; idempotencyKey: string;
};
type ProjectStatus = 'draft'|'planning'|'plan_review'|'assets_generating'|'asset_review'|'storyboarding'
  |'shot_review'|'shots_generating'|'composing'|'delivered'|'paused'|'failed'|'canceled';
type ProjectSummary = { id; title; status: ProjectStatus; coverUrl?; durationSeconds?; createdAt; updatedAt };
type ProjectDetail = ProjectSummary & {
  mode; options: ProjectOptions; sourceText; pausedFrom?: ProjectStatus;
  progress: { percent: number; message: string };
  error?: { code: string; message: string };
  billing: { quotedFen: number; frozenFen: number; settledFen: number };
  plan?: Plan; assets: Asset[]; shots: Shot[]; renders: Render[];
};
type ProjectEvent = { projectId; status: ProjectStatus; progress; changed: ('plan'|'assets'|'shots'|'renders')[] };
```

## 5. 剧本（plan）

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| PATCH | `/projects/:id/plan` | `Partial<Pick<Plan,'title'|'logline'|'synopsis'|'scenes'>>`，只能在 `plan_review` 状态修改 | `Plan` |
| POST | `/projects/:id/plan/regenerate` | `{ instruction? }` | `ProjectDetail`（回到 planning） |

`Plan = { version, title, logline, synopsis, scenes: { id, title, location, description, dialogue: { speaker, line }[] }[] }`

## 6. 资产

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| PATCH | `/projects/:id/assets/:assetId` | `{ name?, description? }` | `Asset` |
| POST | `/projects/:id/assets/:assetId/versions` | `{ source: 'generated', quoteId, idempotencyKey, instruction? }` 或 `{ source: 'uploaded', uploadId, rightsConfirmed: true }` | `AssetVersion` |
| PUT | `/projects/:id/assets/:assetId/selection` | `{ versionId }` | `Asset` |

```ts
type Asset = { id; kind: 'character'|'scene'|'prop'; name; description; locked: boolean; selectedVersionId?; versions: AssetVersion[] };
type AssetVersion = { id; source: 'generated'|'uploaded'; status: 'pending'|'running'|'succeeded'|'failed'; imageUrl?; createdAt };
```

## 7. 镜头

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| PATCH | `/projects/:id/shots/:shotId` | `{ voiceover?, description?, durationSeconds? }`，只能在 `shot_review` 状态修改 | `Shot` |
| POST | `/projects/:id/shots` | `{ afterShotId?, description, durationSeconds }`（`shot_review`） | `Shot` |
| DELETE | `/projects/:id/shots/:shotId` | （`shot_review`） | `{ ok: true }` |
| POST | `/projects/:id/shots/:shotId/takes` | `{ source: 'generated', quoteId, idempotencyKey }` 或 `{ source: 'uploaded', uploadId, rightsConfirmed: true }` | `ShotTake` |
| PUT | `/projects/:id/shots/:shotId/selection` | `{ takeId }` | `Shot` |

```ts
type Shot = { id; index; durationSeconds; description; voiceover; assetRefs: string[]; firstFrameUrl?; selectedTakeId?; takes: ShotTake[] };
type ShotTake = { id; source; status: 'pending'|'running'|'succeeded'|'failed'; videoUrl?; posterUrl?; error?; createdAt };
```

## 8. 成片

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| POST | `/projects/:id/renders` | `{ subtitles: boolean, bgmId?: string, idempotencyKey }` | `Render` |
| GET | `/projects/:id/renders/:renderId/download` | – | 302 跳转到带签名的下载地址 |

`Render = { id; status: 'pending'|'running'|'succeeded'|'failed'; videoUrl?; coverUrl?; durationSeconds?; options; createdAt }`

## 9. 错误码（节选）

`UNAUTHENTICATED` `CSRF_INVALID` `SMS_COOLDOWN` `SMS_CODE_INVALID` `INSUFFICIENT_BALANCE` `QUOTE_EXPIRED` `QUOTE_MISMATCH`
`IDEMPOTENCY_CONFLICT` `PROJECT_STATE_INVALID` `SCRIPT_TOO_SHORT` `SCRIPT_TOO_LONG` `UPLOAD_TYPE_INVALID` `UPLOAD_TOO_LARGE`
`CONTENT_REJECTED` `SUBMISSION_UNKNOWN` `RATE_LIMITED`
