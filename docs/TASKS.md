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
| M0-02 | 真实模型验证：6 风格形象、30 秒多镜头 + 图片/音频参考一致性、尾帧衔接、多片段声音一致、每秒成本、可选时长与分辨率、单次故事理解 LLM 成本 | `docs/m0/report.md`：结论、成本表、推荐 SKU 与档位映射 | M0-01、用户授权 |

## M1 骨架跑通（模拟上游，零真实费用）

| ID | 角色 | 任务 | 验收 | 依赖 |
|---|---|---|---|---|
| M1-BE-01 | BE-Core | 认证：短信验证码（provider 可注入，开发环境打印到控制台）、会话、CSRF + Origin、PG 限流；`PATCH /me/onboarding` | 未登录 401；CSRF 缺失 403；冷却与错误次数上限；新用户 `tourCompletedAt=null` | L-02 |
| M1-BE-02 | BE-Core | 钱包与计价：账本、SKU/档位映射取价、`/quotes` 四种 kind、`/quotes/estimate`、预占/结算/退回/直接扣费、兑换码（只存哈希） | 并发预占不超扣；幂等重放；同键不同参数 409；调价后旧报价 `QUOTE_MISMATCH` | M1-BE-01 |
| M1-BE-03 | BE-Core | 定时任务调度（基于 `enqueue` + 去重键按时间窗口入队）：`projects.expire_sweep`、`uploads.sweep`、`auth.sweep`（清理过期 `rate_counters` 窗口、已作废/过期 `sms_codes`、过期 `sessions`）、已完成 `jobs` 归档；队列核心已在 L-02 完成 | 多 Worker 同时启动只入队一次；清理任务幂等 | L-02 |
| M1-BE-04 | BE-Core | 数字资产库与上传：`/uploads/*`、`/characters/**`、形象生成（job `look.generate`，调用 engine 模拟适配器） | 用户隔离（他人资源 404）；版本只增不改；软删除不影响历史作品 | M1-BE-02、M1-BE-03 |
| M1-BE-05 | BE-Core | 作品状态机与各 job（§4 ARCHITECTURE），engine/render 先用桩实现 | 模拟上游下从创建跑到 delivered；两个确认点；暂停/恢复/取消/重试；重启续跑；免费次数限制（「每天」按北京时间 00:00 切日）；`voicesEnabled` 规则 | M1-BE-04、M1-ENG-01、M1-ENG-02 |
| M1-BE-06 | BE-Core | 作品 API（API.md §6）+ SSE + 交付后片段替换与重新拼接 + 下载 | 契约测试：响应结构与 `types.ts` 一致；状态不允许时 409 | M1-BE-05 |
| M1-ENG-01 | Engine | `engine/story`：pi agent 接入、`understand` / `bindPrompts`（ARCHITECTURE §5），时长约束、角色匹配、音色推荐，模拟 LLM | 单测覆盖：时长只取 allowedDurations、总时长 ≤ max、超长精简提示、单片段不出音频参考 | – |
| M1-ENG-02 | Engine | `engine/providers`：适配器注册表 + wan3.0 / seedance2.5 视频（图片+音频参考、首帧）+ 图片模型适配器 + 模拟上游 | submit/query/normalize 单测；提交结果未知的分类 | – |
| M1-ENG-03 | Engine | `engine/net` `engine/storage`（七牛 Kodo + 签名链接）`engine/transfer` `engine/extract` | SSRF/大小/超时测试；存储用内存实现可替换 | – |
| M1-RND-01 | Render | `render.compose`：拼接、响度统一、硬切/尾帧衔接、AI 生成标识（显式 + 元数据）、封面；`extractLastFrame` | 用 FFmpeg 生成的测试视频做合成测试（不需要真实模型） | – |
| M1-WEB-01 | Web | 在 L-04 骨架上打磨首页、资产库、作品列表、作品详情各视图（mock） | 375px 与 1280px 截图；`npm run check` 与 build 通过 | L-04 |
| M1-WEB-02 | Web | 新手引导打磨：定位、自动避让、键盘与焦点、减少动态效果、场景小提示 | 手机/PC 各走一遍主引导与 3 个小提示截图 | L-04 |

## M2 MVP 内测

| ID | 角色 | 任务 | 依赖 |
|---|---|---|---|
| M2-BE-01 | BE-Core | 接入真实渠道（按 M0 结论配置 SKU 与档位映射）、对账与 unknown 处理工具 | M0-02、M1-BE-06 |
| M2-BE-02 | BE-Core | 保存期清理与到期提醒数据、上传清理 | M1-BE-06 |
| M2-WEB-01 | Web | 前端切换真实 API，联调全部流程；SSE | M1-BE-06 |
| M2-OPS-01 | Ops | 生产 Dockerfile（web/api/worker，worker 含 FFmpeg）、Compose、备份与恢复脚本 | M1-BE-06 |
| M2-QA-01 | Lead | 浏览器端到端验收（手机 + PC，模拟上游）+ 代码审查 | 以上全部 |

## M3 上线准备（细化前与用户确认）

支付（微信/支付宝）与对账、运营后台（SKU 价格与档位映射、音频素材、风格、运营配置、用户、订单、失败任务）、内容安全审核、AI 标识合规复核、用户协议与隐私政策、备案材料配合、微信环境适配。
