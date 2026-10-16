# server

Node 22 ESM + Express 4 + PostgreSQL（`pg`，无 ORM）。API 与 Worker 同一份代码、不同入口。
设计见 `docs/ARCHITECTURE.md`，接口见 `docs/API.md`，任务见 `docs/TASKS.md`。

## 常用命令（在仓库根目录）

```bash
npm run test:db:up        # 启动隔离测试库（127.0.0.1:56432，tmpfs）
npm run test:server       # node --test，全部测试
npm run migrate -w server # 对 DATABASE_URL 执行迁移
npm run start:api -w server
npm run start:worker -w server
npm run test:db:down
```

## 目录与约定

| 路径 | 说明 | 状态 |
|---|---|---|
| `src/config.js` | 唯一读取环境变量的地方 | ✅ L-02 |
| `src/logger.js` | JSON 日志 + 脱敏 | ✅ L-02 |
| `src/http/` | `AppError`/`appError(code)`、requestId、错误中间件、`asyncHandler`、`Fields` 校验 | ✅ L-02 |
| `src/db/` | `createDb`（`query` / `tx` / 嵌套 `t.tx`）、`migrate`、`newId(prefix)` | ✅ L-02 |
| `src/queue/` | `enqueue` / `claim` / `complete` / `fail` / `extendLease`、`PermanentJobError` | ✅ L-02 |
| `src/catalog/` + `src/api/catalog.js` | `GET /catalog`、`GET /voices`（**新模块照此写法**） | ✅ L-02 |
| `src/app.js` / `src/worker.js` | 组装入口；新路由与 job 处理器在标注位置注册 | 骨架 ✅ |
| `src/auth` `wallet` `characters` `projects` `api/*` | BE-Core | M1 |
| `src/engine/` | Engine，接口见 `src/engine/README.md` | M1 |
| `src/render/` | Render，接口见 `src/render/README.md` | M1 |

- **service 层**接收 `db`（或事务作用域 `t`）与注入的依赖，返回符合 `docs/API.md` 的纯对象；**路由层**只做 `Fields` 校验、取当前用户、调用 service。
- 错误一律 `throw appError('CODE')`；新错误码先改 `docs/API.md §7` 再加到 `src/http/errors.js`。
- 金额 `*_fen` bigint，读出来是 Number；ID 用 `newId('prj')` 等（前缀表见 `src/db/ids.js`）。
- 状态迁移：一个短事务里「校验当前状态 → 写新状态和 `project_events` → `enqueue(t, …)`」，事务内不调用上游。
- job 处理器必须幂等；需要放弃重试时抛 `PermanentJobError`。
- 测试：`test/helpers/db.js` 的 `createTestDb()` 为每个测试文件建独立数据库；外部服务全部用模拟实现，**不产生真实费用**。
