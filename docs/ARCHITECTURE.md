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
rendering: job:project.bind_prompts → job:segment.generate（**全部片段按顺序串行**，用户 2026-10-19 决定；并行是 M0 对比之后的优化）→ job:gen.poll → 转存 → render.inspect（基础技术检查，不通过 → 该片段失败，作品进入 failed；**该段预占保持冻结**，用户免费重试时沿用并在成功后结算，取消时退回全部未结算部分；见 CODEX_HANDOFF §3 2026-10-20）→ 提取尾帧 → 下一段
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

**engine.story（Engine 角色）**——提示词设计与每个字段的规则见 [docs/skills/wan-3.0.md](./skills/wan-3.0.md)（按视频模型一个 Skill）

```js
expandIdea({ idea, style, maxSeconds, allowedDurations, characters, skillId, signal, timeoutMs })   // 仅当输入被判为「一句话想法」时调用；免费
  → { title, script /* 中文剧本全文：场景、动作、对白（可创作）；长度与目标时长匹配 */, usage, degraded }
understand({ storyText /* 剧本；想法已先扩写 */, inputKind, expanded, style, maxSeconds, allowedDurations, characters /* 用户勾选+资产库摘要 */, voices, skillId, signal, timeoutMs })
  → { title, script, inputKind, expanded, synopsis, compressed, notice?, degraded, usage,
      bible: { characters: [{ castIndex, handle, brief }],          // 英文，唯一简称 + 身份级外观，一经写出不再改
               scenes:     [{ id, nameZh, description }],            // 英文固定场景描述
               props:      [{ id, nameZh, description }] },
      cast: [{ name, description, gender, ageGroup, characterId?, voiceId? }],
      segments: [{ durationSeconds, plot, cameraNotes, dialogue: [{ castIndex, line }], ambience, transition, castIndexes,
                   sceneId, propIds, endState /* 英文，本段最后一帧的状态 */,
                   takeMode /* 'multi_shot'(默认)|'single_take'(一镜到底，豁免逐镜头 3~8 秒上限) */ }] }
bindPrompts({ style, ratio, segments, cast /* 含形象图 key、音色参考音频 key */, bible, voicesEnabled, skillId, maxImageRefs, signal, timeoutMs })
  → [{ segmentIndex, prompt, imageRefs: string[], audioRefs: string[], usePrevTail: boolean,
       startState, endState, shots, skillId, skillVersion, degraded }]
  -- 全能参考（omni_reference）模式：usePrevTail 为 true 时，调用方在生成该片段前先取上一段尾帧，作为普通参考图放入 imageRefs（尽力而为，不保证首帧衔接）
```

- `allowedDurations` 来自档位映射的视频 SKU；返回的每段时长必须在其中，总时长 ≤ `maxSeconds`，由调用方再校验一次。
- 只有 1 个片段时 `voicesEnabled=false`，`audioRefs` 为空。
- **输入判定**（`classifyInput(text)`，确定性，阈值可配置，默认约 60 字且无对白与场景描述为「想法」）在 `project.understand` job 里先于 LLM 调用；「想法」先 `expandIdea` 再 `understand`，「剧本」直接 `understand`；用户在确认点 A 编辑后重新整理的文字一律按「剧本」处理。`script` 保存在 `projects.story.script`，`projects.story_text` 保持用户原始输入。
- 剧本模式忠实处理：**不新增对白**、不新增原文没有的人物与场景；想法模式的对白由 `expandIdea` 创作，之后 `understand` 按剧本模式忠实处理这份扩写结果。
- **设定集（`bible`）在故事理解时生成一次，保存到 `projects.story.bible`，之后只读**；最终提示词中的风格、场景、道具、人物外观、连贯性、写实与避坑模板由**代码逐字注入**，不经过 LLM 改写；LLM 只写每段的镜头时间线（英文）。对白由代码逐字校验（不新增、不改写、不丢、顺序不变）。
- `startState` 是上一段的 `endState`（仅 `transition: 'prev_tail'` 时有值）；`segments.final_prompt`（jsonb）保存 `{ prompt, imageRefs, audioRefs, usePrevTail, startState, endState, shots, skillId, skillVersion, degraded }`，无需新增数据库列。
- `skillId` 由调用方按视频 SKU 的 `model` 选择（`skills.forModel(model)`），Skill 文件在 `server/src/engine/skills/`。

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
extractLastFrame(videoPath) → imagePath     // 尾帧作为下一段的参考图
inspect(videoPath, { durationSeconds, ratio, resolution, expectAudio }) → { ok, issues: [{ code, message }] }
  // 基础技术检查：可解码、有视频流、有音频流、时长偏差 ≤2 秒、画幅与分辨率、非全黑（blackdetect）、非长时间卡住（freezedetect）、非静音（volumedetect）；全部用 FFprobe/FFmpeg，不调用任何模型
```

- 拼接：响度统一（EBU R128）、硬切 / 尾帧衔接、H.264 + AAC MP4、显式 AI 生成标识 + 元数据隐式标识。**不加 BGM、不加字幕**。

### 5.5 上游渠道层（多渠道 + 管理员热切换，用户 2026-10-23；同日决定改回「渠道配置由数据库管理」）

**目标**：视频 / 图片 / 文本 LLM 各自可配置多个上游渠道；渠道会**频繁新增、删除**，且各家协议 / SDK 不同。渠道坏了、换了，管理员在后台改配置即可恢复，**不改业务代码、不发版**；前端不暴露渠道名称与细节（只显示业务化的中文故障原因）。

**两个概念必须分开（代码干净的关键）**：
- **驱动 driver（代码）**：一种上游**协议**对应一个驱动，例如 `modelhub`、`openai-compatible`、某厂商私有协议。新增协议 = 新增一个驱动目录，其余代码不动。
- **渠道 channel（数据）**：一条数据库记录 = 某个驱动 + 地址 + 密钥 + 模型映射 + 参数。**同协议的多个供应商（含你经常换的聚合商）只是多条渠道记录，零代码**。
- 因此“频繁新增删除渠道”绝大多数是数据库操作；只有“出现全新协议”才写一个驱动文件。

**分层**（业务代码只依赖上层，不认识任何渠道或 SDK）：

```
业务层：档位 → 逻辑能力 capability（video.480p、image.look、llm.story）；SKU 定价与档位映射不变
路由层：channelRouter.pick(capability) → 生效渠道（有序列表，管理员可改）
渠道层：provider_channels 记录 → registry.create(记录) → 驱动实例（统一接口）
驱动层：drivers/<protocol>/ ，各自封装该协议的鉴权 / 请求 / 响应 / 错误映射
```

**数据模型**（迁移新增）：
- `provider_channels(id pch_, kind[video|image|llm], name, driver, base_url, credential_enc, model_map jsonb, params jsonb, cost_fen jsonb, status[active|disabled|retired], remark, created/updated)`；`credential_enc` 用环境变量主密钥 `CHANNEL_SECRET_KEY` 做 AES-256-GCM 加密存库，**任何 API 不回传明文，只返回后 4 位掩码**，日志脱敏。`retired` = 软删除。
- `channel_routes(kind, capability, channel_id, rank)`；`channel_events(...)` 成功率 / 延迟 / 错误码摘要；`admin_audit_logs(...)` 每次改动留痕；`admin_users`；`gen_tasks.channel_id`（提交时绑定，轮询 / 取消 / 对账回原渠道）。
- **删除渠道 = 软删除 `retired`**：不再被选中、后台默认不显示；仍被 `gen_tasks` 引用，**在途任务清空前凭证保留并可轮询**，之后凭证可清除；历史任务的渠道名保留供对账。从不物理删除被引用的渠道。
- 启动引导：首次部署时，`MODELHUB_*` / `LLM_*` 等环境变量作为“种子渠道”写入（仅表为空时）；此后以数据库为准。

**驱动规范（让新增驱动干净、可复制）**：

目录（每个协议自成一个目录，删驱动 = 删目录）：
```
server/src/engine/providers/
  contract.js        统一接口、能力描述类型、ProviderError、错误分类（唯一的公共约定）
  registry.js        启动时扫描 drivers/*/index.js 自动注册；校验导出形状；按 driver id 创建实例
  transport.js       共用 HTTP 层：safeFetch(SSRF/大小/超时)、统一重试与脱敏日志
  contract-test.js   所有驱动必须通过的契约测试套件
  drivers/
    modelhub/        index.js · fixtures/ · driver.test.js · README.md（协议要点 + 官方文档链接）
    openai-compatible/
    <新协议>/
```

驱动导出（单文件入口，形状固定）：
```js
export default {
  id: 'modelhub',
  kinds: ['video', 'image'],
  configSchema: { baseUrl: 'url', credential: 'secret', params: {...} },   // 后台表单与校验的唯一来源
  create(channel, { http, logger }) → {
    capabilities(): { video?: { durations, resolutions, ratios, refImages, refAudio, withAudio }, image?: {...}, llm?: {...} },
    prepare(input, sku) · submit(prepared, { idempotencyKey }) · query(upstreamId) · normalize(raw),
    catalog?(): 免费目录 / 单价（供“测试连接”核对），
  },
}
```

硬性约束：
1. **不引入厂商 SDK**，一律走 `transport` 的 HTTP；需要签名（如 HMAC）写在驱动内部。理由：SDK 各有依赖、重试与错误模型，混用会让依赖树和错误处理失控；统一 HTTP 层便于 SSRF、超时、脱敏、录制回放。
2. **厂商差异只能留在驱动内**：参数名、状态码、错误码、分页、鉴权方式；对外只暴露统一的 `normalize` 结果 `{ status, outputs, error }` 和统一错误。业务层出现“厂商名”或厂商错误码即视为缺陷。
3. **错误统一分类**（`ProviderError`）：`submitted: true | false | unknown`、`retryable`、`code ∈ {AUTH, RATE_LIMITED, UNAVAILABLE, BAD_REQUEST, CONTENT_BLOCKED, UPSTREAM_FAILED, TIMEOUT, UNKNOWN}`。故障转移与资金处理只看这几个字段，不看原始文本。
4. **能力用声明表达，不在业务里 `if (driver === ...)`**：时长、分辨率、画幅、参考图 / 音频上限、是否出声，全部由 `capabilities()` 返回；Skill 与 `render.inspect` 据此约束。
5. **每个驱动必带录制夹具与契约测试**：`fixtures/` 存真实响应的脱敏样本；运行 `contract-test.js`（提交成功、明确失败 `submitted=false`、超时 `unknown`、查询 running / succeeded / failed、输出归一化、错误信息与日志不含密钥），无需真实费用即可 CI。
6. **脚手架**：`npm run driver:new -- <protocol>` 生成骨架（入口、configSchema、夹具目录、契约测试接线、README 模板），新增协议只需填空。
7. **驱动缺失不炸系统**：库里的渠道指向不存在的驱动（例如删了驱动目录）时，该渠道被标记 `unavailable`、跳过路由并告警；在途任务保持原状，不退款、不重提。

**规则（资金安全优先）**：
1. **切换只影响新提交**：在途任务继续用原渠道轮询到结束；停用 / 软删除的渠道仍可被 `gen.poll` 使用，直到在途清空。
2. **绝不因切换而重提**：`unknown` 仍冻结待对账；故障转移只发生在**提交前即可确定“没发出去”**（`submitted=false`）的错误。
3. **不做自动故障转移（用户 2026-10-24 决定）**：渠道故障时不自动切换，也不做定时探活；提交失败直接让用户看到明确的中文原因（如「视频生成服务暂时不可用」），上游原始错误放该作品的「技术详情」折叠区；由管理员手动切换渠道（命令行或后台）。只统计真实请求产生的成功率 / 失败数用于查看，不额外发探测请求。
4. **成本与定价分离**：用户价由 SKU 决定；渠道成本写 `gen_tasks.cost_fen`；备用渠道成本更高 / 高于用户价时后台醒目标出。
5. **同作品内渠道可变**：参考素材皆 URL 传递；切换时提示画面风格可能略有差异。
6. **体检**：“测试连接”走驱动 `catalog()`（免费），核对模型是否存在、单价是否与成本一致；“试生成”真实计费，二次确认并审计。
7. **可观测**：近 1 小时成功率 / 失败数 / 平均排队 / 在途数；连续失败告警。

**运营视角（用户非程序员；痛点：为低价使用的中转站不稳定）**：
- **一目了然的模型**：每个渠道 = `drivers/` 下的一个目录（代码）；每种能力（视频 / 图片）任一时刻只有**一个生效渠道**，其余是「备用」（备用只是已登记、可手动切换的渠道，不会自动启用）。LLM 渠道稳定，默认不动。
- **换渠道三步，不碰代码**：①（新协议才需要）让开发 Agent 加一个驱动目录；②在后台或命令行登记渠道（填地址、密钥）；③`channel:test` 通过后，`channel:use video <名字>` 设为生效，只影响之后的新提交，在途任务不受影响。
- **故障时**：用户立即看到明确的中文原因，管理员看日志 / `channel:list` 里的近期失败数后手动切换。用户付费不受影响（按 SKU 用户价；提交前失败不扣费、失败预占退回或按 A 口径冻结待重试）。
- **费用保护**：用户钱永远按 SKU 用户价计费，不受渠道价格影响；备用渠道成本高于用户价时，`channel:list` 与后台红色标出。
- **中转站固有风险**：价格会不通知上调、模型会被悄悄降级、站点会跑路或封号；账户余额不足也是常见故障。现有的调价对账 cron 会核对成本；建议至少登记 2 个来自不同供应商的视频渠道备着。

**管理端 API**：`docs/API.md` §8（`/api/admin/*`，独立管理员账号与会话）。UI 在运营后台（M3-ADM-01）；此前可用 API / 脚本应急。

## 6. 引擎复用清单（来源：`/root/chaodayun` @ `2926b42`）

迁移规则：复制到 `server/src/engine/`，文件头注明 `// Source: chaodayun@2926b42 <原路径>`；去掉对超搭云 repository/计费/会话的依赖，改为注入；补齐单测。**不得修改 `/root/chaodayun`**。

| 原文件 | 新位置 | 适配要点 |
|---|---|---|
| `backend/screenwriter/prompts.js` `tools.js` `index.js` | `engine/story/` | 改为「故事理解+片段规划」与「绑定提示词」两段；输出按 §5 结构；新增音色推荐 |
| `backend/agent/llm.js`、pi agent 接入、`agent/skills/wan-video.js` `storyboard.js`（仅参考） | `engine/llm/` `engine/skills/<model>.js` | 配置走本项目环境变量；**每个视频模型一个 Skill**（提示词、拼装模板、校验、默认值），主力 `wan-3.0`，设计见 `docs/skills/wan-3.0.md` |
| `backend/screenwriter/extract.js` | `engine/extract/` | txt/docx 文本提取 |
| `modelhub-models.js` 等渠道代码（仅参考） | `engine/providers/<id>.js` | 统一适配器接口，注册表管理；视频用「全能参考」模式（图片 + 音频参考）；**渠道不绑定 Modelhub**，上线渠道以 M0 结论为准，新增渠道只需新增适配器 |
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
