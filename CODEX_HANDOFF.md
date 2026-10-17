# CODEX_HANDOFF — 多 Agent 协作同步

> 所有 Agent 开工前先读本文件，结束时更新本文件。规则见 [AGENTS.md](./AGENTS.md) §8。
> 本文件只追加和更新状态，**不要删除他人的记录**。
> 协作方式：Lead（Claude，本机）负责文档、审查与合并；开发 Agent 在另一台设备开发。双方只通过 GitHub 仓库 `huawuhen/mini-video` 和本文件同步，流程见 §0。

## 0. 跨设备协作流程（必读）

**角色分工**

| 谁 | 在哪 | 做什么 | 可以推送 |
|---|---|---|---|
| Lead（Claude） | 服务器 `/root/mini-ai-video` | 文档与接口契约、审查、合并到 `main`、与用户沟通 | `main`（只有 Lead） |
| 开发 Agent | 另一台设备 | 认领 `docs/TASKS.md` 的任务并实现、写测试、更新本文件 | 自己的 `agent/*` 分支 |

**开发 Agent 每个任务的固定步骤**

1. 同步：`git fetch origin && git switch main && git merge --ff-only origin/main`。
2. 读：`AGENTS.md` → 本文件（尤其 §2 认领表、§4 待确认、§6 审查记录里给你的意见）→ 任务相关的 `docs/*.md`。
3. 建分支：`git switch -c agent/<role>/<任务ID>-<简述> origin/main`，例如 `agent/be/M1-BE-01-auth`。一个任务一个分支。
4. 认领：在 §2 认领表把该任务改成「进行中」，填分支名，作为分支上的第一个提交。
5. 开发：一个功能 / 修复一个提交，提交信息写「背景 / 受影响模块 / 验证结果」。只改自己角色拥有的路径（AGENTS.md §2）；要改别人的路径或 `docs/API.md`，先在 §5 提变更申请。
6. 自测（全部通过才能推送）：
   ```bash
   npm ci
   npm run test:db:up && npm run test:server   # 后端
   npm run check && npm run build              # 前端（改了前端时）
   ```
7. 收尾：在 §7 变更记录**追加**一条（模板在文末），§2 状态改成「待审查」。
8. 推送：`git push -u origin agent/<role>/<任务ID>-<简述>`。然后告诉用户：「已推送 `<分支名>`，请 Lead 审查」。
9. 等待审查结果（§6）。需要修改时**在同一分支上追加提交**再推送，不要另开分支。

**硬性规则**

- 不推送 `main`；不 `push --force`（包括自己的分支）；不改写已推送的历史。需要跟上最新 `main` 时用 `git merge origin/main`，不要 rebase 已推送的分支。
- 本仓库是**公开仓库**：不提交任何密钥、`.env`、真实手机号、用户数据、上游临时链接；测试只用模拟上游。
- 不连接超搭云数据库或生产环境，不产生真实模型费用（AGENTS.md §6）。
- 遇到产品取舍（流程、文案、价格、范围）不要自己拍板，写进 §4「待用户确认」并在汇报里提出。
- 本文件冲突时保留双方内容（各段都是追加式的），不要删除对方记录。

**Lead 审查流程**

1. 收到通知后 `git fetch`，在独立 worktree 检出该分支（不在 `main` 工作区直接改）。
2. 检查：对照 PRD / `docs/API.md` / 任务验收标准逐项核对；代码审查（正确性、安全、事务边界、幂等、用户隔离、金额整数、错误码与中文文案）；重跑全部测试；涉及前端时用浏览器在手机 390 和 PC 1280 宽度走查。
3. 结果写在 §6：「✅ 通过并合并」或「🔁 需修改」+ 编号问题清单（文件:行号、原因、期望）。
4. 通过后 Lead 用 `git merge --no-ff` 合并进 `main` 并推送，§2 状态改为「✅ 完成」。

## 1. 状态看板

| 项 | 当前 |
|---|---|
| 阶段 | M1 可开工：PRD v2.2 定稿，主体框架（L-01~L-04）完成 |
| `main` 最新可用 | 文档 v1.0；`server` 骨架（config/http/db/迁移/全量表结构/PG 队列/catalog 接口）；`apps/web` v2（新流程 + 新手引导，mock 可完整演示） |
| 测试基线 | `npm run test:server` 26 通过；`npm run check`、`npm run build` 通过；Playwright mock 走查手机 390 / PC 1280 全流程无报错 |
| 阻塞项 | M0 需用户授权真实费用与上限（不阻塞 M1）；中文产品名未定 |

## 2. 认领表

| 任务 ID | 角色/Agent | 分支 / worktree | 涉及文件 | 状态 | 更新时间 |
|---|---|---|---|---|---|
| L-00 文档与 UI 骨架（v0.1，已被 L-01~L-04 取代） | Lead (Claude) | `main` | `docs/**` `AGENTS.md` `apps/web/**` | ✅ 完成 | 2026-10-15 |
| L-01 PRD 定稿与文档 v1.0 | Lead (Claude) | `main` | `docs/**` `AGENTS.md` | ✅ 完成 | 2026-10-16 |
| L-02 后端骨架 | Lead (Claude) | `main` | `server/**` | ✅ 完成 | 2026-10-16 |
| L-03 测试数据库 | Lead (Claude) | `main` | `deploy/compose.test.yml` 根 `package.json` | ✅ 完成 | 2026-10-16 |
| L-04 前端骨架 v2 | Lead (Claude) | `main` | `apps/web/**` | ✅ 完成 | 2026-10-16 |
| M1-BE-01 | BE-Core（本机开发 Agent） | `agent/be/M1-BE-01-auth` | `server/src/auth/**` `server/src/config.js` `server/src/app.js` `server/test/auth.test.js` `server/.env.example` | 待审查 | 2026-10-17 |
| M1-BE-02 ~ 06 | — | — | — | 待认领（BE-Core 串行） | — |
| M1-ENG-01 | — | — | — | 待认领（开发 Agent，可与 BE 并行） | — |
| M1-ENG-02 | — | — | — | 待认领 | — |
| M1-ENG-03 | — | — | — | 待认领 | — |
| M1-RND-01 | — | — | — | 待认领 | — |
| M1-WEB-01 | — | — | — | 待认领 | — |
| M1-WEB-02 | — | — | — | 待认领 | — |

状态取值：待认领 / 进行中 / 待审查 / 🔁 需修改 / ✅ 完成 / ⛔ 阻塞（写原因）。

**建议开工顺序**（只有一个开发 Agent 时）：M1-BE-01 → M1-BE-02 → M1-BE-03 → M1-ENG-01 / 02 / 03 → M1-BE-04 → M1-RND-01 → M1-BE-05 → M1-BE-06 → M1-WEB-01 / 02。ENG 与 BE 无代码依赖，有多个 Agent 时可并行。BE 系列必须串行，同一时间只开一个 BE 分支。

## 3. 决策记录（最新在上）

| 日期 | 决策 | 来源 |
|---|---|---|
| 2026-10-16 | 引擎迁移（M1-ENG-01~03）由开发 Agent 在其设备上完成，该设备有超搭云源码（以参考提交 `2926b42` 为准，路径按该设备实际位置）；超搭云代码可进入本公开仓库，无需保密、无需改私有 | 用户 |
| 2026-10-16 | **PRD v2.2 定稿**（`docs/PRD.md`）；单部作品最长 90 秒；其余标【默认】的细则后续再定，先按默认值实现且做成可配置 | 用户 |
| 2026-10-16 | Lead 负责主体框架与质量把关，主力开发由其他 Agent 完成；Lead 在现有仓库上重建（保留协作规则、令牌、布局、构建配置） | 用户授权，Lead 判断 |
| 2026-10-16 | 固定两个确认点（故事、角色），不提供全自动开关；总时长由 agent 决定；用户只选画质档位不选模型 | 用户 |
| 2026-10-16 | 计费按「模型 × 分辨率 × 秒」SKU；故事理解 LLM 费用平台承担；不加背景音乐和字幕 | 用户 |
| 2026-10-16 | 角色卡资产永久存七牛；作品视频存七牛保存 3 个月，前端提醒下载；首批 6 种风格确认 | 用户 |
| 2026-10-16 | 新增新手引导：首次注册登录展示聚光灯遮罩引导（Spotlight Tour / Coach Marks），见 PRD-v2 §5.8 | 用户 |
| 2026-10-16 | 新增音频素材库保证多片段声音一致：用户可试听选择，未选时 agent 自动引用，仅 1 个片段时不引用；「家庭成员/角色库」改名「我的数字资产库」（PRD-v2.1 §4.7 §4.1） | 用户 |
| 2026-10-16 | 视频模型默认支持图片与音频参考；音频素材（AI 生成/网络免费资源）不要求授权记录；数字资产可设默认声音；首批音色清单确认（PRD-v2.2） | 用户 |
| 2026-10-15 | 产品代号 Mini AI Video；中文名待定 | 用户 |
| 2026-10-15 | 收费：充值余额 + 按片预估扣费（整数分 CNY，预占/结算/退回） | 用户 |
| 2026-10-15 | 视觉：浅色清新风 | 用户 |
| 2026-10-15 | 平台：移动端优先，PC 端必须可用（响应式 H5） | 用户 |
| 2026-10-15 | 独立项目，账号/数据库/部署与超搭云完全隔离；复用超搭云引擎（复制到 `server/src/engine`） | 用户采纳 Lead 推荐 |
| 2026-10-15 | 技术栈：Vue3+TS+Vite+Vant4 / Node22+Express+PG（无 ORM，PG 队列）；M1~M2 不引入 Redis | Lead 推荐，用户采纳 |
| 2026-10-15 | 流程引入「资产锁定」：先确认角色/场景，再定稿分镜（借鉴影策短剧工作流） | Lead 推荐，用户采纳 |
| 2026-10-15 | 影策（open-ai-canvas, MIT）只借鉴设计，不作为底座 | Lead 推荐，用户采纳 |

## 4. 待用户确认

1. 中文产品名。
2. M0 技术验证的授权与费用上限。
3. PRD【默认】细则：首页价格区间估算方式、保存期从首次交付起算且替换片段不延长、到期前 7 天提醒、每天 20 次免费故事理解、新手引导步骤与文案。
4. 定价与 SKU 档位映射（M0 后给建议；当前为占位 mock 价：标准 0.20 元/秒、高清 0.40 元/秒、形象 0.50 元/个）。
5. 生成式 AI 备案主体（M3）。

## 5. 接口/跨域变更申请

| 日期 | 申请人 | 内容 | 影响 | 处理结果 |
|---|---|---|---|---|
| — | — | — | — | — |

## 6. 审查记录（Lead 填写，最新在上）

| 日期 | 分支 / 任务 | 结论 | 问题清单 / 备注 |
|---|---|---|---|
| 2026-10-17 | `agent/be/M1-BE-01-auth` @ `25564b9`（M1-BE-01） | 🔁 需修改（修完 1、2 即可合并） | 整体质量好：结构清晰、只改了自己的路径、无需迁移、Cookie/CSRF/会话设计正确，测试 48/48 通过、check/build 通过，测试覆盖全面。Lead 用并发探针复现了 2 个问题：<br>**必须修改**<br>1. `server/src/auth/sms.js:42-58` 发码冷却有竞态：`checkCooldown` 的查询和后面的作废/插入不在同一把锁里。探针直接并发调用 10 次 `sendSmsCode`（同一手机号），3 次运行均为 6 次成功、实际发出 6 条短信、库里同时有 6 条未作废验证码。后果：并发请求可绕过 60 秒冷却刷短信费用（只剩每日上限兜底），且「只认最新一条」不成立。期望：同一手机号的「冷却检查 → 作废旧码 → 插入新码」放进一个短事务并加按手机号的锁（如 `pg_advisory_xact_lock(hashtext('sms:' \|\| phone))`），短信发送仍在事务外；补并发回归测试（并发 10 次只成功 1 次、只发 1 条）。<br>2. `server/src/auth/sms.js:72-95` 错误次数上限有竞态：先读 `attempts` 再比对哈希，最后才自增，并发提交时多个请求读到同一个旧值。探针并发提交 15 个错误码，最终 `attempts=10`，即 10 次猜测被实际比对，超过「错 5 次作废」。期望：先原子地占用一次尝试再比对，例如 `UPDATE sms_codes SET attempts = attempts + 1 WHERE id = $1 AND consumed_at IS NULL AND attempts < $max RETURNING attempts`，没返回行就直接 `SMS_CODE_INVALID`；补并发回归测试（并发 15 个错误码后被比对的次数 ≤ 5）。<br>**建议修改（可同分支顺手改）**<br>3. `server/src/auth/sms.js:19` 控制台文案写死「10 分钟内有效」，实际默认 `codeTtlSeconds=300`（5 分钟），改为按配置输出。<br>4. `server/src/auth/routes.js:48` `logout` 挂了 `requireAuth`，会话已过期时返回 401 且不清 Cookie。建议无会话时也清 Cookie 并返回 `{ ok: true }`（API.md §1 未要求登录态）。<br>**不需本分支处理（Lead 已登记到 TASKS）**：`rate_counters` / 过期 `sms_codes` / 过期 `sessions` 的清理并入 M1-BE-03；面向用户的「每天」限额（免费故事理解）按北京时间切日，见 M1-BE-05。短信每日上限按 UTC 切日可接受。 |

## 7. 变更记录（最新在上）

### 2026-10-17 · BE-Core · M1-BE-01 认证

- **背景**：M1 骨架跑通的第一个任务。复用 L-02 的 `users` `sms_codes` `sessions` `rate_counters` 表结构与既有错误码，无需新迁移，未改 `docs/API.md`（即无需 §5 变更申请）。
- **改动（文件/模块）**：
  - 新增 `server/src/auth/`：`ratelimit.js`（PG 固定窗口限流）、`session.js`（会话中间件 / CSRF 守卫 / 用户序列化）、`sms.js`（验证码发放与校验 + 登录注册 + console provider）、`routes.js`（5 个端点）、`index.js`（`createAuth` 组装）。
  - `server/src/config.js`：新增 `sms` 配置组（provider、验证码 TTL、冷却、每日上限、错误次数上限、登录限流）+ 生产禁用 console provider 的启动拦截；`server/.env.example` 同步。
  - `server/src/app.js`：在预留插入点接线 `createAuth`（会话 → CSRF/Origin → 认证路由），`createApp` 新增 `smsProvider` 注入点；新增 `server/test/auth.test.js`（22 个用例）。
- **核心实现**：
  - 验证码：6 位码按手机号掺盐 sha256 存储（10^6 空间不掺盐可被离线碰撞）；冷却看最近一次发送时间（避免固定窗口边界连发），每日上限走 `rate_counters`；发新码前作废旧码，登录只认最新一条；发送失败删行、不占冷却，返回 502 `UPSTREAM_FAILED`。
  - 登录：失败计数（`attempts` 自增、达上限作废）在**事务外自提交**——首版放在事务内，抛错即回滚导致计数永不生效，被本任务测试暴露后修正；成功路径短事务：行锁复核 → 消费验证码 → 建用户 + 钱包行（随注册建好，M1-BE-02 无需懒建）→ 建会话。新用户 `tourCompletedAt=null`（验收点）。
  - 会话与 CSRF：Cookie `miv_sid`（HttpOnly / SameSite=Lax / 生产 Secure），库中只存 token 哈希；过期或被停用账号的会话在中间件里顺手删除。写请求先校验 Origin 白名单（无 Origin 放行，兼容非浏览器客户端）；存在会话时再校验 `X-CSRF-Token`；`/auth/sms`、`/auth/login` 登录前无 token，由 Origin + SameSite 防护。
  - `PATCH /me/onboarding`：`tourCompletedAt` 只记首次完成（完成与跳过都传 true，重播不改服务端状态），`tipsSeen` 追加去重，两字段至少一个。
- **验证（命令与结果）**：
  - `npm ci` ✓；`npm run test:db:up` ✓（miv-test 容器健康）。
  - `npm run test:server`：48 通过 0 失败（原 26 + auth 22：未登录 401、CSRF 缺失/错 Origin 403、冷却 429、错 5 次作废、过期码、日发送上限、登录限流、新用户 `tourCompletedAt=null`、onboarding 幂等/去重/参数校验、logout 失效并清 Cookie、provider 故障 502 不占冷却、生产配置拦截）。
  - `npm run check` 0 错误；`npm run build` 成功。
- **未完成 / 风险**：
  - 短信 provider 仅实现 console（开发/测试把验证码打印到控制台）；生产启动会拦截并要求注入真实 provider（接真实短信放 M2/M3）。
  - 验证码哈希为 sha256+手机号掺盐 + 5 次错误上限，上线前可评估升级 argon2/bcrypt（需新增依赖）。
  - 每日上限窗口按 UTC 对齐；如需按北京时间「每天」，后续在运营配置里调整。
  - 真实短信发送未验证（遵守不产生真实费用的约束）；限流仅按手机号维度，未做按 IP（M2 结合部署形态评估）。

### 2026-10-16 · Lead · L-01~L-04 PRD 定稿与主体框架

- **背景**：用户确认 PRD v2.2 定稿（最长 90 秒），要求 Lead 写主体框架、把控质量，主力开发交给其他 Agent。
- **改动**：
  - 文档：`docs/PRD.md`（定稿，旧版移入 `docs/archive/`）；`API.md` `ARCHITECTURE.md` `UI.md` `TASKS.md` 重写为 v1.0；`AGENTS.md` 所有权与 Render 职责（不做字幕/BGM）。
  - 后端 `server/`：`config.js`、`logger.js`（脱敏）、`http/`（错误码表、requestId、错误中间件、`Fields` 校验）、`db/`（连接池、嵌套事务、迁移执行器、`newId`）、`migrations/001-init.sql`（全量表 + 种子：6 风格、2 档位、14 音色、运营配置、占位 mock SKU）、`queue/`（SKIP LOCKED、租约、退避、去重）、`app.js`（`/health` `/catalog` `/voices`）、`worker.js`（处理器注册 + 并发循环 + 优雅退出）、`engine/README.md` `render/README.md`（接口约定）、测试辅助。
  - `deploy/compose.test.yml`；根 `package.json`：workspaces 加入 server，`test:db:up/down`、`test:server`。
  - 前端 `apps/web`：`types.ts`/`http.ts` 按 API v1.0 重写；mock 重写（时间推进完整流程、示例数据、试听音）；新页面：首页（创作）、数字资产库（数字人/声音）、新建/详情数字人、作品列表（分组 + 到期提醒）、作品详情 5 视图；新组件：SpotlightTour、FlowSteps、CharacterTray、StylePicker、QualityPicker、VoicePicker、VoicePlayButton、CastRow、SegmentCard、ExpiryBanner；删除 v0.1 的 CreatePage、Plan/Assets/Shots 视图、AssetCard、ShotCard、StageStepper。
- **验证**：
  - `npm run test:server`：26 通过 0 失败（迁移幂等与防篡改、嵌套事务、金额约束、音色唯一、队列并发领取/租约抢占/退避/永久失败、Worker、HTTP 契约、日志脱敏、生产配置校验）；手动启动 API 与 Worker，SIGTERM 正常退出。
  - `npm run check` 0 错误；`npm run build` 成功。
  - Playwright（mock）手机 390×844 与 PC 1280×800 各跑完整流程：首次登录主引导 5 步 → 刷新不重复 → 写故事 → 理解 → 故事确认（小提示）→ 形象报价 → 生成形象 → 角色确认（声音小提示、换声音）→ 视频报价 → 制作中 → 交付（保存期小提示）→ 重新生成片段 → 到期提醒弹窗 → 已过期作品 → 资产库/声音 → 新建数字人 → 我的 → 重播引导 + Esc 关闭。无页面错误、无控制台错误、无横向溢出。修复 1 处：声音弹层分类标签被压扁。
- **未完成 / 风险**：
  - 业务后端（认证、钱包、资产库、作品状态机、作品 API）、engine、render 均未实现，见 TASKS M1。
  - SKU 价格为占位 mock 值；风格封面、音色试听与参考音频文件尚未上传（接口在缺素材时省略 `*Url`）。
  - 前端打磨项（给 Web）：数字人重命名用了 `window.prompt`，应改为 Vant 弹窗；mock 视频为占位封面，无真实播放；Vant 仍全量注册（主包 gzip 约 136KB）。
  - 未在真机（iOS Safari / 微信内置浏览器）验证。

### 2026-10-15 · Lead · L-00 文档与 UI 骨架

- **背景**：用户决定把超搭云「AI → 一键短片」拆成独立的 C 端项目，要求先定大纲和 UI 框架，其余交给多个 Agent 开发。
- **改动**：`AGENTS.md`（多 Agent 约定）、`docs/PRD.md` `ARCHITECTURE.md` `API.md` `UI.md` `TASKS.md`、本文件、`README.md`；`apps/web` 前端骨架：Vue3+Vant4，响应式布局（手机 Tabbar / PC 侧栏），7 个页面、9 个通用组件、设计令牌、API 客户端与类型（与 `docs/API.md` 对齐）、内存 mock（模拟一键/精修两种流程的进度推进）。
- **验证**：
  - `npm run check`（vue-tsc）0 错误；`npm run build` 成功（主包 gzip 约 127KB，全量注册 Vant，后续可改按需引入）。
  - Playwright + Chromium 在 390×844（手机）与 1280×800（PC）两种视口，用 mock 跑完整流程：首页 → 登录拦截 → 登录 → 新建（逐步确认模式）→ 报价弹窗 → 写剧本中 → 确认剧本 → 确认角色 → 确认分镜 → 生成 → 成片 → 作品列表 → 钱包；另跑一键模式直达成片。修复后无页面报错、无控制台错误。
  - 过程中修复：剧本视图对响应式对象用 `structuredClone` 报 DataCloneError（改为 JSON 深拷贝）；无 Tabbar 页面的底部操作栏留空；竖屏播放器超出一屏。
- **未完成 / 风险**：
  - `server/` 只有说明，没有代码；mock 视频是占位图。
  - 未做真机（iOS Safari / 微信内置浏览器）测试。
  - npm 11 默认拦截 esbuild 的 postinstall 脚本（`npm install-scripts`），目前构建不受影响；如遇 esbuild 报错，执行 `npm install-scripts approve esbuild`。
  - PC 成片页播放器与右侧卡片之间留白偏大，属小的视觉优化项（给 Web 角色）。

<!-- 新记录模板
### YYYY-MM-DD · 角色 · 任务ID 标题
- **背景**：
- **改动**（文件/模块）：
- **核心实现**：
- **验证**（命令与结果）：
- **未完成 / 风险**：
-->
