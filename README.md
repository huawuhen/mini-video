# Mini AI Video（代号）

面向宝妈、家庭记录者等零基础用户的 AI 视频工具：写一段故事，选好家人（数字人）、风格和画质，AI 自动理解故事、规划约 30 秒一段的片段、生成带原生声音的视频并拼接成片。移动端优先，PC 端可用。

> 当前阶段：**PRD v2.2 定稿 + 主体框架完成**（后端骨架、全量表结构、PG 队列；前端按新流程重建，mock 可完整演示）。业务模块由各 Agent 按 [docs/TASKS.md](./docs/TASKS.md) 开发。

## 文档

| 文档 | 内容 |
|---|---|
| [AGENTS.md](./AGENTS.md) | 多 Agent 开发约定（必读） |
| [CODEX_HANDOFF.md](./CODEX_HANDOFF.md) | 协作同步：状态看板、认领表、决策、变更记录 |
| [docs/PRD.md](./docs/PRD.md) | 产品需求（v2.2 定稿） |
| [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) | 架构、数据模型、状态机、模块接口、引擎复用清单 |
| [docs/API.md](./docs/API.md) | 前后端接口契约 v1.0 |
| [docs/UI.md](./docs/UI.md) | 设计令牌、断点、页面地图、组件、新手引导约定 |
| [docs/TASKS.md](./docs/TASKS.md) | 任务拆分与依赖 |

## 本地运行

```bash
npm install
# 前端（默认 mock，不需要后端）
npm run dev:web          # http://localhost:5173
npm run check            # 前端类型检查
npm run build            # 前端生产构建
# 后端
npm run test:db:up       # 隔离测试库 127.0.0.1:56432
npm run test:server      # 后端测试
npm run start:api -w server
npm run start:worker -w server
```

**mock 演示**：任意手机号 + 任意 6 位验证码登录。新号码视为新用户：自动开始新手引导，送 50 元体验金，并放入两个数字人（宝宝、妈妈，带「卡通 3D」形象）和两部示例作品（一部 5 天后过期、一部已过期）。兑换码 `DEMO100` 加 100 元。故事约 120 字以内规划 1 段（不显示声音），更长规划 2~3 段。数据存在浏览器 localStorage（`miv-mock-v2`）。

联调真实后端：`apps/web/.env.local` 写 `VITE_USE_MOCK=false`，`/api` 代理到 `VITE_API_TARGET`（默认 `http://127.0.0.1:3000`）。

## 技术栈

- 前端：Vue 3 + TypeScript + Vite + Vant 4 + Pinia + Vue Router
- 后端：Node 22 + Express 4 + PostgreSQL（`pg`，无 ORM，PG 任务队列），API 与 Worker 分进程，FFmpeg 只在 Worker
- 存储：七牛 Kodo；生成引擎迁移自内部项目超搭云
