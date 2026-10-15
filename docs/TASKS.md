# 任务拆分（v0.1，2026-10-15）

> 认领、状态和交接记录统一写在 `CODEX_HANDOFF.md`。这里只描述任务本身。依赖未完成的任务不要开工。

## M0 技术验证（Lead；需用户授权真实费用）

| ID | 任务 | 产出 | 依赖 |
|---|---|---|---|
| M0-01 | 准备 3 个样例剧本（对白型、动作型、单人独白型） | `docs/m0/samples/*.md` | – |
| M0-02 | 对比 4 种一致性方案：纯文生视频 / 定妆图+图生视频 / 多参考图视频 / 三视图角色卡 | `docs/m0/report.md`：一致性评分、单片成本、耗时、推荐方案 | M0-01、用户授权 |

## M1 引擎与骨架

| ID | 角色 | 任务 | 验收 | 依赖 |
|---|---|---|---|---|
| M1-OPS-01 | Ops | 测试用 PG Compose（项目 `miv-test`，端口 `127.0.0.1:56432`，tmpfs）与 `npm run test:services:up/down` | 能启动、能连接 | – |
| M1-BE-01 | BE-Core | `server` 包骨架：ESM、配置加载、`db/`（连接池、事务、嵌套 savepoint）、迁移执行器、`001-init.sql` | 迁移可重复执行；事务测试 | M1-OPS-01 |
| M1-BE-02 | BE-Core | 认证：短信验证码（provider 可注入，开发环境走控制台模拟）、会话、CSRF、PG 限流 | 未登录 401、CSRF、冷却、错误次数上限测试 | M1-BE-01 |
| M1-BE-03 | BE-Core | 钱包：账本、报价、预占/结算/退回、兑换码（只存哈希） | 并发预占不超扣；幂等重放；同键不同参数冲突 | M1-BE-02 |
| M1-BE-04 | BE-Core | 队列：jobs 领取（SKIP LOCKED）、租约、退避；Worker 入口 | 多 Worker 并发不重复领取；崩溃后租约过期可重新领取 | M1-BE-01 |
| M1-ENG-01 | Engine | 迁移剧本引擎（prompts/tools/sanitize/llm），拆成「剧本方案」和「制作版分镜」两段 | 用模拟 LLM 跑通单测 | – |
| M1-ENG-02 | Engine | 渠道适配器注册表 + modelhub-wan-3.0 / 图片模型适配器 + 模拟上游 | submit/query/normalize 单测 | – |
| M1-ENG-03 | Engine | 网络安全、对象存储、转存模块迁移 | SSRF/大小/超时测试 | – |
| M1-BE-05 | BE-Core | 项目状态机 + 各阶段 job（planning→…→composing），接入 engine 与 render 接口（render 先用桩实现） | 一键模式在模拟上游下跑到 delivered；重启后能续跑 | M1-BE-03、M1-BE-04、M1-ENG-01、M1-ENG-02 |
| M1-BE-06 | BE-Core | API 路由（按 `docs/API.md` 第 1~4 节）+ SSE | 契约测试（响应结构与 types.ts 一致） | M1-BE-05 |
| M1-RND-01 | Render | FFmpeg 拼接（从 editor.js 迁移）+ 字幕烧录（台词转 SRT/ASS） | 样例视频合成测试 | – |
| M1-WEB-01 | Web | 在 UI 骨架上完成首页、新建、作品列表、登录页的真实交互（mock） | 375px 与 1280px 截图；`npm run check` 与 build 通过 | 骨架已完成 |
| M1-WEB-02 | Web | 项目详情：步骤条 + 5 个阶段视图（mock 模拟进度） | 一键模式与精修模式两种流程都能走完 | M1-WEB-01 |

## M2 MVP

| ID | 角色 | 任务 | 依赖 |
|---|---|---|---|
| M2-BE-01 | BE-Core | API 第 5~8 节：剧本编辑与重新生成、资产版本与选择、镜头编辑与 take、渲染 | M1-BE-06 |
| M2-ENG-01 | Engine | 按 M0 结论实现一致性方案（图生视频或多参考） | M0-02 |
| M2-RND-01 | Render | BGM、AI 生成标识水印、封面抽帧 | M1-RND-01 |
| M2-WEB-01 | Web | 前端切换到真实 API，联调全部流程；钱包与兑换码 | M2-BE-01 |
| M2-OPS-01 | Ops | 生产 Dockerfile（web/api/worker）、Compose、备份与恢复脚本 | M1-BE-06 |
| M2-QA-01 | Lead | 浏览器端到端验收（手机 + PC，模拟上游） | 以上全部 |

## M3 上线准备（大纲，细化前与用户确认）

支付（微信/支付宝，参考影策 payment-plugins 的设计）与对账、内容安全审核、分享页、运营后台、备案材料配合。
