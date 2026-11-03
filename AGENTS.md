# Mini AI Video 多 Agent 开发约定

> 本文件是所有 Agent 的强制约束。产品范围见 [docs/PRD.md](./docs/PRD.md)，架构见 [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)，接口契约见 [docs/API.md](./docs/API.md)，界面规范见 [docs/UI.md](./docs/UI.md)，任务拆分见 [docs/TASKS.md](./docs/TASKS.md)。协作同步只走 [CODEX_HANDOFF.md](./CODEX_HANDOFF.md)。

## 0. 开工前必读顺序

1. 本文件 → 2. `CODEX_HANDOFF.md`（状态看板、认领表、最新决策、待用户确认问题）→ 3. 与你任务相关的 `docs/*.md` → 4. 相关代码。
不读 handoff 就动手，等于在别人正在改的文件上写代码。

## 1. 产品与技术基线（已由用户确认，2026-10-15；产品范围以 2026-10-16 定稿的 PRD v2.2 为准）

- 产品：C 端「剧本/想法 → 一键成片」，**移动端优先，PC 端必须可用**（响应式，不是只做手机）。正式名称：中文名「**剧优兔AI**」，英文名「**JoyoTo**」，slogan「剧优兔，一键出好剧，轻松赚收益」（用户 2026-11-03 决定）；开发代号 Mini AI Video 只保留在仓库名、包名等内部标识里，用户可见处一律用正式名称。
- 视觉：**浅色清新风**；样式只用 `apps/web/src/styles/tokens.css` 的设计令牌，禁止散落硬编码色值。
- 收费：**充值余额 + 按片预估扣费**，金额一律整数「分」（CNY），预占→结算→失败退回的事务账本，禁止浮点金额。
- 前端：Vue 3 + TypeScript + Vite + Vant 4 + Pinia + Vue Router（`apps/web`）。
- 后端：Node ≥22 ESM + Express 4 + PostgreSQL（`pg` 连接池，参数化 SQL，不引入 ORM）；PG 任务队列（`FOR UPDATE SKIP LOCKED`）；API 进程与 Worker 进程同仓不同入口；FFmpeg 只在 Worker 运行。M1~M2 不引入 Redis（限流放 PG），需要时再评估。
- 生成引擎复用超搭云（参考提交 `2926b42`；Lead 服务器上在 `/root/chaodayun`，其他设备按实际路径）已验证模块，复制进 `server/src/engine/`，文件头注明来源；**不得修改超搭云仓库任何文件、不得连接其数据库或生产环境**。迁移代码可进入本仓库（用户确认无需保密），但其中的密钥、内部域名、账号信息必须去除。
- 借鉴影策（open-ai-canvas, MIT）只借设计与协议；如拷贝任何文本/代码，必须保留版权声明并登记到 `NOTICE`。

## 2. 角色与文件所有权

| 角色 | 职责 | 拥有（可写）路径 |
|---|---|---|
| 主代理 (Lead) | 文档、接口契约、任务拆分、合并、独立验收、与用户沟通 | `AGENTS.md` `docs/**` `CODEX_HANDOFF.md` `README.md` 根配置 |
| 后端主线 (BE-Core) | 数据库→认证→钱包账本→项目状态机→队列→API→集成测试，**同一 Agent 串行负责**，禁止拆给多人并发猜接口 | `server/src/{config.js,http,db,auth,wallet,payments,catalog,characters,projects,queue,api}/**` `server/migrations/**` `server/test/**`（自己模块） |
| 引擎迁移 (Engine) | 从超搭云迁移并适配生成引擎（剧本 LLM、渠道适配、转存、网络安全、对象存储），提供纯函数/可注入接口与单测 | `server/src/engine/**` `server/test/engine/**` |
| 成片合成 (Render) | FFmpeg 拼接、响度统一、尾帧衔接、AI 生成标识（显式+隐式）、封面（**不做字幕、BGM**，PRD §4.4） | `server/src/render/**` `server/test/render/**` |
| 前端 (Web) | 按 `docs/API.md` + `docs/UI.md` 实现页面；先用 mock，联调时切真实 API | `apps/web/**` |
| 运维 (Ops) | Dockerfile、Compose、备份脚本、CI | `deploy/**` `Dockerfile*` `.github/**` |

- 跨所有权修改：先在 `CODEX_HANDOFF.md`「接口/跨域变更申请」登记，由所有者或主代理处理。
- `server/src/app.js`（组装入口）与 `server/src/worker.js` 同一时间只有一个写入者，默认 BE-Core。

## 3. 契约优先

- `docs/API.md` 是前后端唯一接口事实来源；`apps/web/src/api/types.ts` 必须与之一致。
- 改接口流程：在 handoff 提变更申请 → 主代理更新 `docs/API.md` → 后端实现 → 前端跟进。**禁止前后端各自先改再对齐。**
- 金额字段统一 `*Fen`（整数）；时间统一 ISO 8601 字符串（UTC）；ID 为带前缀的字符串（`prj_`、`chr_`、`seg_` …，前缀表见 `docs/API.md` §0）。
- 错误响应统一 `{ code, message, requestId }`，`message` 为面向用户的中文。

## 4. Git 与多 Agent 并行

- 远端仓库：`github.com/huawuhen/mini-video`（**公开仓库**，禁止提交密钥与用户数据）。跨设备协作的完整步骤见 `CODEX_HANDOFF.md` §0。
- 每个 Agent 在独立分支工作：`agent/<role>/<任务ID>-<简述>`（同一台机器上可配合 `git worktree`）；**只有主代理合并并推送 `main`**，开发 Agent 只推送自己的分支，审查结果见 `CODEX_HANDOFF.md` §6。
- 随做随提交：一个功能/修复一个提交；提交信息写「背景 / 受影响模块 / 验证结果」。禁止 `reset --hard`、`clean -fd`、`push --force`、改写已合并历史；回退一律反向提交。
- 推送前必须：`git merge origin/main` 跟上最新 `main` 并解决冲突（已推送的分支不要 rebase）、跑通 `npm run test:server` 与 `npm run check`、`npm run build`。

## 5. 开发原则

- 移动端优先：先在 375px 宽设计与验证，再适配 ≥1024px PC 布局（见 `docs/UI.md`）。
- 用户界面只显示中文业务名称；内部 ID、原始错误码、JSON 只放「技术详情」折叠区。
- 生成任务：提交前报价、预占；上游提交结果未知时保持冻结、**不自动重提**；只停止本地追踪不等于退款。
- 替换类操作（资产版本、镜头 take）一律「新增候选 + 切换选中」，**永不覆盖旧版本**。
- 数据库写事务短小，禁止在事务内等待上游网络调用。
- 安全：业务 API 默认要求登录；写操作校验同源 + CSRF；上传/下载过网络安全模块（SSRF、大小、超时）；日志脱敏；密钥只在服务端环境变量，禁止输出 `.env` 内容。
- 合规（上线前必须完成，见 PRD §11）：内容安全审核、AI 生成内容显式+隐式标识、手机号实名、用户协议与隐私政策。

## 6. 测试与验证

- **运行环境**：开发在 Mac，**上线运行在 Linux 云服务器**。FFmpeg、字体、路径、磁盘一律按 Linux 容器设计；不得依赖 Mac 特有行为或本机路径；平台相关的东西（FFmpeg 滤镜、原生依赖）要在 Linux 上验证，详见 `CODEX_HANDOFF.md` §3 的 2026-10-20 条。

- 前端：`npm run check -w apps/web`（vue-tsc 类型检查）与 `npm run build -w apps/web`。
- 后端：`node --test`；测试使用隔离 PostgreSQL（Compose 项目 `miv-test`，端口 `127.0.0.1:56432`），模拟上游，**不产生任何真实模型费用**。
- 真实模型调用（如 M0 技术验证）必须先在 handoff「待用户确认」中获得用户明确授权，并写明费用上限。
- 报告必须列出：改动、测试结果、未验证事项；不能因单测通过就声称真实供应商/生产已验证。
- **浏览器走查必须移动端 + PC 端各走一遍**（用户 2026-11-03 要求）：用 ego-browser（或其他浏览器工具）核查页面时，除 PC（1280 宽）外，**必须开启移动端仿真再走一遍同样的流程**——视口 **375×812**（或 390×844），开启触屏与移动设备模式，UA 用 iPhone Safari；涉及微信内行为（微信支付、授权）的页面，再用微信 UA（含 `MicroMessenger`）走一遍。只缩小窗口宽度不算移动端仿真。
  - 运营后台（`/admin/*`）以 PC 为主，移动端只需确认能打开、不横向溢出、主要按钮可点。
  - §7 记录与完成回复里写明两端各走了哪些步骤，截图文件名带宽度前缀（如 `375-01-xxx.png`、`1280-01-xxx.png`）；只走了一端的，审查一律退回。

## 7. 与用户沟通

- 用户要求「多互动沟通」：遇到产品取舍（流程、文案、价格、视觉、范围）先问用户，不要自行拍板；纯技术实现细节按本文件与文档自行决定。
- 用户的新决策当天写入 `CODEX_HANDOFF.md`「决策记录」，必要时同步 `docs/*`。

## 8. 交接记录

每次完成一个任务（或中途停止）都在 `CODEX_HANDOFF.md`「变更记录」追加一条：日期、角色、任务 ID、背景、受影响文件、核心实现、验证结果、未完成/风险。并更新「认领表」状态。

## 9. 局域网预览（给美工看，用户 2026-11-03 要求）

美工与开发设备在同一局域网，需要看到项目当前的样子。**开发时停止预览，开发完成（推送后）启动预览**；不需要为预览单独建分支，也不需要一直开着：

1. 任务完成并推送后，在当前工作目录执行：`VITE_USE_MOCK=true npm run dev:web`（Vite 已配置 `host: true`，监听局域网，端口 5173）。
2. 只用 **mock 模式**：不连真实后端、不需要任何密钥、不产生任何费用；页面数据、生成进度、充值「模拟支付成功」都是演示数据。**禁止**为了预览把带真实密钥的后端暴露到局域网。
3. 查本机局域网 IP（macOS：`ipconfig getifaddr en0`），在 `CODEX_HANDOFF.md` §7 本次记录末尾写一行「局域网预览：`http://<IP>:5173`（分支 xxx）」，并在给用户的完成回复里同样给出。首次运行若 macOS 弹出「是否允许 node 接受传入连接」，选允许。
4. 美工使用说明（随地址一起给）：手机或电脑浏览器打开地址；登录时手机号任填 11 位、验证码任填 6 位数字；兑换码 `DEMO100` 可加余额；演示数据存在各自浏览器里，清除浏览器数据即重置。
5. 开始下一个任务前停止预览（Ctrl+C 或按 pid 结束）；下次完成时再启动。
