# 架构设计（v1.0，2026-10-16，对应 PRD v2.2）

## 1. 总览

```
浏览器（手机 / PC）
  apps/web  Vue 3 + Vant 4，响应式
      │  HTTPS JSON + Cookie 会话 + CSRF 头；进度用 SSE（断线降级为轮询）
      ▼
server  API 进程（src/app.js）            server  Worker 进程（src/worker.js，同一份代码）
  认证 / 钱包 / 报价 / 资产库 / 作品         领取 jobs → 推进作品状态机
      │                                      ├─ engine：pi agent（故事理解/片段规划/提示词）、
      │                                      │          图片/视频渠道、七牛存储、转存、网络安全
      ▼                                      └─ render：FFmpeg 拼接、响度、AI 标识、封面、尾帧
PostgreSQL（唯一业务数据源 + 任务队列 + 限流 + LISTEN/NOTIFY 事件）
七牛 Kodo（私有空间 + 签名链接）：参考照片、形象图、音色素材、片段视频、成片、封面
```

- 部署：Docker Compose 4 个服务：`web`（Nginx 托管静态文件并反代 `/api`）、`api`、`worker`、`postgres`。
- 单 Worker 起步；队列支持横向增加 Worker。FFmpeg 只在 Worker 镜像中安装。
- M1~M2 不引入 Redis。

## 2. 目录结构

```
mini-ai-video/
├─ AGENTS.md / CODEX_HANDOFF.md / README.md / NOTICE
├─ docs/                PRD、ARCHITECTURE、API、UI、TASKS；archive/ 存历史版本
├─ apps/web/            前端（Vue），见 docs/UI.md
├─ server/
│   ├─ src/
│   │   ├─ app.js        API 组装入口（BE-Core 独占）：createApp(deps) 便于测试注入
│   │   ├─ worker.js     Worker 入口（BE-Core 独占）：注册 job 处理器、循环领取
│   │   ├─ config.js     环境变量解析（唯一读取 process.env 的地方）
│   │   ├─ http/         错误类型、requestId、错误中间件、asyncHandler、校验工具
│   │   ├─ db/           pg 连接池、事务（嵌套 savepoint）、迁移执行器
│   │   ├─ auth/         手机号验证码、会话、CSRF、限流
│   │   ├─ wallet/       账本、SKU 定价、报价、预占/结算/退回、兑换码
│   │   ├─ payments/     易支付适配（签名/验签/客户端）与充值订单、回调、对账（M3）
│   │   ├─ catalog/      风格、画质档位、音色、运营配置（settings）
│   │   ├─ characters/   数字资产库（数字人、照片、形象、版本）
│   │   ├─ projects/     作品、角色表、片段、版本、成片、状态机、保存期
│   │   ├─ queue/        jobs 领取、租约、退避、定时任务
│   │   ├─ api/          路由（只做参数校验与调用 service）
│   │   ├─ engine/       生成引擎（Engine 角色，见 §4）
│   │   └─ render/       FFmpeg 合成（Render 角色，见 §5）
│   ├─ migrations/       001-init.sql 起，按编号顺序执行，已发布的迁移不再修改
│   └─ test/             node --test；test/helpers/ 放测试库与模拟上游
└─ deploy/               compose（测试 / 生产）、Dockerfile、备份脚本
```

## 3. 数据模型（`server/migrations/001-init.sql` 为准）

时间列 `timestamptz`，JSON 列 `jsonb`，金额 `bigint`（分），ID 为带前缀的 `text`。

**账号与钱包**

```
users(id, phone UNIQUE, nickname, avatar_key, status, tour_completed_at, tips_seen text[], created_at)
sms_codes(id, phone, code_hash, expires_at, attempts, consumed_at, created_at)
sessions(token_hash PK, user_id, csrf_token, expires_at, created_at)
rate_counters(key, window_start, count, PK(key, window_start))       -- 短信、登录、免费故事理解等
wallets(user_id PK, available_fen ≥0, frozen_fen ≥0, updated_at)
ledger(id, user_id, kind, amount_fen, frozen_delta_fen, title, ref_type, ref_id, idempotency_key UNIQUE, created_at)
redeem_codes(code_hash PK, amount_fen, expires_at, used_by, used_at)
```

**计价与目录**

```
skus(id, sku_code, version, kind[video|image|llm], model, channel, resolution, unit[second|image|ktoken],
     price_fen, cost_fen, durations int[], with_audio, audio_ref, status, effective_at, UNIQUE(sku_code, version))
quality_tiers(id, name, note, sort, status)
tier_mappings(id, tier_id, version, video_sku_code, effective_at, UNIQUE(tier_id, version))
styles(id, name, description, cover_key, prompt_hint, sort, status)
voices(id, name, category, gender, age_group, description, sample_key, ref_audio_key, language, sort, status)
settings(key PK, value jsonb, updated_at)
  -- max_duration_seconds=90, daily_free_understanding=20, retention_days=90, expiry_remind_days=7,
  -- look_image_sku_code, quote_ttl_seconds=900, min/max_story_chars
quotes(id, user_id, kind, ref_type, ref_id, params_hash, amount_fen, breakdown, price_snapshot, expires_at, consumed_at, created_at)
```

- SKU 调价：新增一行（version+1），旧行保留；报价记录 `price_snapshot`（sku_code+version+单价）。
- 档位映射同理；作品创建时锁定 `tier_mapping_id`。

**支付（M3，PRD 6.4）**

```
payment_orders(id po_, user_id, channel 'ezfp', out_trade_no UNIQUE (= id), trade_no, api_trade_no,
               amount_fen, pay_type[alipay|wxpay], device[pc|mobile], status[created|paid|expired|failed],
               client_ip, expires_at, paid_at, credited_ledger_id, notify_count, last_notify jsonb,
               created_at, updated_at)
  -- 索引：(user_id, created_at DESC)；(status, expires_at) WHERE status = 'created'（对账扫描）
```

- 新增迁移 `NNN-payments.sql`（编号取当时最大号加 1，不改 001）；`newId` 前缀表加入 `po`。
- 入账：事务里 `UPDATE payment_orders SET status='paid', paid_at=now() WHERE id=$1 AND status IN ('created','expired')`，影响 1 行才继续写账本 `recharge`（幂等键 `recharge:<orderId>`），同一事务内完成，重复通知命中 0 行直接返回 `success`。
- 金额在边界转换：我方整数分 ⇄ 易支付元字符串（字符串解析 + 整数运算，不经过浮点）。

**数字资产库**

```
uploads(id, user_id, kind, storage_key, mime, size_bytes, referenced_at, created_at)
characters(id, user_id, name, tags text[], description, default_voice_id, deleted_at, created_at, updated_at)
character_photos(id, character_id, upload_id, sort)
character_looks(id, character_id, style_id, selected_version_id, UNIQUE(character_id, style_id))
look_versions(id, look_id, status, gen_task_id, image_key, view_keys text[], error, created_at)
```

**作品**

```
projects(id, user_id, title, story_text, source_type, style_id, quality_tier_id, tier_mapping_id, ratio,
         status, paused_from, error jsonb, progress jsonb, story jsonb,          -- story = StoryResult + 规划原始输出
         selected_character_ids text[],                                          -- 首页托盘勾选
         delivered_at, expires_at, deleted_at, created_at, updated_at)
project_cast(id, project_id, idx, name, description, gender, age_group, character_id, match_source,
             look_version_id, voice_id, voice_source, locked_at)
segments(id, project_id, idx, duration_seconds, plot, camera_notes, dialogue jsonb, ambience, transition,
         cast_ids text[], final_prompt jsonb, selected_take_id)
segment_takes(id, segment_id, status, gen_task_id, video_key, poster_key, last_frame_key, error, created_at)
renders(id, project_id, takes_snapshot jsonb, status, video_key, cover_key, duration_seconds, error, created_at)
project_events(id bigserial, project_id, status, progress jsonb, changed text[], created_at)  -- SSE 补发
```

**任务与审计**

```
gen_tasks(id, user_id, kind[llm|image|video], sku_code, provider, upstream_id, status, request jsonb, result jsonb,
          error jsonb, cost_fen, idempotency_key UNIQUE, next_poll_at, created_at, updated_at)
jobs(id bigserial, type, payload jsonb, dedupe_key UNIQUE NULLS DISTINCT, run_at, attempts, max_attempts,
     status[queued|running|done|failed], locked_by, locked_until, last_error, created_at, updated_at)
audit_logs(id, actor_id, action, target, outcome, request_id, detail jsonb, created_at)
```

- 替换类操作只新增 `look_versions` / `segment_takes` / `renders` 行，再改 `selected_*`，永不覆盖。
- 作品到期清理：删除七牛上的片段与成片视频对象、清空 `*_key`，作品记录、封面保留。

## 4. 作品状态机与任务

```
POST /projects ──► understanding ──job:project.understand──► story_review (◆A)
story_review ──reanalyze──► understanding
story_review ──confirm-story(looks>0, 扣形象费)──► casting ──job:look.generate×N──► cast_review (◆B)
story_review ──confirm-story(looks=0)──► cast_review
cast_review ──confirm-cast(预占视频费)──► rendering
rendering: job:project.bind_prompts → job:segment.generate（尾帧衔接的片段按顺序，其余并行）→ job:gen.poll
         → 全部成功 ──job:project.compose──► composing ──► delivered（写 delivered_at / expires_at）
delivered ──segment take / selection──► 重新 compose（status 保持 delivered）
delivered ──cron:projects.expire_sweep──► expired
进行中 ──pause──► paused ──resume──► pausedFrom
任意步骤失败 ──► failed ──retry──► 失败步骤
任意非终态 ──cancel──► canceled（未提交片段退回预占）
```

- 每次迁移是一个短事务：校验当前状态 → 写新状态与 `project_events` → 入队下一个 job → `NOTIFY project_events`。**事务内不调用上游网络**。
- 片段生成：提交前写 `gen_tasks`（幂等键 = take id），提交成功写 `upstream_id`；提交结果未知 → take `unknown`，冻结金额，不自动重提。
- 上游轮询：`gen_tasks.next_poll_at` 控制节奏；429/网络错误退避；终态不再请求。

**job 类型**

| type | 负责模块 | 说明 |
|---|---|---|
| `project.understand` | projects + engine.story | 故事理解 + 片段规划 + 角色匹配 + 音色推荐 |
| `look.generate` | characters + engine.providers | 生成一个形象版本 |
| `project.bind_prompts` | projects + engine.story | 绑定形象/音色，生成每段最终提示词 |
| `segment.generate` | projects + engine.providers | 提交一个片段版本 |
| `gen.poll` | engine.providers | 轮询上游、转存七牛、结算 |
| `project.compose` | projects + render | 拼接成片、封面 |
| `projects.expire_sweep` | projects（定时） | 到期清理 |
| `uploads.sweep` | uploads（定时） | 清理 24 小时未引用的上传 |
| `payments.reconcile` | payments（定时，M3） | 查询超过 5 分钟未到账的订单：已支付补入账，已过期关单 |

## 5. 模块接口（跨角色契约，改动走变更申请）

所有外部依赖通过参数注入，测试用模拟实现，**不产生真实费用**。

**engine.story（Engine 角色）**

```js
understand({ storyText, style, maxSeconds, allowedDurations, characters /* 用户勾选+资产库摘要 */, voices })
  → { title, synopsis, compressed, notice?, cast: [{ name, description, gender, ageGroup, characterId?, voiceId? }],
      segments: [{ durationSeconds, plot, cameraNotes, dialogue: [{ castIndex, line }], ambience, transition, castIndexes }] }
bindPrompts({ style, ratio, segments, cast /* 含形象图 key、音色参考音频 key */, voicesEnabled })
  → [{ segmentIndex, prompt, imageRefs: string[], audioRefs: string[], firstFrame?: 'prev_tail' }]
```

- `allowedDurations` 来自档位映射的视频 SKU；返回的每段时长必须在其中，总时长 ≤ `maxSeconds`，由调用方再校验一次。
- 只有 1 个片段时 `voicesEnabled=false`，`audioRefs` 为空。

**engine.providers（Engine 角色）**：注册表，每个适配器实现

```js
{ id, kind, prepare(input, sku), submit(prepared, { idempotencyKey }), query(upstreamId), normalize(raw) }
// normalize → { status: 'running'|'succeeded'|'failed', outputs?: [{ url, kind }], error? }
```

**engine.storage / engine.transfer / engine.net（Engine 角色）**

```js
storage.put(key, stream|buffer, { contentType }) · storage.signedUrl(key, { ttlSeconds, download? }) · storage.remove(keys)
transfer.fromUrl(url, key, { maxBytes, timeoutMs })   // 上游临时链接 → 七牛，经 net 做 SSRF/大小/超时检查
```

**render（Render 角色）**

```js
compose({ inputs: [{ localPath, transition }], ratio, resolution, watermarkText }) → { outputPath, coverPath, durationSeconds }
extractLastFrame(videoPath) → imagePath     // 尾帧衔接
```

- 拼接：响度统一（EBU R128）、硬切 / 尾帧衔接、H.264 + AAC MP4、显式 AI 生成标识 + 元数据隐式标识。**不加 BGM、不加字幕**。

## 6. 引擎复用清单（来源：`/root/chaodayun` @ `2926b42`）

迁移规则：复制到 `server/src/engine/`，文件头注明 `// Source: chaodayun@2926b42 <原路径>`；去掉对超搭云 repository/计费/会话的依赖，改为注入；补齐单测。**不得修改 `/root/chaodayun`**。

| 原文件 | 新位置 | 适配要点 |
|---|---|---|
| `backend/screenwriter/prompts.js` `tools.js` `index.js` | `engine/story/` | 改为「故事理解+片段规划」与「绑定提示词」两段；输出按 §5 结构；新增音色推荐 |
| `backend/agent/llm.js`、pi agent 接入、`agent/skills/wan-video.js` `storyboard.js` | `engine/llm/` `engine/skills/` | 配置走本项目环境变量；30 秒多镜头提示词规范 |
| `backend/screenwriter/extract.js` | `engine/extract/` | txt/docx 文本提取 |
| `modelhub-models.js` 等渠道代码 | `engine/providers/<id>.js` | 统一适配器接口，注册表管理；支持图片 + 音频参考、首帧 |
| `backend/video-transfer.js` `media-proxy.js` | `engine/transfer/` | 上游结果转存七牛 |
| `network-safety.js` | `engine/net/` | SSRF/大小/超时，可注入模拟网络 |
| `backend/object-storage.js` `storage/qiniu-kodo.js`（仅参考） | `engine/storage/` | **七牛原生协议**（用户 2026-10-17 决定：比 S3 兼容更轻量、零额外依赖）：小对象表单上传（上传凭证）、大对象分片上传 v2（有界内存）、管理凭证删除、私有空间签名下载链接（同步生成）；官方文档：上传凭证 `kodo/1208/upload-token`、表单上传 `kodo/1272/form-upload`、管理凭证 `kodo/1201/access-token`、下载凭证 `kodo/1202/download-token`、分片上传 v2 `kodo/6364/multipartupload-interface` |
| `backend/screenwriter/editor.js`（concat） | `render/` | 扩展响度、尾帧、AI 标识、封面 |
| `backend/billing.js`（思想） | `wallet/` | 按本项目表结构重写，只沿用规则 |
| `backend/screenwriter/one-click.js`（思想） | `projects/` + `queue/` | 重写为带两个确认点的状态机 |

## 7. 安全

- Cookie 会话（HttpOnly、SameSite=Lax、生产 Secure），写操作需 `X-CSRF-Token` 并校验 Origin。
- 短信、登录、免费故事理解的限流放 PG（`rate_counters`）。
- 所有对象按 `user_id` 隔离；查询一律带 `user_id` 条件，查不到返回 404（不区分「不存在」和「无权」）。
- 上传：类型白名单（校验文件头）、大小上限；下载与转存只经过 `engine/net`。
- 日志脱敏：手机号、验证码、Cookie、签名链接不入日志。
- **支付（M3）**：商户私钥、平台公钥、商户 ID 只来自环境变量（`EZFP_BASE_URL`、`EZFP_PID`、`EZFP_MERCHANT_PRIVATE_KEY`、`EZFP_PLATFORM_PUBLIC_KEY`，另需 `PUBLIC_API_BASE_URL` 与 `WEB_BASE_URL` 生成回调与跳转地址），仓库公开，不得入库；缺少任一项时支付功能关闭（`payTypes` 为空），不影响其他功能；生产环境回调地址必须是公网 HTTPS。
- 支付适配器接口 `createEzfpClient({ baseUrl, pid, merchantPrivateKey, platformPublicKey, http, now })` → `{ create, query, close, refund, verifyNotify }`，签名与验签是纯函数；`http` 可注入，测试用**模拟易支付服务**和本地生成的 RSA 密钥对，不产生真实支付。
- 回调处理顺序固定：验签 → `trade_status` → `pid` → 订单存在 → 金额一致 → 主动查单核验 → 事务入账；任何一步失败都不入账并写审计日志。验签要兼容平台新增字段（以收到的全部非空参数参与）。
