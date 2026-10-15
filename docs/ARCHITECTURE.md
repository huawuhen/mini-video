# 架构设计（v0.1，2026-10-15）

## 1. 总览

```
浏览器（手机/PC）
  apps/web  Vue 3 + Vant 4，响应式
      │  HTTPS JSON + Cookie 会话 + CSRF 头；进度用 SSE（降级为轮询）
      ▼
server  API 进程（Express）           server  Worker 进程（同一份代码，不同入口）
  认证 / 钱包 / 项目 / 报价 / 上传        领取 jobs → 推进项目状态机
      │                                    ├─ engine：剧本 LLM、图片/视频渠道、转存
      ▼                                    └─ render：FFmpeg 拼接/字幕/BGM/水印
PostgreSQL（唯一业务数据源 + 任务队列 + 限流）
对象存储（S3 兼容，七牛 Kodo 优先）：上传素材、资产图、镜头视频、成片
```

- 部署：Docker Compose 4 个服务：`web`（Nginx 托管静态文件并反代 `/api`）、`api`、`worker`、`postgres`。
- 单 Worker 起步，队列支持以后横向增加 Worker。

## 2. 目录结构

```
mini-ai-video/
├─ AGENTS.md / CODEX_HANDOFF.md / README.md / NOTICE
├─ docs/                PRD、ARCHITECTURE、API、UI、TASKS
├─ apps/web/            前端（Vue）
│   └─ src/{api,components,composables,layouts,pages,router,stores,styles,utils}
├─ server/
│   ├─ src/
│   │   ├─ app.js        API 组装入口（BE-Core 独占）
│   │   ├─ worker.js     Worker 入口（BE-Core 独占）
│   │   ├─ db/           pg 连接池、事务（嵌套 savepoint）、迁移执行器
│   │   ├─ auth/         手机号验证码、会话、CSRF
│   │   ├─ wallet/       账本、报价、预占/结算/退回、兑换码
│   │   ├─ projects/     项目/资产/镜头/渲染的仓储与状态机
│   │   ├─ queue/        jobs 表、领取、重试、退避
│   │   ├─ api/          路由（只做参数校验与调用 service）
│   │   ├─ engine/       从超搭云迁移的生成引擎（Engine 角色）
│   │   └─ render/       FFmpeg 合成（Render 角色）
│   ├─ migrations/       001-init.sql 起，按编号顺序执行
│   └─ test/
└─ deploy/               Dockerfile、compose、备份脚本
```

## 3. 引擎复用清单（来源：`/root/chaodayun` @ `2926b42`）

迁移规则：复制到 `server/src/engine/`，文件头注明 `// Source: chaodayun@2926b42 <原路径>`；去掉对超搭云 repository/计费/会话的直接依赖，改成注入接口；补齐单测。

| 原文件 | 新位置 | 适配要点 |
|---|---|---|
| `backend/screenwriter/prompts.js` `tools.js` `index.js`（sanitize/reclassify 部分） | `engine/screenplay/` | 拆出「剧本→方案」和「资产锁定后→制作版分镜」两段调用；新增角色卡/场景图提示词字段 |
| `backend/agent/llm.js` `agent/skills/wan-video.js` `storyboard.js` | `engine/llm/` `engine/skills/` | LLM 配置走本项目环境变量 |
| `backend/screenwriter/extract.js` | `engine/extract/` | txt/docx 文本提取 |
| `modelhub-models.js` `aimasker-models.js`、Aiide 相关、`backend/providers.js`（只取需要的分支） | `engine/providers/<id>.js` | 统一适配器接口：`prepare / validate / submit / query / normalize / authHeaders / pricing`，用注册表管理，不再写 if 链 |
| `backend/video-transfer.js` `backend/media-proxy.js` | `engine/transfer/` | 镜头视频转存对象存储 |
| `network-safety.js` | `engine/net/` | SSRF/大小/超时，保持可注入模拟网络 |
| `backend/object-storage.js` `storage/qiniu-kodo.js` | `engine/storage/` | 只保留 S3 兼容通用实现 |
| `backend/screenwriter/editor.js`（concat 部分） | `render/` | 由 Render 角色扩展字幕、BGM、水印、封面 |
| `backend/billing.js`（账本思想） | `wallet/` | **按本项目表结构重写**，只沿用规则：整数分、预占/结算/退回、幂等键、事务短小 |
| `backend/screenwriter/one-click.js`（状态机思想） | `projects/` + `queue/` | 重写为带确认点、可暂停的状态机，由 jobs 驱动 |

## 4. 数据模型（草案，BE-Core 落地时可细化，结构性变化须走变更申请）

```
users(id, phone UNIQUE, nickname, status, created_at)
sessions(token_hash PK, user_id, csrf_token, expires_at)
sms_codes(phone, code_hash, expires_at, attempts)
wallets(user_id PK, available_fen, frozen_fen)
ledger(id, user_id, kind[recharge|redeem|reserve|settle|refund|adjust], amount_fen, ref_type, ref_id, idempotency_key UNIQUE, created_at)
price_versions(id, rules_json, created_at)
quotes(id, user_id, kind[project|asset_version|shot_take|render], params_hash, amount_fen, price_version_id, expires_at, consumed_at)
redeem_codes(code_hash PK, amount_fen, expires_at, used_by, used_at)

projects(id, user_id, title, source_type[text|file|idea], source_text, options_json, mode[auto|guided],
         status, paused_from, error_json, quote_id, created_at, updated_at)
plans(project_id PK, version, logline, synopsis, scenes_json, notes, updated_at)
project_assets(id, project_id, kind[character|scene|prop], name, spec_json, selected_version_id, locked_at)
asset_versions(id, asset_id, source[generated|uploaded], gen_task_id, image_url, status, created_at)
shots(id, project_id, idx, duration_s, voiceover, prompt, asset_refs_json, selected_take_id)
shot_takes(id, shot_id, source[generated|uploaded], gen_task_id, video_url, status, created_at)
renders(id, project_id, takes_snapshot_json, options_json, output_url, cover_url, status, created_at)

gen_tasks(id, user_id, project_id, kind[llm|image|video], provider, upstream_id, status, request_json,
          result_json, error_json, idempotency_key UNIQUE, next_poll_at, created_at, updated_at)
jobs(id, type, payload_json, run_at, attempts, locked_by, locked_until, status, last_error)
audit_logs(id, actor_id, action, target, outcome, request_id, detail_json, created_at)
```

- 时间列用 `timestamptz`，JSON 列用 `jsonb`，布尔用 `boolean`（不重复超搭云的 SQLite 遗留写法）。
- 「替换」只新增 `asset_versions` / `shot_takes` 行，再改 `selected_*_id`。

## 5. 关键机制

- **队列**：`jobs` 表，Worker 用 `SELECT … FOR UPDATE SKIP LOCKED` 领取，带租约（`locked_until`），超时可被重新领取；失败指数退避。
- **状态推进**：每次状态迁移都是一个短事务（校验当前状态 → 写新状态 → 写事件 → 入队下一个 job）。
- **上游轮询**：`gen_tasks.next_poll_at` 控制节奏；429/网络错误退避；终态不再请求上游。
- **进度推送**：API 进程从 PG `LISTEN/NOTIFY` 读取项目事件转 SSE；客户端断线后用 `GET /projects/:id` 补齐状态。
- **一致性**：资产锁定后，制作版分镜把选中的资产版本图片作为参考输入（具体用图生视频还是多参考，由 M0 结论决定，适配器层可切换）。

## 6. 安全

- Cookie 会话（HttpOnly、SameSite=Lax、Secure），写操作需 `X-CSRF-Token` 并校验 Origin。
- 短信与登录限流放 PG（按手机号 + IP）。
- 上传：类型白名单、大小上限、内容审核（M3）；下载与转存只经过 `engine/net`。
