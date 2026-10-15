# Mini AI Video（代号）

面向 C 端的「剧本 → 一键成片」平台：输入或上传剧本，AI 自动写分镜、生成角色与场景、逐镜生成视频并合成成片；过程中可以查看、替换、确认每一步。移动端优先，PC 端可用。

> 当前阶段：**大纲 + 前端 UI 骨架**（mock 数据）。后端尚未开工，见 [docs/TASKS.md](./docs/TASKS.md)。

## 文档

| 文档 | 内容 |
|---|---|
| [AGENTS.md](./AGENTS.md) | 多 Agent 开发约定（必读） |
| [CODEX_HANDOFF.md](./CODEX_HANDOFF.md) | 协作同步：状态看板、认领表、决策、变更记录 |
| [docs/PRD.md](./docs/PRD.md) | 产品需求大纲、流程、计费、合规、里程碑 |
| [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) | 架构、目录、引擎复用清单、数据模型 |
| [docs/API.md](./docs/API.md) | 前后端接口契约 |
| [docs/UI.md](./docs/UI.md) | 设计令牌、断点、页面地图、组件清单 |
| [docs/TASKS.md](./docs/TASKS.md) | 任务拆分与依赖 |

## 本地运行前端（mock 模式）

```bash
npm install
npm run dev:web          # http://localhost:5173
npm run check            # 类型检查
npm run build            # 生产构建
```

mock 模式（默认）演示要点：登录时任意手机号 + 任意 6 位验证码；初始余额 50 元；兑换码 `DEMO100` 可再加 100 元；新建作品后进度按时间自动推进，「逐步确认」模式会在剧本、角色、分镜三处停下等待确认。数据保存在浏览器 localStorage（`miv-mock-v1`）。

联调真实后端：`apps/web/.env.local` 写 `VITE_USE_MOCK=false`，`/api` 会代理到 `VITE_API_TARGET`（默认 `http://127.0.0.1:3000`）。

## 技术栈

- 前端：Vue 3 + TypeScript + Vite + Vant 4 + Pinia + Vue Router
- 后端（计划）：Node 22 + Express + PostgreSQL（无 ORM，PG 队列），API 与 Worker 分进程，FFmpeg 合成
- 生成引擎：迁移自内部项目超搭云
