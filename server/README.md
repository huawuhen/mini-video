# server（待 M1 实施）

尚无代码。由 BE-Core / Engine / Render 角色按 `docs/TASKS.md` 实施，结构与引擎复用清单见 `docs/ARCHITECTURE.md`。
入口约定：`src/app.js`（API）、`src/worker.js`（Worker）。测试：`node --test`，隔离 PG（Compose 项目 `miv-test`，端口 56432）。
