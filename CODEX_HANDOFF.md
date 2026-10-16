# CODEX_HANDOFF — 多 Agent 协作同步

> 所有 Agent 开工前先读本文件，结束时更新本文件。规则见 [AGENTS.md](./AGENTS.md) §8。
> 本文件只追加和更新状态，**不要删除他人的记录**。

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
| M1-BE-01 | — | — | — | 待认领 | — |
| M1-BE-02 ~ 06 | — | — | — | 待认领（BE-Core 串行） | — |
| M1-ENG-01 | — | — | — | 待认领 | — |
| M1-ENG-02 | — | — | — | 待认领 | — |
| M1-ENG-03 | — | — | — | 待认领 | — |
| M1-RND-01 | — | — | — | 待认领 | — |
| M1-WEB-01 | — | — | — | 待认领 | — |
| M1-WEB-02 | — | — | — | 待认领 | — |

状态取值：待认领 / 进行中 / 待合并 / ✅ 完成 / ⛔ 阻塞（写原因）。

## 3. 决策记录（最新在上）

| 日期 | 决策 | 来源 |
|---|---|---|
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

## 6. 变更记录（最新在上）

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
