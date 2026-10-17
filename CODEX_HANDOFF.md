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
| M1-BE-01 | BE-Core（本机开发 Agent） | `agent/be/M1-BE-01-auth` | `server/src/auth/**` `server/src/config.js` `server/src/app.js` `server/test/auth.test.js` `server/.env.example` | ✅ 完成（Lead 复审通过并合并 `6a741a7`） | 2026-10-17 |
| M1-BE-02 | BE-Core（本机开发 Agent） | `agent/be/M1-BE-02-wallet` | `server/src/wallet/**` `server/src/api/{wallet,quotes}.js` `server/src/app.js` `server/src/auth/{session,index}.js` `server/test/wallet.test.js` | ✅ 完成（Lead 复审通过并合并） | 2026-10-17 |
| M1-BE-03 | BE-Core（本机开发 Agent） | `agent/be/M1-BE-03-cron` | `server/src/queue/cron.js` `server/src/worker.js` `server/src/config.js` `server/test/cron.test.js` | 待审查 | 2026-10-17 |
| M1-BE-04 ~ 06 | — | — | — | 待认领（BE-Core 串行） | — |
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
| 2026-10-17 | `agent/be/M1-BE-02-wallet` @ `25ab347`（M1-BE-02 复审） | ✅ 通过并合并 | 7 条全部修复，测试 74/74、check、build 通过。Lead 探针复测：同一事务 5 条流水按 limit=1/2/3 翻页均完整无重复；负数、小数金额拒绝；`settle` 同键不同额 409、同额重放成功；跨用户复用幂等键 409；估算下限 = 30 秒视频费，形象费按缺形象数计入上下限；A 数字人的报价确认 B 时 `QUOTE_MISMATCH`；余额与冻结对账正确。<br>**给后续任务的约定**：<br>• 钱包操作金额必须为正整数，金额为 0 时（如没有需要生成的形象）调用方**跳过**扣费，不要调用 `charge/reserve`。<br>• 调用 `consumeQuote` 必须传 `{ kind, refType, refId }`：`look_regenerate` → `character`/数字人 id；`cast_looks`、`project_render` → `project`/作品 id；`segment_take` → `segment`/片段 id。<br>• 优化项（不急）：`listLedger` 的游标条件对 `created_at` 做了表达式运算，用不上 `(user_id, created_at, id)` 索引，数据量大时可改成 `(created_at, id) < (to_timestamp($3 / 1e6), $4)`。<br>**M1-BE-03 开工要点**（定时任务）：<br>a. 调度：Worker 启动时和每隔一段时间，用 `enqueue` 加去重键 `cron:<任务名>:<时间窗口起点>` 入队，多个 Worker 同时运行也只入队一次；调度间隔放 `config.js`。<br>b. 清理任务都要**分批**（如每批 500 行、每批一个短事务），可以重复执行；单批失败抛错，交给队列重试。<br>c. `auth.sweep`：删除过期的 `rate_counters` 窗口（按最长窗口 1 天再加缓冲）、已作废或过期超过 1 天的 `sms_codes`、过期的 `sessions`。<br>d. `uploads.sweep`：24 小时未被引用的上传先删存储对象、再删记录。存储接口在 engine 完成前用注入的模拟实现，接口按 `server/src/engine/README.md` 的 `storage.remove(keys)`。<br>e. `projects.expire_sweep`：`delivered` 且 `expires_at <= now()` 的作品：在短事务里改为 `expired`、写 `project_events`，再在事务外删除成片和片段视频对象，并清空对应 `*_key`；封面和作品记录保留。没有作品数据时用测试插入的行验证。<br>f. **注意**：清理已完成的 `jobs` 时，只删除超过 30 天的 `done` 行；删掉后同样的去重键可以再次入队，所以业务处理器本身必须按业务状态幂等，不能只靠去重键。<br>g. 必测：两个 Worker 同时调度只入队一次；清理可重复执行；分批边界；到期作品状态和视频对象都被处理、封面保留。 |
| 2026-10-17 | `agent/be/M1-BE-02-wallet` @ `5b0fd18`（M1-BE-02） | 🔁 需修改（修完 1~6 即可合并） | 遗留第 5 条（冷却拦截不计每日次数）已修好并有回归测试 ✅。钱包主体设计正确：条件 UPDATE 防超扣、报价原子占用 + 重算、兑换码条件更新、计价函数注册表、按锁定档位映射取价。测试 67/67、check、build 通过。Lead 探针复现以下问题：<br>**必须修改**<br>1. `server/src/wallet/service.js:154-173` 流水翻页漏数据：游标用 `toISOString()`（毫秒），库里 `created_at` 是微秒；同一事务内多条流水 `created_at` 完全相同（`now()` 是事务开始时间）。探针：一个事务里扣费 3 次，`limit=1` 翻页只拿到 1 条。期望：游标带完整精度（如 `(extract(epoch from created_at) * 1e6)::bigint` 或 `created_at::text`），补测试「同一事务多条流水跨页不丢不重」。<br>2. `server/src/wallet/service.js:43/62/81/100` `reserve` / `settle` / `refund` / `charge` 不校验金额。探针：`charge(amountFen: -500)` 后余额从 997 变成 1497。期望：入口统一断言 `Number.isSafeInteger(amountFen) && amountFen >= 0`（0 是否允许按调用方需要定，建议允许 0 且不写流水或写 0 流水，二选一并注释），否则抛 `INTERNAL`；补测试。<br>3. `server/src/wallet/service.js:26-40` 幂等键不分用户：查首次流水时没带 `user_id`。探针：用户 B 用 A 用过的键扣费，返回 `replayed: true`（看起来扣成功了），实际 B 的余额没变。后果：调用方以为已扣费并开始生成，等于免费；客户端传入的键（兑换码）也能被别人占用。期望：命中的流水 `user_id` 不同时抛 409 `IDEMPOTENCY_CONFLICT`（或库里存 `userId:key` 做命名空间），补测试。<br>4. `server/src/wallet/service.js:62` `settle` 的重放比对只看 `amount_fen`（永远是 0）。探针：同键先结算 100、再结算 200，第二次被当作重放放过。期望：首次流水查询带出 `frozen_delta_fen`，`settle` / `refund` / `reserve` 都比对它；补测试。<br>5. `server/src/wallet/pricing.js:174` `consumeQuote` 只收 `quoteId`，不校验报价属于哪个作品 / 片段 / 数字人，靠调用方自己核对，后续 BE-04/05 容易漏，变成「拿 A 作品的便宜报价确认 B 作品」。期望：参数增加 `{ kind, refType, refId }`，不一致抛 409 `QUOTE_MISMATCH`；`priceSegmentTake`（`pricing.js:128`）同时校验 `segmentId` 属于传入的 `projectId`。补测试。<br>6. `server/src/wallet/pricing.js:217-235` 首页价格区间与 PRD §6.3【默认】不一致。探针：标准档 `minFen=100`（按最短 5 秒）。PRD：下限按 1 个 30 秒片段、上限按最长时长；形象费按「本风格缺形象的已勾选数字人数」计入**上下限**（不是全部勾选数，也不是只算上限）。「缺形象」= 该数字人在 `character_looks` 里没有这个风格、或 `selected_version_id` 指向的版本不是 `succeeded`。期望：按此修改，30 秒取 `min(30, SKU 最长时长)`，补测试。<br>**建议修改**<br>7. `server/src/wallet/service.js:119` 兑换码没有失败次数限制，短码可被暴力猜。建议按用户限制失败次数（如每小时 10 次）。注意：失败会抛错导致事务回滚，计数要在事务外提交（参考 BE-01 的做法）。<br>**给 BE-05 的约定（不需本分支处理，已记录）**：`priceCastLooks` 把「缺形象」定义为 `project_cast.look_version_id IS NULL`，所以故事理解 job 必须为已有本风格形象的角色写好 `look_version_id`。 |
| 2026-10-17 | `agent/be/M1-BE-01-auth` @ `e315aac`（M1-BE-01 复审） | ✅ 通过并合并（`6a741a7`） | 4 条意见全部处理，新增 4 个回归测试；测试 52/52、check、build 通过。Lead 并发探针复测：10 次并发发码只成功 1 次、只发 1 条、只剩 1 条有效码；15 个并发错误码只比对 5 次且验证码作废。<br>**遗留 1 条，在 M1-BE-02 分支的第一个提交里修复**：<br>5. `server/src/auth/sms.js` `sendSmsCode` 先调用 `hitRateLimit`（每日计数 +1）、后在锁内检查冷却，导致被冷却拦下的请求也计入每日上限。探针：并发 10 次发码只发出 1 条，但 `sms:daily:<手机号>` 计数到 10，该手机号当天再也收不到验证码；别人用 10 个请求就能锁住任意手机号一天的登录。期望：冷却检查通过后再计每日次数（在同一事务锁内用 `t` 计数，或冷却拦截时不计数），补回归测试「冷却期内并发 10 次后，冷却过后仍能再发」。<br>**M1-BE-02 开工要点**（对照 API.md §3、ARCHITECTURE §3/§4）：<br>a. 钱包服务要能被别的模块在**它们自己的事务里**调用：`reserve / settle / refund / charge(t, …)` 接收事务作用域，余额用一条带条件的 `UPDATE … WHERE available_fen >= $amount` 扣减，影响 0 行即 `INSUFFICIENT_BALANCE`；每笔流水带 `idempotency_key`，重放返回首次结果。<br>b. 报价：四种 kind 用「每种一个计价函数」的注册方式实现。本任务先做 `look_regenerate`（数字人表已存在）和 `/quotes/estimate`；`cast_looks` / `project_render` / `segment_take` 的计价函数也写好，测试里直接插入作品、片段行即可，不用等 BE-05。`project_render` / `segment_take` 按作品锁定的 `tier_mapping_id` 取价，**不是**当前映射；形象单价取 `settings.look_image_sku_code` 的当前生效 SKU。<br>c. 报价单存 `params_hash` 与 `price_snapshot`；使用时在事务里 `UPDATE quotes SET consumed_at = now() WHERE id = $1 AND consumed_at IS NULL AND expires_at > now()` 原子占用，再按当前参数和价格重算，不一致时 409 `QUOTE_MISMATCH`，过期时 409 `QUOTE_EXPIRED`。<br>d. 兑换码只存哈希，`used_by IS NULL` 条件更新防并发重复兑换；流水 `title` 用中文。<br>e. 必测：并发预占不超扣、幂等重放、同键不同参数 409、调价后旧报价 `QUOTE_MISMATCH`、过期报价、并发兑换同一码只成功一次。 |
| 2026-10-17 | `agent/be/M1-BE-01-auth` @ `25564b9`（M1-BE-01） | 🔁 需修改（修完 1、2 即可合并） | 整体质量好：结构清晰、只改了自己的路径、无需迁移、Cookie/CSRF/会话设计正确，测试 48/48 通过、check/build 通过，测试覆盖全面。Lead 用并发探针复现了 2 个问题：<br>**必须修改**<br>1. `server/src/auth/sms.js:42-58` 发码冷却有竞态：`checkCooldown` 的查询和后面的作废/插入不在同一把锁里。探针直接并发调用 10 次 `sendSmsCode`（同一手机号），3 次运行均为 6 次成功、实际发出 6 条短信、库里同时有 6 条未作废验证码。后果：并发请求可绕过 60 秒冷却刷短信费用（只剩每日上限兜底），且「只认最新一条」不成立。期望：同一手机号的「冷却检查 → 作废旧码 → 插入新码」放进一个短事务并加按手机号的锁（如 `pg_advisory_xact_lock(hashtext('sms:' \|\| phone))`），短信发送仍在事务外；补并发回归测试（并发 10 次只成功 1 次、只发 1 条）。<br>2. `server/src/auth/sms.js:72-95` 错误次数上限有竞态：先读 `attempts` 再比对哈希，最后才自增，并发提交时多个请求读到同一个旧值。探针并发提交 15 个错误码，最终 `attempts=10`，即 10 次猜测被实际比对，超过「错 5 次作废」。期望：先原子地占用一次尝试再比对，例如 `UPDATE sms_codes SET attempts = attempts + 1 WHERE id = $1 AND consumed_at IS NULL AND attempts < $max RETURNING attempts`，没返回行就直接 `SMS_CODE_INVALID`；补并发回归测试（并发 15 个错误码后被比对的次数 ≤ 5）。<br>**建议修改（可同分支顺手改）**<br>3. `server/src/auth/sms.js:19` 控制台文案写死「10 分钟内有效」，实际默认 `codeTtlSeconds=300`（5 分钟），改为按配置输出。<br>4. `server/src/auth/routes.js:48` `logout` 挂了 `requireAuth`，会话已过期时返回 401 且不清 Cookie。建议无会话时也清 Cookie 并返回 `{ ok: true }`（API.md §1 未要求登录态）。<br>**不需本分支处理（Lead 已登记到 TASKS）**：`rate_counters` / 过期 `sms_codes` / 过期 `sessions` 的清理并入 M1-BE-03；面向用户的「每天」限额（免费故事理解）按北京时间切日，见 M1-BE-05。短信每日上限按 UTC 切日可接受。 |

## 7. 变更记录（最新在上）

### 2026-10-17 · BE-Core · M1-BE-03 定时任务调度

- **背景**：M1 第三个任务，按 §6 M1-BE-03 开工要点 a~g 实现。队列核心（SKIP LOCKED/租约/退避/去重）复用 L-02，无需新迁移、未改 `docs/API.md`。
- **改动（文件/模块）**：新增 `server/src/queue/cron.js`（调度器 + 四个清理任务 + 内存存储实现）；`server/src/worker.js`（注册 4 个 cron 处理器，主入口启动/停止调度器）；`server/src/config.js` 与 `.env.example`（`cron` 配置组：调度间隔、各任务周期、done 保留天数、批量）；新增 `server/test/cron.test.js`（6 用例）。
- **核心实现**：
  - 调度（要点 a）：`createScheduler` 按 `cron.tickSeconds`（默认 60s）循环、启动先调一次；每任务入队键 `cron:<类型>:<窗口起点 ISO>`，窗口起点 `floor(now/周期)×周期` 对齐——多 Worker 并发调度同窗口只入队一次。周期：auth.sweep / uploads.sweep 1h，projects.expire_sweep 5min，jobs.cleanup 1d（均可配）。
  - 分批（要点 b）：统一 `deleteInBatches`（`ctid IN (… LIMIT 批量)`，每批一个短事务，无行即停）；uploads/expire 为「选批 → 事务外动作 → 短事务收尾」结构；单批失败抛错交队列退避重试，全部可重复执行。
  - auth.sweep（要点 c）：过期限流窗口（1 天最长窗口 + 1 天缓冲）、作废或过期超 1 天的 `sms_codes`、过期 `sessions`。
  - uploads.sweep（要点 d）：24h 未引用上传先事务外 `storage.remove(keys)` 再删记录；存储为注入接口（engine/README `storage.remove`），缺省 `createMemoryStorage()`，Engine 迁移（M1-ENG-03）后替换为七牛实现。
  - projects.expire_sweep（要点 e）：短事务锁批（`FOR UPDATE SKIP LOCKED`）把 delivered 且到期的作品改 `expired` 并写 `project_events`，事务外删成片与片段视频对象，再清空 `renders.video_key` / `segment_takes.video_key`；封面、尾帧、海报与作品记录保留。另含补偿循环：清理上次中断遗留的 expired 作品视频 key。
  - jobs.cleanup（要点 f）：只删超过 `jobsDoneRetentionDays`（默认 30 天）的 done 行；删后同去重键可再入队，因此各处理器按业务状态幂等（到期清理的补偿路径即该原则的落实）。
- **验证（命令与结果）**：
  - `npm run test:server`：80 通过 0 失败（74 → 80，新增 6 用例覆盖要点 g 全部必测：两个调度器并发 tick 同窗口每任务仅 1 条 job 且重复调度不再新增；auth.sweep 清理/保留规则与可重复执行；uploads.sweep 分批边界 batchSize=2 五行删净、已引用与 24h 内保留；到期作品状态/事件/视频对象删除/`video_key` 清空/封面海报尾帧保留/未到期不动/补偿路径/可重复；jobs.cleanup 只删超期 done 行；调度入队 → `buildHandlers` 注册 → Worker `runOne` 端到端执行成功）。
  - `npm run check` 0 错误；`npm run build` 成功。
- **未完成 / 风险**：
  - `storage` 缺省为进程内内存实现（开发/测试用），生产需等 M1-ENG-03 的七牛实现并在 worker 主入口注入；接口已按 engine/README 对齐。
  - `projects.expire_sweep` 的状态迁移暂写在 cron 模块，BE-05 做作品状态机时可把它挪进 projects 模块复用统一的状态迁移函数（结构变化走变更申请）。
  - 各清理周期为【默认】值（已做成 config 可调），上线前可按数据量调整；到期的 SSE 事件依赖 `project_events` 表补发，前端 SSE 在 M1-BE-06 接入。
  - 未在长时运行的 Worker 真机上验证调度循环（测试直接驱动 `tick()`）；`setInterval` 已 `unref`，不阻塞进程退出。

### 2026-10-17 · BE-Core · M1-BE-02 修复（§6 审查意见 1~7）
### 2026-10-17 · BE-Core · M1-BE-02 修复（§6 审查意见 1~7）

- **背景**：Lead 审查（§6）指出 6 条必须修改 + 1 条建议（兑换码暴力猜解）。分支已 `git merge origin/main`（084e88b）后修复，仍在同一分支追加提交（bb26717）。
- **改动（文件/模块）**：`server/src/wallet/service.js`（意见 1~4）、`server/src/wallet/pricing.js`（意见 5~6）、`server/src/api/wallet.js`（意见 7）、`server/test/wallet.test.js`（更新 4 处既有断言/调用 + 新增 8 个回归测试）。
- **核心实现**：
  1. 流水翻页：游标改用微秒时间戳（`(extract(epoch from created_at) * 1000000)::bigint` + id 作 keyset），修复同事务多条流水 `created_at` 完全相同（`now()` 为事务开始时间）被毫秒游标整段跳过的丢数据问题。回归：同一事务 3 笔扣费，`limit=1` 逐页翻满 3 条不丢不重。
  2. 金额入口校验：`reserve/settle/refund/charge` 统一 `Number.isSafeInteger(amountFen) && amountFen > 0`，否则 INTERNAL（0 元操作无业务含义，选择直接拒绝并注释，不写流水）。回归：`charge(-500)`、`charge(0)` 均 INTERNAL 且余额不变。
  3. 幂等键隔离：首次流水命中时 `user_id` 与调用方不同 → 409 `IDEMPOTENCY_CONFLICT`。回归：他人复用同键得 409、双方余额不变。
  4. 重放比对：`withIdempotency` 查询带出 `frozen_delta_fen`，`reserve/settle/refund` 的 expect 增加该字段。回归：同键结算 100 后再结算 200 → 409。
  5. 报价归属：`consumeQuote` 必须声明 `{ kind, refType, refId }`，与报价不符抛 `QUOTE_MISMATCH`（占用随事务回滚，已测）；`priceSegmentTake` 校验 segment 属于传入 `projectId`。回归：拿 chr_a1 报价确认 chr_a2、换 kind 声明均 MISMATCH 且占用回滚；跨作品 segment_take 报价 404。**注意：BE-04/05 调用 `consumeQuote` 时必须传三元组**。
  6. estimate 对齐 PRD §6.3【默认】：下限 = 1 个 30 秒片段（30 取 `min(30, SKU 最长时长)`），上限 = 最长作品时长；形象费按「本风格缺形象的已勾选数字人数」计入上下限（缺形象 = 无该风格形象或选中版本非 succeeded，SQL 用 `NOT EXISTS … selected_version_id → status='succeeded'`）。回归：3 个勾选中 2 个缺形象 → standard {min:700, max:1900}；空勾选 {600, 1800}；hd {1200, 3600}。
  7.（建议项）兑换码尝试上限：按用户每小时 10 次（`redeem:attempt:<userId>` 固定窗口），事务外预计数（BE-01 登录限流同款，失败回滚不丢计数，并发猜码也计入）。回归：连续 10 次错码 400 后第 11 次 429 `RATE_LIMITED`。
- **验证（命令与结果）**：`npm run test:server` 74 通过 0 失败（67 → 74，新增 8 个回归 + 调整 4 处既有断言），连续 6 轮稳定；`npm run check` 0 错误；`npm run build` 成功。
- **未完成 / 风险**：给 BE-05 的约定（Lead 已记录）继续有效——`priceCastLooks` 以 `look_version_id IS NULL` 为缺形象，故事理解 job 需为已有本风格形象的角色写好该字段；`consumeQuote` 新签名的调用方适配在 BE-04/05 落地。

### 2026-10-17 · BE-Core · M1-BE-02 钱包与计价（含遗留 5 修复）
### 2026-10-17 · BE-Core · M1-BE-02 钱包与计价（含遗留 5 修复）

- **背景**：M1 第二个任务。分支前两个提交先修 §6 遗留第 5 条（发码冷却拦截不计每日次数），随后按 §6 M1-BE-02 开工要点 a~e 实现钱包与计价。复用现有表结构与错误码，无需新迁移，未改 `docs/API.md`。
- **改动（文件/模块）**：
  - 遗留 5：`server/src/auth/sms.js`（每日上限移入手机号级事务锁内、冷却通过后计数）+ `server/test/auth.test.js` 回归。
  - 新增 `server/src/wallet/service.js`：`reserve/settle/refund/charge/redeem`（接收调用方事务作用域 `t`，要点 a）、`getWallet`、`listLedger`（keyset 分页）。
  - 新增 `server/src/wallet/pricing.js`：四种 kind 计价函数注册表（要点 b）、`createQuote`、`consumeQuote`（要点 c）、`estimateQuote`、`getActiveTierSku`。
  - 新增 `server/src/api/wallet.js`（GET /wallet、GET /wallet/ledger、POST /wallet/redeem）、`server/src/api/quotes.js`（POST /quotes、POST /quotes/estimate），逐路由挂 `requireAuth`；`app.js` 接线。
  - `server/src/auth/session.js`：`requireAuth` 改为模块级导出供业务路由复用（auth/index.js 行为不变）；新增 `server/test/wallet.test.js`（14 用例）。
- **核心实现**：
  - 账本（要点 a）：余额用带条件 `UPDATE … WHERE available_fen/frozen_fen >= $amount` 原子增减，影响 0 行即 402（结算/退回的冻结不足属调用方错误，按 INTERNAL 兜底暴露）；幂等键加事务级 advisory 锁后查首次流水，同键重放返回首次结果，同键不同参数（kind/金额/ref）409 `IDEMPOTENCY_CONFLICT`。
  - 计价（要点 b）：`project_render`/`segment_take` 按作品锁定 `tier_mapping_id` 对应 sku_code 的当前生效版本取价（非当前映射）；形象单价取 `settings.look_image_sku_code` 当前生效 SKU；`cast_looks` 按 `project_cast.look_version_id IS NULL` 计数；四种 kind 的 `project_render`/`cast_looks`/`segment_take` 计价函数已就绪，测试直接插作品/片段行验证，不等 BE-05。
  - 报价（要点 c）：落库 `params_hash`（结构参数：片段清单、角色/风格、数量）+ `price_snapshot`（含请求参数与 sku 版本单价，供重算）；`consumeQuote` 原子占用（`consumed_at` 条件更新）→ 按当前状态与价格重算 → 比对，不一致 409 `QUOTE_MISMATCH`（占用随调用方事务回滚），过期/已消费 409 `QUOTE_EXPIRED`，他人报价 404。
  - 兑换码（要点 d）：只存 sha256 哈希；`used_by IS NULL` 条件更新防并发重复兑换；无效/已用统一「兑换码无效或已被使用」（400，不暴露区分）；流水标题中文。
- **验证（命令与结果）**：
  - `npm run test:server`：67 通过 0 失败（新增 14 用例覆盖要点 e 全部必测：并发预占不超扣（100 分并发预占 30 分仅 3 次成功、终态 10/90）、幂等重放、同键不同参数 409、调价后旧报价 `QUOTE_MISMATCH` 且占用回滚、参数变化 `QUOTE_MISMATCH`、过期 `QUOTE_EXPIRED`、并发兑换同一码仅一次、流水分页与非法 cursor、他人资源 404、HTTP 契约与登录守卫），连续 6 轮稳定。
  - `npm run check` 0 错误；`npm run build` 成功。
  - 遗留 5 回归：冷却期内并发 10 次发码后 `sms:daily` 计数仅 1，冷却过后仍能再发。
- **未完成 / 风险**：
  - `estimate` 的 min/max 口径为【默认】实现（min=档位单价×最短单段时长；max=档位单价×最长作品时长+数字人数×形象单价），待用户确认（HANDOFF §4.3 已登记），确认后只改 `estimateQuote` 一个函数。
  - `quotes` 表未存原始请求 JSON，重算依赖 `price_snapshot.request`；若后续 kind 增加参数需同步两处。
  - 结算/退回的冻结不足按 500 兜底（正常流程不会出现），供审查确认该取舍。
  - 充值（`recharge`）真实支付在 M3，当前只有兑换码入账路径。

### 2026-10-17 · BE-Core · M1-BE-01 修复（§6 审查意见 1~4）

- **背景**：Lead 审查（§6）指出 2 个并发竞态必须修复，另 2 条建议顺手改。本分支已 `git merge origin/main`（67fb2f5）后修复，仍在同一分支追加提交。
- **改动（文件/模块）**：`server/src/auth/sms.js`（意见 1、2、3）、`server/src/auth/routes.js`（意见 4）、`server/src/auth/index.js`（console provider 接收 config）、`server/test/auth.test.js`（新增 4 个用例并调整 logout 401 断言）。
- **核心实现**：
  1. 发码竞态：「冷却检查 → 作废旧码 → 插入新码」放进带 `pg_advisory_xact_lock(hashtext('sms:' || phone))` 的短事务，同手机号并发请求在此串行化，冷却不可被并发绕过；短信 provider 发送仍在事务外，发送失败按行 id 删除、不占冷却。
  2. 错误次数竞态：改为**先原子占用一次尝试再比对哈希**（`UPDATE … SET attempts = attempts + 1 WHERE id = $1 AND consumed_at IS NULL AND attempts < 上限 RETURNING id`，无返回行即拒绝），占用语句自带行锁，并发提交不再读到旧值；错达上限即作废；正确路径保留短事务行锁复核，防并发同码双登录。
  3. console provider 文案按 `codeTtlSeconds` 向上取整到分钟输出，不再写死「10 分钟」。
  4. `POST /auth/logout` 去掉 `requireAuth`：无会话（含已过期 Cookie）也清 Cookie 并返回 `{ ok: true }`，与 API.md §1 一致；有会话时仍校验 CSRF 并删除会话行。
- **验证（命令与结果）**：
  - `npm run test:server`：52 通过 0 失败，连续 4 轮稳定。新增并发回归：同手机号并发 10 次发码仅 1 次 200、仅发 1 条短信、未作废码仅 1 条（其余 9 次 429 `SMS_COOLDOWN`）；并发 15 个错误验证码 `attempts=5`（比对次数不超上限）且已作废。另新增无会话 logout 200+清 Cookie、console 文案 5 分钟/2 分钟两例。
  - `npm run check` 0 错误；`npm run build` 成功。
- **未完成 / 风险**：同上一条记录；`rate_counters`/过期 `sms_codes`/过期 `sessions` 清理已由 Lead 登记进 M1-BE-03，免费次数按北京时间切日登记在 M1-BE-05，本分支不处理。

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
