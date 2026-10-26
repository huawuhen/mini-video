# 任务拆分（v1.0，2026-10-16，对应 PRD v2.2）

> 认领、状态和交接记录统一写在 `CODEX_HANDOFF.md`。这里只描述任务本身。依赖未完成的任务不要开工。
> 每个任务的验收标准是**最低要求**；Lead 合并前会独立复核（代码审查 + 跑测试 + 对照 PRD/API）。

## L 主框架（Lead，已完成或进行中）

| ID | 任务 | 产出 |
|---|---|---|
| L-01 | PRD 定稿与配套文档 v1.0 | `docs/PRD.md` `API.md` `ARCHITECTURE.md` `UI.md` `TASKS.md` |
| L-02 | 后端骨架 | `server/`：config、logger、http（错误/requestId/中间件/校验）、db（连接池/事务/迁移/ID）、`001-init.sql` 全量表结构 + 种子数据、PG 队列（领取/租约/退避/去重）、`app.js`（健康检查 + `/catalog` `/voices`）、`worker.js`（处理器注册 + 并发循环）、测试辅助 |
| L-03 | 测试数据库 | `deploy/compose.test.yml`（项目 `miv-test`，`127.0.0.1:56432`，tmpfs）、`npm run test:db:up/down` |
| L-04 | 前端骨架 v2 | 按 UI.md 重建路由、页面、组件、`types.ts`、mock；新手引导组件可用 |

## M0 技术验证（Lead；需用户授权真实费用）

| ID | 任务 | 产出 | 依赖 |
|---|---|---|---|
| M0-01 | 3 个样例故事（日常记录、对白多的小剧情、多角色出游） | `docs/m0/samples/*.md` | – |
| M0-02（**已授权，上限 300 元，由 Engine/开发 Agent 执行**，见 handoff §3 2026-10-20；运行器带成本账本与 90% 停止线；依赖 M1-BE-05 不是必须，可用 `server/scripts/` 单独脚本） | 真实模型验证：6 风格形象、30 秒多镜头 + 图片/音频参考一致性、尾帧衔接、多片段声音一致、每秒成本、可选时长与分辨率、单次故事理解 LLM 成本 | `docs/m0/report.md`：结论、成本表、推荐 SKU 与档位映射 | M0-01、用户授权 |

## M1 骨架跑通（模拟上游，零真实费用）

| ID | 角色 | 任务 | 验收 | 依赖 |
|---|---|---|---|---|
| M1-BE-01 | BE-Core | 认证：短信验证码（provider 可注入，开发环境打印到控制台）、会话、CSRF + Origin、PG 限流；`PATCH /me/onboarding` | 未登录 401；CSRF 缺失 403；冷却与错误次数上限；新用户 `tourCompletedAt=null` | L-02 |
| M1-BE-02 | BE-Core | 钱包与计价：账本、SKU/档位映射取价、`/quotes` 四种 kind、`/quotes/estimate`、预占/结算/退回/直接扣费、兑换码（只存哈希） | 并发预占不超扣；幂等重放；同键不同参数 409；调价后旧报价 `QUOTE_MISMATCH` | M1-BE-01 |
| M1-BE-03 | BE-Core | 定时任务调度（基于 `enqueue` + 去重键按时间窗口入队）：`projects.expire_sweep`、`uploads.sweep`、`auth.sweep`（清理过期 `rate_counters` 窗口、已作废/过期 `sms_codes`、过期 `sessions`）、已完成 `jobs` 归档；队列核心已在 L-02 完成 | 多 Worker 同时启动只入队一次；清理任务幂等 | L-02 |
| M1-BE-04 | BE-Core | 数字资产库与上传：`/uploads/*`、`/characters/**`、形象生成（job `look.generate`，调用 engine 模拟适配器） | 用户隔离（他人资源 404）；版本只增不改；软删除不影响历史作品 | M1-BE-02、M1-BE-03 |
| M1-BE-05 | BE-Core | 作品状态机与各 job（§4 ARCHITECTURE），engine/render 先用桩实现；`project.understand` 含「想法扩写」分支（`classifyInput` → `expandIdea` → `understand`，一次整理只计 1 次免费次数），`story.script`/`inputKind`/`expanded`/`bible` 写入 `projects.story`，`segments.final_prompt` 保存 `startState/endState/shots/skillId/skillVersion`；**所有片段按顺序串行生成**（用户 2026-10-19 决定），每段「提交 → 轮询 → 转存 → `render.inspect` → 提取尾帧 → 下一段」；`inspect` 不通过按「片段失败」处理：退回该片段预占、作品进入 `failed`，用户重试只重新生成失败片段（M1 阶段 `inspect` 用桩实现，M1-RND-01 完成后接入） | 模拟上游下从创建跑到 delivered；两个确认点；暂停/恢复/取消/重试；重启续跑；免费次数限制（「每天」按北京时间 00:00 切日）；`voicesEnabled` 规则 | M1-BE-04、M1-ENG-01、M1-ENG-02 |
| M1-BE-06 | BE-Core | 作品 API（API.md §6）+ SSE + 交付后片段替换与重新拼接 + 下载 | 契约测试：响应结构与 `types.ts` 一致；状态不允许时 409 | M1-BE-05 |
| M1-ENG-01 | Engine | `engine/story`：pi agent 接入、`understand` / `bindPrompts`（ARCHITECTURE §5），时长约束、角色匹配、音色推荐，模拟 LLM | 单测覆盖：时长只取 allowedDurations、总时长 ≤ max、超长精简提示、单片段不出音频参考 | – |
| M1-ENG-04 | Engine | `engine/skills`（`index/wan-3.0/generic`）+ `engine/story/expand.js`：设定集 `bible`、每段 `endState`/`startState`/`shots`、代码拼装提示词（人物场景描述逐字注入）、`expandIdea`、`classifyInput`（约 60 字）；规格见 `docs/skills/wan-3.0.md` v2 与 ARCHITECTURE §5 | 契约测试：提示词示例通过解析；对白逐字校验；确定性兜底；一句话想法扩写与剧本忠实模式；单测零真实费用 | M1-ENG-01 |
| M1-ENG-02 | Engine | `engine/providers`：适配器注册表 + wan3.0 / seedance2.5 视频（图片+音频参考、首帧）+ 图片模型适配器 + 模拟上游 | submit/query/normalize 单测；提交结果未知的分类 | – |
| M1-ENG-03 | Engine | `engine/net` `engine/storage`（七牛 Kodo + 签名链接）`engine/transfer` `engine/extract` | SSRF/大小/超时测试；存储用内存实现可替换 | – |
| M1-RND-01 | Render | `render.compose`：拼接、响度统一、硬切、AI 生成标识（显式 + 元数据）、封面；`extractLastFrame`；**`inspect` 基础技术检查**（可解码、有视频流与音频流、时长偏差 ≤2 秒、画幅分辨率、非全黑、非卡住、非静音，PRD §4.3；用 FFmpeg 生成的正常与异常样例视频测试：全黑、静音、静帧、缺音轨、时长不符、损坏文件） | 用 FFmpeg 生成的测试视频做合成测试（不需要真实模型） | – |
| M1-WEB-01 | Web | 在 L-04 骨架上打磨首页、资产库、作品列表、作品详情各视图（mock）；**确认点 A 改为展示并编辑 `story.script` 剧本全文**，`expanded` 为 `true` 时标注「AI 已为你扩写成剧本」，重新整理按剧本处理（API.md §6.1、§6.3） | 375px 与 1280px 截图；`npm run check` 与 build 通过 | L-04 |
| M1-WEB-02 | Web | 新手引导打磨：定位、自动避让、键盘与焦点、减少动态效果、场景小提示 | 手机/PC 各走一遍主引导与 3 个小提示截图 | L-04 |

## M2 MVP 内测

| ID | 角色 | 任务 | 依赖 |
|---|---|---|---|
| M2-BE-03 | BE-Core + Engine | **上游渠道层与驱动框架（ARCHITECTURE §5.5）**：①驱动框架：`providers/{contract,registry,transport,contract-test}.js`，`drivers/<protocol>/` 目录约定，自动扫描注册，`npm run driver:new` 脚手架；把现有 **aiide（火山方舟视频 + 素材库过审 + OpenAI Images）** 适配器迁成 `drivers/<协议>/`（含夹具与契约测试；**用户已确定不再使用的渠道（modelhub）直接删除适配器、冒烟脚本与测试，不迁移**，代码留在 git 历史，删除前确认无在途任务；**喵呜保留为备用渠道，一并迁成驱动**；图片驱动内含「网关 524/504 自动重试 ≤2 次、平台承担」），**SKU 与渠道解耦**（SKU 只含逻辑能力 + 用户价，渠道成本进渠道记录，迁移一次完成，此后换渠道不写迁移），新增 `drivers/openai-compatible/`（智谱 LLM），并按**用户新接入渠道的 API 文档**新增对应驱动；②渠道层：迁移 `provider_channels / channel_routes / channel_events / admin_audit_logs / admin_users` + `gen_tasks.channel_id`，凭证 AES-GCM（`CHANNEL_SECRET_KEY`），软删除，种子渠道引导；`channelRouter.pick`；视频 / 图片 / LLM 调用全部经路由层，任务绑定渠道；③`/api/admin/*`（API.md §8）与 `npm run admin:create`；健康度统计（只基于真实请求）；**命令行应急切换** `npm run channel:list` / `channel:use -- <video|image> <渠道名>` / `channel:test -- <渠道名>`（不依赖后台页面，非程序员可用）（**不做**自动探活与自动故障转移，用户 2026-10-24 决定）。测试：每个驱动通过契约测试（无真实费用）；切换只影响新提交、在途回原渠道、软删除 / 停用渠道仍可轮询、unknown 不重提、驱动缺失渠道被跳过并告警、凭证不入日志 / 不回传 | 契约测试与渠道层测试全绿；`check`/`build` 通过；扫描库与日志无明文密钥；业务层 grep 不到厂商名 | M1-BE-06、M0-02 |
| M2-BE-01 | BE-Core | 接入真实渠道（按 M0 结论配置 SKU 与档位映射）、对账与 unknown 处理工具（经 M2-BE-03 渠道层接入，不直连单一渠道） | M0-02、M1-BE-06、**M2-BE-03** |
| M2-BE-02 | BE-Core | 保存期清理与到期提醒数据、上传清理；failed 作品超过 7 天（可配置）自动取消并退回未结算冻结 | M1-BE-06 |
| M2-WEB-01 | Web（+ BE-Core 配合） | 前端切换真实 API，联调全部流程；SSE。**零费用联调**：BE 侧新增本地模拟驱动 `drivers/local-mock/`（视频/图片/LLM，可配延迟与失败率，`NODE_ENV=production` 时拒绝加载/种子），`channel:seed -- --mock` 写入并激活；前端 `VITE_USE_MOCK=false` 走真实 server。覆盖：短信登录（console）、CSRF、创建→确认点 A/B→生成→交付→下载、retry/取消/重生成、钱包流水、`NO_ACTIVE_CHANNEL`/上游失败中文提示、SSE 断线重连与长排队文案（实测排队 12~79 分钟）。`types.ts` 与 API.md 不一致处走 handoff 变更申请 | M1-BE-06、M2-BE-03 |
| M2-OPS-01 | Ops | 生产 Dockerfile（Linux，web/api/worker，worker 含 FFmpeg 与中文字体如 Noto Sans CJK，并在镜像内跑 render 测试，生产为 Ubuntu amd64 + Docker，开发机 arm64 也要能本地构建）、Compose、备份与恢复脚本 | M1-BE-06 |
| M2-OPS-02 | Ops + BE-Core | 七牛真实桶联调（**需用户授权并写明费用上限**）：表单上传（小对象）、分片上传 v2（大于 8MB，含失败 abort）、签名下载链接（含中文与空格的 key、`attname` 文件名是否生效、过期后 401）、删除（含对象不存在）；联调后把结论写进 `engine/README.md` | 联调记录与结论；若 `attname` 或 key 编码与预期不符，据实调整 `signedUrl` | M1-ENG-03 |
| M2-QA-01 | Lead | 浏览器端到端验收（手机 + PC，模拟上游）+ 代码审查 | 以上全部 |

## M3 上线准备

### 易支付充值（PRD 6.4，2026-10-17 用户确定；业务依赖 BE-02 已就绪，可提前并行开发）

| ID | 角色 | 任务 | 验收 | 依赖 |
|---|---|---|---|---|
| M3-PAY-01 | BE-Core | `payments/`：`createEzfpClient`（签名、验签、下单、查单、关单、退款、验通知）+ 模拟易支付服务（测试用）+ 迁移 `payment_orders` + `newId` 前缀 `po` + 配置与 `.env.example`（密钥只来自环境变量） | 签名与验签用本地生成的 RSA 密钥对测试；待签名串规则（非空、排序、不含 sign/sign_type）；元 ⇄ 分只用整数运算，覆盖 `0.1`、`1`、`1.00`、`1.005`（拒绝）；缺密钥时支付关闭 | M1-BE-02 |
| M3-PAY-02 | BE-Core | 充值订单服务与接口（API.md §3.1）、`GET /api/v1/payments/ezfp/notify` 回调、`payments.reconcile` 对账任务（接入 `queue/cron.js` 的调度） | 重复通知只入账一次；金额不符、`pid` 不符、验签失败、非 `TRADE_SUCCESS`、查单未支付都不入账；并发通知只入账一次；过期订单后到的支付仍入账；对账补入账与关单；同时 3 单上限与每小时 10 单限流；下单失败不留 created 订单；账本对账正确 | M3-PAY-01 |
| M3-PAY-03 | Web | 钱包页「充值」、充值页、结果页（types.ts 与 mock 同步 API.md §3.1，mock 模拟支付完成）；内置浏览器提示 | 手机 390 与 PC 1280 走查截图；`npm run check` 与 build 通过 | M3-PAY-02 契约 |
| M3-PAY-04 | Ops | 公网 HTTPS 回调域名与反向代理（放行 notify，不被登录和 CSRF 拦截）、环境变量注入说明、沙箱联调手册 | **真实小额支付联调前必须得到用户明确授权并写明金额上限**（AGENTS.md §6）；联调后固化 PRD 6.4 里「文档未写明」的 5 项细节 | M3-PAY-02 |

### 其他

**M3-ADM-01 运营后台·渠道管理页**（Web，依赖 M2-BE-03）：渠道列表（状态 / 健康度 / 在途数 / 掩码凭证）、按驱动 `configSchema` 渲染的新增 / 编辑表单、软删除、测试连接 / 试生成（二次确认）、路由排序与一键切换、启停、重新加载配置、告警红点；PC 优先。UI 完成前用 API 操作。

运营后台（SKU 价格与档位映射、音频素材、风格、运营配置、用户、订单、失败任务）、内容安全审核、AI 标识合规复核、用户协议与隐私政策、备案材料配合、微信环境适配。
