# M3-ADM-04 复审交接资料（Lead，2026-11-13）

> **状态：审查中止，移交开发 Agent。** 用户 2026-11-13 决定 Lead 角色退出，后续审查、合并与推送 `main` 由开发 Agent 自己完成。
> 本文件记录 Lead 已经做完的复核、结论、未验证事项与收尾清单。分支：`agent/be/M3-ADM-04-pricing-config` @ `a755725`（= `1d9bef0` 修复与测试 + `a755725` 记录与截图）。
> 本文件**不含任何密钥、管理员密码或用户数据**；命令里出现的凭据一律是占位符。

---

## 1. 结论摘要

| 项目 | 结果 |
|---|---|
| 三处必改的实现 | ✅ 全部落地（见 §2） |
| 建议 a / b / c | ✅ 全部落地（见 §2） |
| `test:server` | ✅ 511/511（worktree 全新建 `npm ci` 后跑） |
| `npm run check` / `npm run build` | ✅ 通过 |
| 真实后端复核（四项） | ✅ 全部符合预期（见 §3） |
| Lead 自己的双端浏览器走查 | ❌ **未做**（工具故障，见 §4） |

因此**不能**把这轮视为「审查通过」。开发 Agent 合并前必须补做双端走查。

---

## 2. 三处必改与建议的落地位置（代码核对结果）

### 必改①：前端写失败仍提示成功
- `apps/web/src/pages/admin/PriceConfigPage.vue`：`run()` 改为 `Promise<boolean>`，成功 `return true`，401/CSRF 与普通错误都 `return false`；
- 8 处写操作（调价、档位、换映射、风格新增/编辑、风格上下架、音色新增/编辑、音色上下架、运营参数）都加了 `const saved = await run(...); if (!saved) return;`；
- 失败时弹窗、已填内容与 `draftSettings` 都保留；调价弹窗的幂等键在 `openSkuDialog` 时生成、成功后随关窗重建，所以「失败 → 改对参数 → 同键重试」不会被 409 拒。

### 必改②：未来生效价被当成当前价
全仓 `FROM skus` 扫过一遍，10 处取当前价查询都已补 `effective_at <= now()`：

| 文件 | 位置 |
|---|---|
| `server/src/projects/money.js` | `videoUnitFen` |
| `server/src/projects/service.js` | `buildPricing` 形象 SKU、确认点 A 形象任务、`retryProject` 形象任务、`createSegmentTake` |
| `server/src/projects/segment.js` | 分段下单 |
| `server/src/projects/understand.js` | `videoSkuForMapping` |
| `server/src/projects/compose.js` | 成片分辨率 |
| `server/src/channels/service.js` | 成本对照 |
| `server/src/characters/service.js` | 形象分辨率解析 |

### 必改③：运营参数改了不生效
- `server/src/projects/service.js` 新增导出 `settingNumber(t, key, fallback)`（settings 优先、env 兜底，同一事务内读）；
- `assertStoryText` 进事务、按 `min_story_chars` / `max_story_chars` 校验，不再写死 3000；
- `createProject` 与 `reanalyzeProject` 的 `consumeFreeQuota` 改用 `daily_free_understanding`；
- `compose.js` 的 `expires_at` 改用 `retention_days`；
- `api/projects.js` 的 `storyText` 长度上限放宽到白名单硬上限 20000（真实上下限由 settings 决定）；
- `reanalyzeProject` 校验顺序改为 状态 → 文本 → 免费次数。

### 建议项
- **a 审计 IP**：`channels/admin-auth.js` 的 `audit()` 写 `ip` 列；登录成功/失败/封禁与登出都带 IP（`logout` 改为返回 `admin_id`，由路由层写 `auth.logout` 审计）；`admin-projects.js`、`admin-users-orders.js` 的 audit helper 也补了 `ip`。
- **b 音频识别**：`api/uploads.js` 的 `detectAudioMime` 只在 ftyp brand 含 `M4A` 时按 m4a 收，`isom` 等普通 MP4 视频拒收。
- **c 价格上限**：`priceFen` 上限 10000 分（¥100/单位），路由 + 前端 + mock 三处同口径。

---

## 3. 真实后端复核（可复现）

### 3.1 环境搭建（隔离库，零模型费用）
```bash
# 测试库容器（部署文件见 deploy/compose.test.yml）
docker start miv-test-postgres-1
docker exec miv-test-postgres-1 pg_isready -U miv

# 隔离库
docker exec -e PGPASSWORD=miv_test_only miv-test-postgres-1 \
  psql -h 127.0.0.1 -U miv -d postgres -c "CREATE DATABASE miv_ui OWNER miv"

# 环境变量（写到本地文件后 source，不要提交）
cat > /tmp/ui.env <<'EOF'
NODE_ENV=development
DATABASE_URL=postgres://miv:miv_test_only@127.0.0.1:56432/miv_ui
PORT=3300
ALLOWED_ORIGINS=http://localhost:5199
SMS_PROVIDER=console
STORAGE_DRIVER=memory
COOKIE_SECURE=false
EOF

cd server && set -a && . /tmp/ui.env && set +a
node src/db/migrate.js                                   # 16 个迁移
node scripts/admin-create.js <用户名> '<至少12位密码>'    # 位置参数，不是 --username
nohup node src/app.js > /tmp/api.log 2>&1 &

# 前端
cd ../apps/web && VITE_USE_MOCK=false VITE_API_TARGET=http://127.0.0.1:3300 npx vite --port 5199
```
接口前缀是 **`/api/v1`**（不是 `/api`）。管理员会话用独立 Cookie `miv_admin`；写操作要带 `Origin: http://localhost:5199` 与 `x-csrf-token`（登录响应的 `csrfToken`）。
用户侧验证码从 API 日志 `[sms:dev] … 验证码是 NNNNNN` 取。

### 3.2 四项复核结果

| # | 操作 | 预期 | 实测 |
|---|---|---|---|
| 1 | `POST /admin/skus/llm.mock/versions` `{priceFen:100, idempotencyKey:"x"}` | 400 `VALIDATION_FAILED`「LLM 的用户价固定为 0（平台承担），不能设置价格」 | ✅ 400 |
| 1b | 同一 `idempotencyKey` 改 `{priceFen:0}` 重试 | 200，新版本 v2 | ✅ 200 / v2（不被 409 误拒） |
| 2 | 给 `video.480p` 插入明天生效的 999 后：`GET /admin/skus`、`GET /admin/tiers`、`GET /catalog` | 当前价仍 100 分/秒；目录 `standard.pricePer30sFen = 3000` | ✅ 100 / 100 / 3000 |
| 3 | `PATCH /admin/settings` `{min_story_chars:50, max_story_chars:100}` 后创建作品：3 字 / 101 字 / 80 字 | `STORY_TOO_SHORT` / `STORY_TOO_LONG` / 201 | ✅ 全部符合 |
| 4 | `POST /admin/skus/video.480p/versions` `{priceFen:10001}` | 400 | ✅ 400 |

做完请 `DROP DATABASE miv_ui WITH (FORCE)` 并停掉本地服务。

---

## 4. 未验证事项（必须如实记录）

- **Lead 自己的双端浏览器走查没有做。** 审查期间自动模式的命令安全分类服务持续不可用，`curl` / `git` / `playwright-cli` / 写文件全部被拒，直到移交时仍未恢复。
- 分支自带截图 `docs/m3-adm04/1280-20-llm-price-fail.png`、`1280-21-llm-price-retry-ok.png`、`1280-22-future-version.png`、`1280-23-audit-ip.png`、`375-10-pricing-top.png`、`375-11-llm-price-fail.png`，Lead 逐张核对过内容，与上述接口验证一致；但**截图不能替代独立走查**，尤其 375 端只覆盖了失败弹窗一个观察点。
- 开发 Agent 合并前请自己补一遍：PC 1280 + 移动端真仿真（375×812 或 390×844，触屏 + iPhone UA），覆盖调价失败路径、未来生效版本、运营参数保存，截图带宽度前缀入 `docs/m3-adm04/`。

---

## 5. 本轮新发现（不阻塞，但需处理）

1. **立即生效的新版本会作废尚未生效的未来版本。** `server/src/admin/pricing-config.js` 的 `createSkuVersion` 在立即生效时执行
   `UPDATE skus SET status='inactive' WHERE sku_code=$1 AND version<$2 AND status='active'`，
   会把未来生效版本也置为 `inactive`。运营先安排「明天涨到 1.5」、今天又临时降价「立即 0.8」→ 明天不会涨回 1.5。
   行为可解释为「最新决策覆盖旧安排」，但 `docs/API.md` §8.4 目前只写「未来版本到点自动切换」，**需要补一句说明**。
2. **前端「另有历史/未生效版本 N 个」的判断口径**（`PriceConfigPage.vue`：`sku.version < sku.versions`）在立即生效后不再提示历史版本。非错误，可与文案统一。
3. **m4a 识别偏保守**：只认 brand 含 `M4A` 的 ftyp；major=`mp42`、compatible brands 不含 `M4A` 的部分 m4a 会被拒。建议先保持，遇到真实反馈再放宽并补测试。
4. **`retention_days` 只影响新生成的成片**：`expires_at` 在成片生成时计算，已有成片保存期不随后台调整变化。语义合理，建议在 API.md 或后台页面写明。

---

## 6. 交给开发 Agent 的收尾清单

- [ ] 补做双端走查（PC 1280 + 移动端真仿真），截图入 `docs/m3-adm04/`
- [ ] `docs/API.md` §8.4 补「新增立即生效版本会作废尚未生效的未来版本」
- [ ] 后台运营参数页/API.md 补「保存期只影响之后生成的成片」
- [ ] `git merge origin/main`、跑 `test:server` / `check` / `build`
- [ ] 合并并推送 `main`（此后不再经过 Lead 审查）
- [ ] 按 AGENTS.md §9 启动局域网 mock 预览并给美工地址
- [ ] 更新 `CODEX_HANDOFF.md` §2 认领表状态与 §7 记录

---

## 7. 安全说明

本次入库的只有文档与截图。**没有**包含密钥、凭据、管理员密码、`.env` 内容或用户数据。本地临时文件（`/root/miv-review/`、worktree `/root/mini-ai-video-wt`、隔离库 `miv_ui`）均未入库，开发 Agent 不需要，可直接删除。
