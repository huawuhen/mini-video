# CODEX_HANDOFF — 多 Agent 协作同步

> 所有 Agent 开工前先读本文件，结束时更新本文件。规则见 [AGENTS.md](./AGENTS.md) §8。
> 本文件只追加和更新状态，**不要删除他人的记录**。
> 协作方式：Lead（Claude，本机）负责文档、审查与合并；开发 Agent 在另一台设备开发。双方只通过 GitHub 仓库 `huawuhen/mini-video` 和本文件同步，流程见 §0。

## 0. 跨设备协作流程（必读）

**角色分工**

| 谁 | 在哪 | 做什么 | 可以推送 |
|---|---|---|---|
| Lead（Claude） | 服务器 `/root/mini-ai-video` | 文档与接口契约、审查、合并到 `main`、与用户沟通 | `main`（只有 Lead） |
| 开发 Agent | 另一台设备 | 认领 `docs/TASKS.md` 的任务并实现、写测试、更新本文件 | 自己的 `agent/*` 分支 |

**开发 Agent 每个任务的固定步骤**

1. 同步：`git fetch origin && git switch main && git merge --ff-only origin/main`。
2. 读：`AGENTS.md` → 本文件（尤其 §2 认领表、§4 待确认、§6 审查记录里给你的意见）→ 任务相关的 `docs/*.md`。
3. 建分支：`git switch -c agent/<role>/<任务ID>-<简述> origin/main`，例如 `agent/be/M1-BE-01-auth`。一个任务一个分支。
4. 认领：在 §2 认领表把该任务改成「进行中」，填分支名，作为分支上的第一个提交。
5. 开发：一个功能 / 修复一个提交，提交信息写「背景 / 受影响模块 / 验证结果」。只改自己角色拥有的路径（AGENTS.md §2）；要改别人的路径或 `docs/API.md`，先在 §5 提变更申请。
6. 自测（全部通过才能推送）：
   ```bash
   npm ci
   npm run test:db:up && npm run test:server   # 后端
   npm run check && npm run build              # 前端（改了前端时）
   ```
7. 收尾：在 §7 变更记录**追加**一条（模板在文末），§2 状态改成「待审查」。
8. 推送：`git push -u origin agent/<role>/<任务ID>-<简述>`。然后告诉用户：「已推送 `<分支名>`，请 Lead 审查」。
9. 等待审查结果（§6）。需要修改时**在同一分支上追加提交**再推送，不要另开分支。

**硬性规则**

- 不推送 `main`；不 `push --force`（包括自己的分支）；不改写已推送的历史。需要跟上最新 `main` 时用 `git merge origin/main`，不要 rebase 已推送的分支。
- 本仓库是**公开仓库**：不提交任何密钥、`.env`、真实手机号、用户数据、上游临时链接；测试只用模拟上游。
- 不连接超搭云数据库或生产环境，不产生真实模型费用（AGENTS.md §6）。
- 遇到产品取舍（流程、文案、价格、范围）不要自己拍板，写进 §4「待用户确认」并在汇报里提出。
- 本文件冲突时保留双方内容（各段都是追加式的），不要删除对方记录。

**Lead 审查流程**

1. 收到通知后 `git fetch`，在独立 worktree 检出该分支（不在 `main` 工作区直接改）。
2. 检查：对照 PRD / `docs/API.md` / 任务验收标准逐项核对；代码审查（正确性、安全、事务边界、幂等、用户隔离、金额整数、错误码与中文文案）；重跑全部测试；涉及前端时用浏览器在手机 390 和 PC 1280 宽度走查。
3. 结果写在 §6：「✅ 通过并合并」或「🔁 需修改」+ 编号问题清单（文件:行号、原因、期望）。
4. 通过后 Lead 用 `git merge --no-ff` 合并进 `main` 并推送，§2 状态改为「✅ 完成」。

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
| M1-BE-01 | BE-Core（本机开发 Agent） | `agent/be/M1-BE-01-auth` | `server/src/auth/**` `server/src/config.js` `server/src/app.js` `server/test/auth.test.js` `server/.env.example` | ✅ 完成（Lead 复审通过并合并 `6a741a7`） | 2026-10-17 |
| M1-BE-02 | BE-Core（本机开发 Agent） | `agent/be/M1-BE-02-wallet` | `server/src/wallet/**` `server/src/api/{wallet,quotes}.js` `server/src/app.js` `server/src/auth/{session,index}.js` `server/test/wallet.test.js` | ✅ 完成（Lead 复审通过并合并） | 2026-10-17 |
| M1-BE-03 | BE-Core（本机开发 Agent） | `agent/be/M1-BE-03-cron` | `server/src/queue/cron.js` `server/src/worker.js` `server/src/config.js` `server/test/cron.test.js` | ✅ 完成（Lead 复审通过并合并） | 2026-10-17 |
| M1-BE-04 | BE-Core（本机开发 Agent） | `agent/be/M1-BE-04-assets` | `server/src/characters/**` `server/src/api/{uploads,characters}.js` `server/src/app.js` `server/src/worker.js` `server/src/config.js` `server/test/{assets.test.js,cron.test.js,helpers/providers.js}` `server/src/db/ids.js` | ✅ 完成（Lead 复审通过并合并） | 2026-10-17 |
| M1-BE-05 ~ 06 | — | — | — | 待认领（BE-Core 串行） | — |
| M1-ENG-01 | — | — | — | 待认领（下一步，建议顺序 ENG-03 → ENG-02 → ENG-01，各一个分支） | — |
| M1-ENG-02 | — | — | — | 待认领 | — |
| M1-ENG-03 | Engine（本机开发 Agent） | `agent/eng/M1-ENG-03-infra` | `server/src/engine/{net,storage,transfer,extract}/**` `server/src/{app.js,worker.js,queue/cron.js,db/ids.js}` `server/test/engine/**` | 待审查 | 2026-10-17 |
| M1-RND-01 | — | — | — | 待认领 | — |
| M1-WEB-01 | — | — | — | 待认领 | — |
| M1-WEB-02 | — | — | — | 待认领 | — |

状态取值：待认领 / 进行中 / 待审查 / 🔁 需修改 / ✅ 完成 / ⛔ 阻塞（写原因）。

**建议开工顺序**（只有一个开发 Agent 时）：M1-BE-01 → M1-BE-02 → M1-BE-03 → M1-ENG-01 / 02 / 03 → M1-BE-04 → M1-RND-01 → M1-BE-05 → M1-BE-06 → M1-WEB-01 / 02。ENG 与 BE 无代码依赖，有多个 Agent 时可并行。BE 系列必须串行，同一时间只开一个 BE 分支。

## 3. 决策记录（最新在上）

| 日期 | 决策 | 来源 |
|---|---|---|
| 2026-10-17 | **对象存储采用七牛原生协议，不用 S3 兼容**（更轻量、零额外依赖；超搭云用的是 S3 兼容，仅作配置参考）；实现必须符合七牛官方文档，见 ARCHITECTURE §6 | 用户 |
| 2026-10-17 | **支付接口使用易支付 V2（RSA）**，文档 https://www.ezfp.cn/doc/index.html，写入 PRD v2.3 §6.4；任务 M3-PAY-01~04 见 docs/TASKS.md；密钥只放环境变量；真实小额联调须先经用户授权 | 用户 |
| 2026-10-16 | 引擎迁移（M1-ENG-01~03）由开发 Agent 在其设备上完成，该设备有超搭云源码（以参考提交 `2926b42` 为准，路径按该设备实际位置）；超搭云代码可进入本公开仓库，无需保密、无需改私有 | 用户 |
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
6. 充值相关（PRD 6.4、§12 第 4 条）：预设金额与上限、充值退款政策、易支付商户资质 / 结算周期 / 费率、真实小额联调的授权与金额上限。

## 5. 接口/跨域变更申请

| 日期 | 申请人 | 内容 | 影响 | 处理结果 |
|---|---|---|---|---|
| — | — | — | — | — |

## 6. 审查记录（Lead 填写，最新在上）

| 日期 | 分支 / 任务 | 结论 | 问题清单 / 备注 |
|---|---|---|---|
| 2026-10-17 | `agent/eng/M1-ENG-03-infra` @ `d5d5c1b`（M1-ENG-03 第三轮） | 🔁 需修改（2 条必改，都在 `extract/index.js` 的新解析代码里） | 上轮的平方耗时改成了手写扫描，方向对，`contentType` 换行过滤也加了（建议项 2 ✅），测试 132/132、check、build 通过。但新代码带来 2 个问题，Lead 用探针复现：<br>**必须修改**<br>1. **真实的 Word 文档全部被拒绝（回归）**。`extractDocx` 里的「嵌套段落」检查用 `xml.indexOf('<w:p', start + 1)` 判断段落内是否又出现了段落，但 `<w:p` 同样是 `<w:pPr>`（段落属性，几乎每个 Word 段落都有）、`<w:pict>`、`<w:pStyle>` 等标签的前缀。探针：`<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:t>你好</w:t></w:r></w:p>` 返回 `EXTRACT_INVALID: Word 文档段落标签未闭合`，一个典型的带标题、对齐、制表符的 Word 剧本整篇都无法导入；只有最简单的 `<w:p><w:r><w:t>…` 才能通过，测试用例恰好都是这种。期望：删除这个嵌套检查（WordprocessingML 里文本框内的 `<w:p>` 本来就可能嵌套，不能当成错误），改成**单遍标签扫描**：用 `indexOf('<')` / `indexOf('>')` 逐个取标签，标签名用 `tag.split(/[\s/]/, 1)[0]` 之类不回溯的写法取出，遇 `w:p` 开始新段落、`</w:p>` 结束段落、`w:t` 读文本到 `</w:t>`、`w:br` 转换行、`w:tab` 转空格，`w:p` 自闭合是空段落。整个过程只前进不回头。<br>2. **标签匹配的正则仍会平方回溯**（`extract/index.js` 的 `parseParagraph` 里 `/^w:br(?:\s[^<>]*)?\s*\/$/` 与 `w:tab` 同款：`[^<>]*` 后面紧跟 `\s*`，二者都能匹配空白）。探针：`<w:br` 后面跟 2 万/4 万/8 万个空格再 `>`，耗时 564ms / 2274ms / 8596ms；`<w:tab` 同理 8 万个空格 10.6 秒。5MB 上限下一个标签里放 500 万个空格就是数小时。期望：按上一条改成不用回溯的写法（取标签名 + `tag.endsWith('/')`），不要在含 `[^<>]*` 的正则后面再跟能匹配同类字符的量词。补测试：1MB 空白的 `<w:br`、`<w:tab` 标签 200ms 内返回。<br>**测试要求（避免再次漏掉真实文档）**：把用**真实 Word / WPS / LibreOffice 保存的 docx** 作为夹具提交到 `server/test/engine/fixtures/`（每个不超过 50KB，内容里只放虚构文字）：至少 1 份含标题样式、粗体、居中、多段落、换行、制表符、页眉页脚的样例，1 份含文本框的样例；断言提取出的正文与预期完全一致。手写的最小 XML 只能作为补充。**这条对后续所有「解析外部格式」的代码同样适用**（ENG-02 的上游响应、ENG-01 的 LLM 输出）：必须有真实样本做夹具。 |
| 2026-10-17 | `agent/eng/M1-ENG-03-infra` @ `560b338`（M1-ENG-03 复审） | 🔁 需修改（仅剩 1 条必改，修完即可合并） | 上次 6 条里 5 条已修好，测试 129/129、check、build 通过。Lead 复测：① 七牛原生实现——用**真实 `fetch`** 对本地假服务走完整流程：表单上传请求被标准 multipart 解析器读出 `token` / `key` / `file` 三个字段；20MB 流切成 5 个 4MB 分片，全程 `UpToken` 认证，最后 `complete` 带全部 `etag`；第 2 片返回 500 时服务端收到 `DELETE`（abort）；`signedUrl` 的 `attname` 在 `token` 之前并参与签名；接口路径、凭证格式与官方文档一致。② 文本提取——200KB 级压缩炸弹、损坏 ZIP、非法与十六进制实体、GBK 兜底均已处理，`api/uploads.js` 把 `ExtractError` 映射为 400。③ `net`——重写后 15 种内网写法仍全部拦截，解析结果含非公网地址时整体拒绝，HTTP 300 报 `REMOTE_HTTP_ERROR`，IPv4 优先，总期限用 AbortController。<br>**必须修改**<br>1. `server/src/engine/extract/index.js:112-114` 正文解析的正则在遇到**未闭合标签**时耗时随输入长度**平方增长**，一个很小的 docx 就能让整个 API 进程长时间卡死：探针构造 `<w:p>` 重复 N 次且不闭合，N=1 万/2 万/4 万（解压后 49KB/98KB/195KB，docx 文件只有 0.2~0.4KB）耗时 121ms / 546ms / 2168ms，每翻一倍约 4 倍；`<w:t>` 未闭合同理（4 万次 4 秒）。解压上限 20MB 对应约 400 万个标签，估算会占用事件循环**数小时**，任何登录用户用一个 20KB 的文件即可打满（上传接口只限制了 2MB 文件大小）。期望：改成线性时间解析——先按 `</w:p>` 切分，再用 `/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g` 取文本（`[^<]*` 不会越过下一个标签，且合法的 `<w:t>` 内容里本来就不会有 `<`），也可以手写 `indexOf` 扫描；同时把 XML 解压上限降到 5MB（正文 5MB 已远超 2MB 的 txt 上限）。补测试：构造 20KB 以内的 docx（解压后接近上限、全是未闭合 `<w:p>` 或 `<w:t>`），断言在 1 秒内返回 `ExtractError`，正常多段落 docx 与含 `<w:br/>`、`<w:tab/>` 的段落仍能正确提取（`<w:br/>` 建议转换行、`<w:tab/>` 转空格，顺手补上）。<br>**建议（可顺手改）**<br>2. `server/src/engine/storage/qiniu.js:83` 表单上传把 `contentType` 直接拼进请求头，调用方传入带换行的值会造成头注入；请在 `put` 入口统一过滤 `\r`、`\n`，不合法则回退 `application/octet-stream`。<br>3. 下载链接里 `encodeKey(key)` 的百分号编码与七牛按「原始请求路径」验签是否一致，文档没有写清楚，只能真实桶验证：M2 联调清单里请专门加一项「含中文、空格的 key 能否下载」。 |
| 2026-10-17 | `agent/eng/M1-ENG-03-infra` @ `376b52d`（M1-ENG-03） | 🔁 需修改（修完 1、2 即可合并） | 做得好的：`net` 的内网防护很扎实——Lead 用 14 种写法实测（`0x7f.0.0.1`、`2130706433`、`127.1`、`[::ffff:7f00:1]`、`user:pw@`、`169.254.169.254`、`.internal`、DNS 重绑定、重定向到内网、重绑定重定向、`ftp:`、`file:`）全部拦截，IPv4/IPv6 保留段判定正确；`createMemoryStorage` 迁移与 `app.js` / `worker.js` / `cron.js` 接线正确且单独成提交；文件头来源标注齐全；零新增依赖。测试 121/121、check、build 通过，与最新 `main` 无冲突。Lead 复现 2 个必改问题：<br>**必须修改**<br>1. `server/src/engine/storage/qiniu.js` **保留七牛原生协议**（用户 2026-10-17 决定，**不要改成 S3**；我上一版意见里「改回 S3」已撤回），但实现与七牛官方文档不符，Lead 逐页核对了官方文档：① **上传**：官方文档里上传用「上传凭证」（`AccessKey:EncodedSign:EncodedPutPolicy`，PutPolicy 至少含 `scope` 与 `deadline`），向上传域名 `POST` `multipart/form-data`（字段 `token`、`key`、`file`）；文档中**没有** `PUT /put/…` 这个接口，也没有用管理凭证（`QBox`）上传。当前实现把整个文件内容拼进管理凭证签名串，在真实桶上大概率 401。② **下载文件名**：`signedUrl` 把 `&attachment=…` 追加在 `token` **之后**，官方文档明确「token 必须放在最后，之后的参数被忽略」，所以 `download` 完全不生效；七牛的文件名参数是 `attname`，且必须放在 `token` 之前并参与签名（真实桶是否按预期返回 `Content-Disposition` 在 M2 联调时验证，单测只验签名顺序）。③ **删除**：`POST /delete/<EncodedEntryURI>`、612 视为已删除，这部分是对的；管理凭证推荐用新版 `Authorization: Qiniu <token>`（签名串含 method、path、query、host、content-type），旧版 `QBox` 仍可用，二选一并在注释里写明依据。④ **内存**：`put` 现在把整个对象读进内存（并转成字符串），`transfer.js` 注释却写「全流式」。期望：≤ 8MB 的对象（照片、形象图、音色）用「表单上传」；更大的对象（片段视频、成片）用「分片上传 v2」（官方文档 `kodo/6364`，`initiateMultipartUpload` → `uploadPart` → `completeMultipartUpload`，失败时 `abortMultipartUpload`），按固定分片大小（如 4MB）读 stream，内存只占一个分片；对象大小上限由调用方的 `maxBytes` 保证。⑤ `signedUrl` 保持**同步**（BE 序列化代码里 `urlFor(key)` 是同步调用；原生协议的 HMAC 签名天然同步，这是选原生协议的好处）。⑥ 测试：固定时间下的上传凭证、下载 URL（`e`、`attname`、`token` 的顺序与签名）、管理凭证的**已知答案向量**（可用官方文档示例或自行计算并注明算法）；分片上传的请求顺序、失败时调用 `abort`；假 HTTP 实现，不访问外网。真实桶联调仍属 M2，需要你授权。<br>2. `server/src/engine/extract/index.js` 文本提取有 3 个健壮性问题（均已复现）：① **压缩炸弹**：一个 199KB 的 docx 被解压成 200MB 文本返回，内存涨 369MB，同步解压把整个 API 进程卡住 8.5 秒（上传上限 2MB，可构造更大的压缩比）。期望：先看中央目录里声明的解压后大小，超过上限（建议 20MB，常量写注释）直接拒绝，同时给 `inflateRaw` 设 `maxOutputLength`，改用异步版本不阻塞事件循环；② **损坏文件抛 `RangeError`**：中央目录偏移被改坏时抛 `ERR_OUT_OF_RANGE`，`&#99999999;` 这类超范围字符实体抛 `Invalid code point`，调用方只会得到 500。期望：所有读取做边界检查，任何异常统一转成 `ExtractError`，字符实体非法时忽略该实体；③ `&#x4e2d;` 这类十六进制实体没有解码，原样留在正文里。期望：补上。**同时（跨所有权，已批准）在 `server/src/api/uploads.js` 把 `ExtractError` 映射为 400 `UPLOAD_TYPE_INVALID`（`message` 用错误里的中文提示），补一个接口级测试：损坏的 docx 返回 400 而不是 500。**补测试：压缩炸弹被拒、截断/损坏 ZIP、非法实体、十六进制实体。<br>**建议修改**<br>3. `server/src/engine/net/index.js:152-168` 状态码 300、304、305 被当成成功返回响应体，探针复现（`status 300` 成功）。期望：只接受 2xx，其余非重定向状态一律 `REMOTE_HTTP_ERROR`。<br>4. `server/src/engine/net/index.js:145-150`、`:92-95` 解析到多个公网地址时只用第一个（`pinned[0]`），双栈主机在没有 IPv6 出口的服务器上会因首个 IPv6 地址不通而失败。期望：IPv4 优先排序，连接失败时依次尝试下一个已验证地址。<br>5. `server/src/engine/net/index.js:99`、`:108` 的超时是「空闲超时 + 响应头之后的总超时」，响应头阶段被慢速逐字节发送时不会超时。期望：从 `safeFetch` 入口起设置包含重定向在内的总截止时间。<br>6. 可选：txt 文件常见 GBK 编码，目前按 UTF-8 解码会乱码。建议检测到非法 UTF-8 时用 `TextDecoder('gbk')` 兜底（BE-04 的 `/uploads/story` txt 路径也应改用 `extractText`，避免两套逻辑，一并改）。 |
| 2026-10-17 | `agent/be/M1-BE-04-assets` @ `f33bc6c`（M1-BE-04 复审） | ✅ 通过并合并 | 5 条全部修复，测试 100/100（合并后 `main` 同样 100/100；注意新增了依赖 `busboy`，拉取后先 `npm ci`）、check、build 通过。Lead 探针复测：他人数字人不能复用已被引用的上传；替换照片后清理正常、旧照片被回收；4 个数字人并发抢同一张照片只成功 1 个；同键并发 5 次只产生 1 个版本、只预占一次；`submitting` 崩溃后不再调用 provider、置 `unknown` 并保持冻结；provider 收到照片 key、描述、风格提示词，任务记录里的 provider 为真实注入实现。<br>**留给后续的一条（不阻塞）**：`createLookGenerateHandler` 把 provider 抛出的**任何**异常都当成「未提交」并重试，但网络超时等异常可能发生在上游已受理之后。M1-ENG-02 的 provider 必须自己分类：明确未提交（连接被拒、请求被 4xx 拒绝）才抛可重试错误并标记 `err.submitted = false`；结果不确定一律**返回** `{ status: 'unknown' }`，不要抛。BE-05 处理器按同一规则：只有 `err.submitted === false` 才回退重试，其余按 unknown 处理。<br>**M1-ENG-01 / 02 / 03 开工要点**（引擎迁移，在有超搭云源码的设备上做；接口以 `docs/ARCHITECTURE.md` §5、§6 和 `server/src/engine/README.md` 为准，要改接口先在 §5 提变更申请）：<br>a. **通用规则**：只改 `server/src/engine/**` 与 `server/test/engine/**`；每个复制的文件头写 `// Source: chaodayun@2926b42 <原路径>`；去掉对超搭云仓库、计费、会话的依赖，改成注入；**不读 `process.env`**，需要新环境变量时在 `server/src/config.js` 增加并写入 `.env.example`（这类最小改动已获 Lead 批准）；仓库公开，推送前自查不含密钥、内部域名、账号、真实用户数据；不得修改超搭云仓库，不得产生真实模型费用，测试全部用模拟上游。<br>b. **顺序与分支**：先 `M1-ENG-03`（分支 `agent/eng/M1-ENG-03-infra`）→ `M1-ENG-02`（`agent/eng/M1-ENG-02-providers`）→ `M1-ENG-01`（`agent/eng/M1-ENG-01-story`），每个单独推送、单独审查，通过后再做下一个。<br>c. **ENG-03（net / storage / transfer / extract）**：<br>• `net.safeFetch(url, { maxBytes, timeoutMs })`：只允许 http/https；解析 DNS 后检查并**固定**解析出的 IP（防 DNS 重绑定），拒绝私网、回环、链路本地、云元数据地址（含 IPv6 与 IPv4 映射）；每次重定向重新校验，最多 3 次；流式读取超过 `maxBytes` 立即中断；超时中断。解析器与 HTTP 实现可注入，测试不访问外网。<br>• `storage`：`put(key, stream|buffer, { contentType })`、`signedUrl(key, { ttlSeconds, download? })`、`remove(keys)`；七牛 Kodo 实现（私有空间 + 签名链接，`download` 时带 `attachment` 文件名）与内存实现（接口一致）。**把 `createMemoryStorage` 从 `queue/cron.js` 迁到 `engine/storage/`，并同步改 `app.js`、`worker.js`、`queue/cron.js` 的引用**（跨所有权，已获 Lead 批准，这一处改动单独成一个提交）；Worker 与 API 主入口按 `config.storage.driver` 注入真实存储，开发缺省内存。<br>• `transfer.transferFromUrl(url, key, { maxBytes, timeoutMs })`：经 `net` 下载并流式 `storage.put`。<br>• `extract.extractText(buffer, mime)`：txt（UTF-8 去 BOM）与 docx（解 ZIP 读 `word/document.xml`，不要引入重型依赖；需要新依赖时版本写死）；签名与 `app.js` 里的 `extractText` 注入点一致，并在主入口注入。<br>d. **ENG-02（providers）**：适配器注册表按 ARCHITECTURE §5；视频适配器（wan3.0、seedance2.5）支持图片参考、音频参考、首帧；图片适配器；再提供一层 `createImageProvider(registry, …)`，实现 BE-04 已在用的接口 `generate({ characterId, styleId, promptHint, description, referenceKeys }) → { status: 'succeeded', buffer, contentType } | { status: 'failed', error } | { status: 'unknown' }`，BE-04 代码不用改。错误分类见上一条。**模拟上游做成 HTTP 级别的假服务**（测试里起一个本地服务器），覆盖：成功、业务失败、超时、连接被拒、受理后断开（应返回 unknown）。<br>e. **ENG-01（story）**：`createStoryAgent({ llm })` → `{ understand, bindPrompts }`，依赖 `@earendil-works/pi-agent-core`（版本与超搭云一致，写死精确版本）；LLM 通过注入、测试用模拟 LLM；验收见 TASKS：每段时长只取 `allowedDurations`、总时长 ≤ `maxSeconds`、超长压缩并给出 `notice`、单片段不输出音频参考、同一作品不同角色音色不重复、已有数字人匹配、LLM 输出不合法时有限次修复重试并有确定性兜底；记录 token 用量（LLM 费用平台承担，只做内部核算）。<br>f. 完成每个任务后在 §7 追加变更记录并把 §2 状态改「待审查」；全部 ENG 完成后我补充 M1-BE-05 的开工要点。 |
| 2026-10-17 | `agent/be/M1-BE-04-assets` @ `60b7d71`（M1-BE-04） | 🔁 需修改（修完 1~3 即可合并） | 整体质量好：上传按文件头识别、超限中断、未引用上限；数字人全部带 `user_id` 隔离；扣费与排队在同一事务；`look.generate` 用状态守卫保证结算/退回幂等；busboy 版本写死。测试 96/96、check、build 通过，与最新 `main` 无冲突。Lead 探针复现 3 个问题：<br>**必须修改**<br>1. `server/src/characters/service.js:30-43`、`:185-207` 一张上传可以被两个数字人同时引用，且替换照片时无条件解除引用。探针：B 数字人成功引用了 A 正在用的上传；A 替换照片后该上传 `referenced_at` 被清空，但 B 仍在使用；随后 `uploads.sweep` 报外键错误 `23503`（`character_photos` 还引用着它）。后果：定时清理任务永久失败，所有用户的过期上传都清不掉，且每次重试都在刷错误。期望：① `referenceUploads` 只接受「未被引用」或「已属于本数字人」的上传，已被其他数字人使用的返回 400；② 解除旧照片引用前，确认没有任何 `character_photos` 行还在用它；③ `queue/cron.js` 的 `runUploadsSweep` 删除条件加 `AND NOT EXISTS (SELECT 1 FROM character_photos WHERE upload_id = uploads.id)`，遇到异常数据时跳过而不是整批失败。补测试：他人数字人的上传不能被复用；替换照片后清理不报错且共用的照片不被清；清理遇到仍被引用的行时跳过。<br>2. `server/src/characters/service.js:214-262` 同一个 `idempotencyKey` 并发提交（手机上双击很常见）：探针两个并发请求，一个成功，另一个返回 409 `QUOTE_EXPIRED`，用户看到「报价已过期」，实际已经在生成。API.md 约定重放返回同一个版本。期望：事务开头先对「用户 id + 请求键」加事务级咨询锁（如 `pg_advisory_xact_lock(hashtext(replayKey))`），再查重放；补测试：同键并发 2 次，只产生 1 个版本、两个请求都返回同一版本、只预占一次。<br>3. `server/src/characters/service.js:312-323`、`:338-345` 生成任务卡死与重复提交风险：① 进程在提交上游后崩溃，任务停在 `submitting`，队列重新领取时命中「正在处理」守卫后**正常返回**，job 被标记完成，版本永远 `pending`、金额永远冻结，没有任何东西再去处理它（探针复现）；② `submitting` 超过 10 分钟就允许**重新提交**，违反 AGENTS.md §5「上游提交结果未知时保持冻结、不自动重提」（进程可能是在上游已接受请求之后才崩的，会重复生成、重复计费）。期望：只有 `created` 状态才允许提交；遇到 `submitting` 时：刚更新（可能仍在执行）→ 抛出可重试错误让队列退避后再看；停滞超过阈值 → 置为 `unknown`、保持冻结、记错误日志、结束（等 M2 对账工具处理），**不调用 provider**。调用 provider 前后用 `ctx.extendLease()` 续租，避免长耗时被误判成崩溃。补测试：模拟崩溃后重领取，provider 不被第二次调用，状态为 `unknown`。<br>**建议修改（BE-05 前补上）**<br>4. `server/src/characters/service.js:327-331` 调用图片模型时 `referenceKeys` 恒为空，也没有传外貌描述和风格提示词，照片到数字人这条主流程没有接上。期望：传入该数字人的照片存储 key、`description`、风格的 `prompt_hint`（接口按 `server/src/engine/README.md`，ENG-02 接入时直接可用）；`gen_tasks.provider` 不要写死 `'mock-image'`，取 `imageProvider.id`。<br>5. `server/src/characters/service.js:40` `character_photos` 的主键用了 `newId('chr')`，`chr_` 前缀是留给数字人的；请在 `db/ids.js` 增加 `cph` 前缀。上传数量上限检查与插入不是原子的（并发上传可略超 50），属可接受的软限制，注释写明即可。<br>**下一步顺序（Lead 决定）**：BE-05 依赖 `M1-ENG-01`、`M1-ENG-02`（见 TASKS 依赖列），这两个还没人做；本分支修完合并后，请先做 **M1-ENG-01 / 02 / 03（引擎迁移，在你那台有超搭云源码的设备上）**，再做 M1-RND-01，最后才是 M1-BE-05。BE-05 的开工要点我在引擎完成后补充。 |
| 2026-10-17 | `agent/be/M1-BE-03-cron` @ `02242fe`（M1-BE-03 复审） | ✅ 通过并合并 | 3 条全部修复，测试 83/83、check、build 通过。Lead 探针复测：上传行被他人事务锁住（模拟正在被引用）时清理既不删对象也不删行；无成片记录的到期作品、多个成片版本的到期作品，7 个视频对象全部删除、封面与海报保留；存储故障时 key 保留、下次调度重试成功；生产环境缺省存储启动报错。<br>**M1-BE-04 开工要点**（对照 API.md §4、§5，PRD §4.1）：<br>a. **上传** `POST /uploads/image`：multipart 需要新增依赖（建议 `busboy`，版本号写死，不要用范围）；校验文件头（jpg/png/webp，不信扩展名和 Content-Type）、≤10MB、流式读取超限立即中断；存储 key 形如 `users/<userId>/uploads/<uploadId>`；每个用户未引用上传设上限（如 50 个，超出 `RATE_LIMITED`），防止刷存储。`POST /uploads/story`：txt 先按 UTF-8 解码（去 BOM），docx 的文本提取属于 M1-ENG-03，BE-04 通过注入的 `extractText` 调用，未注入时 docx 返回 `UPLOAD_TYPE_INVALID`，不要自己实现。<br>b. **引用上传**（BE-03 审查约定）：创建数字人、替换照片时，在同一事务里 `UPDATE uploads SET referenced_at = now() WHERE id = ANY($1) AND user_id = $2 RETURNING id`，返回行数不等于传入数量就 400，同时写 `character_photos`；替换掉的旧照片：对应上传的引用清除并由 `uploads.sweep` 回收，不要立即删对象。<br>c. **数字人** `/characters/**`：所有查询带 `user_id`，他人资源一律 404；无照片时 `description` 必填；`defaultVoiceId` 必须是上架音色；软删除（`deleted_at`）不影响历史作品，不删形象与版本；`GET /characters` 的 `avatarUrl`、`styleIds`（只算选中版本已成功的）、`worksCount`（未删除作品里引用该数字人的作品数）按 API.md §5 返回，媒体地址一律通过注入的 `urlFor`，缺素材时省略字段。<br>d. **生成形象** `POST /characters/:id/looks/:styleId/versions`：在**同一个事务**里完成「`consumeQuote`（kind=`look_regenerate`、refType=`character`、refId=数字人 id）→ `reserve`（金额大于 0 才调用）→ 新增 `look_versions`（pending）+ `gen_tasks` → `enqueue` `look.generate`」，响应 202 返回 `LookVersion`。同一个 `idempotencyKey` 重放返回同一个版本、不重复扣费（键由用户 id + 请求键派生，避免跨用户冲突）。API.md §3 的计费约定：生成前预占、成功结算、失败退回；幂等键用 `look:<versionId>:reserve|settle|refund`。<br>e. **`look.generate` 处理器**：先读状态再调用上游，**事务内不等待上游**；图片模型通过注入的 provider 调用（接口按 `server/src/engine/README.md`，ENG-02 完成前测试用模拟实现，放在 `server/test/helpers/`，生产环境未注入时启动报错，同 BE-03 做法）；提交结果未知时版本保持 pending、金额保持冻结、**不自动重提**；成功后转存到存储（key `users/<userId>/looks/<versionId>`）、版本置 succeeded、**自动选中新版本**（旧版本保留）、结算；失败置 failed、退回。处理器必须幂等（重复执行、租约被抢都不能重复结算或重复退回）。<br>f. `PUT .../looks/:styleId/selection` 只能选本数字人、本风格、状态 succeeded 的版本；`PUT /characters/:id/photos` 为整体替换（1~5 张，无照片的数字人必须保留描述）。<br>g. **必测**：他人资源 404；上传文件头伪装被拒；超大文件被拒；引用他人或已清理的上传 400；并发创建/替换引用同一上传只成功一次；生成形象并发重放只扣一次；余额不足 402 且不留版本；上游失败全额退回、成功结算且对账（可用 + 冻结）正确；`look.generate` 重复执行不重复结算；删除数字人后历史作品查询不受影响。 |
| 2026-10-17 | `agent/be/M1-BE-03-cron` @ `3259d15`（M1-BE-03） | 🔁 需修改（修完 1、2 即可合并） | 调度设计正确：按时间窗口生成去重键，多 Worker 只入队一次；分批短事务可重复执行；`jobs.cleanup` 只删 30 天前的 done 行。测试 80/80、check、build 通过。Lead 探针复现 2 个问题：<br>**必须修改**<br>1. `server/src/queue/cron.js:122-140` `uploads.sweep` 先删存储对象、后删记录，中间没有任何保护。探针：在 `storage.remove` 执行期间模拟 BE-04 创建数字人并引用这张照片，结果照片对象已被删除，数字人仍引用它；随后 `DELETE uploads` 撞外键报错，任务失败。后果：用户的数字人照片永久丢失。期望：先在短事务里「认领删除」——`DELETE FROM uploads WHERE id IN (… LIMIT n) AND referenced_at IS NULL AND created_at < … RETURNING storage_key`（与引用操作靠行锁互斥），提交后再删对象；删对象失败只记日志（留下孤儿对象可接受，比误删用户照片好）。补测试：清理过程中被引用的上传不会被删除。<br>2. `server/src/queue/cron.js:146-203` `projects.expire_sweep` 收集视频 key 的查询以 `renders` 为起点（`:169` `FROM renders r LEFT JOIN segments …`），补偿循环也是 `JOIN renders`（`:189`）。探针：到期作品没有 `renders` 行时，片段视频对象没被删除（`removed=[]`），但 `clearVideoKeys` 照样把 `video_key` 清空，对象永久成为孤儿、再也找不到。另外 renders × takes 是笛卡尔积，成片版本多时会重复。期望：成片 key 和片段 key 分两条查询，都以 `project_id = ANY($1)` 为条件；只清空本次确实已删除对象的 key。补测试：没有 render 的到期作品、多个 render 版本。<br>**建议修改**<br>3. `server/src/worker.js:23` 生产环境缺省用内存存储：清理任务会「删除」内存里的对象并清空 key，而真实七牛对象永远留着。建议 `config.production` 且未注入 `storage` 时启动报错（engine/storage 完成后由 Worker 主入口注入）。<br>**给 BE-04 / BE-05 的约定（已记录，不需本分支处理）**<br>• BE-04 引用上传时：在同一事务里 `UPDATE uploads SET referenced_at = now() WHERE id = ANY($1) AND user_id = $2 RETURNING id`，返回行数不等于传入数量就 400（上传不存在、已被清理或不属于本人）。<br>• BE-05 的 `project.compose`、`gen.poll` 等写视频 key 的处理器，写入前在事务里确认作品不是 `expired`；已过期就删除刚转存的对象并结束，避免过期作品又出现视频。<br>• `createMemoryStorage` 暂放在 `queue/cron.js`，engine/storage 完成后移到 `server/src/engine/storage/` 并删除这里的实现。 |
| 2026-10-17 | `agent/be/M1-BE-02-wallet` @ `25ab347`（M1-BE-02 复审） | ✅ 通过并合并 | 7 条全部修复，测试 74/74、check、build 通过。Lead 探针复测：同一事务 5 条流水按 limit=1/2/3 翻页均完整无重复；负数、小数金额拒绝；`settle` 同键不同额 409、同额重放成功；跨用户复用幂等键 409；估算下限 = 30 秒视频费，形象费按缺形象数计入上下限；A 数字人的报价确认 B 时 `QUOTE_MISMATCH`；余额与冻结对账正确。<br>**给后续任务的约定**：<br>• 钱包操作金额必须为正整数，金额为 0 时（如没有需要生成的形象）调用方**跳过**扣费，不要调用 `charge/reserve`。<br>• 调用 `consumeQuote` 必须传 `{ kind, refType, refId }`：`look_regenerate` → `character`/数字人 id；`cast_looks`、`project_render` → `project`/作品 id；`segment_take` → `segment`/片段 id。<br>• 优化项（不急）：`listLedger` 的游标条件对 `created_at` 做了表达式运算，用不上 `(user_id, created_at, id)` 索引，数据量大时可改成 `(created_at, id) < (to_timestamp($3 / 1e6), $4)`。<br>**M1-BE-03 开工要点**（定时任务）：<br>a. 调度：Worker 启动时和每隔一段时间，用 `enqueue` 加去重键 `cron:<任务名>:<时间窗口起点>` 入队，多个 Worker 同时运行也只入队一次；调度间隔放 `config.js`。<br>b. 清理任务都要**分批**（如每批 500 行、每批一个短事务），可以重复执行；单批失败抛错，交给队列重试。<br>c. `auth.sweep`：删除过期的 `rate_counters` 窗口（按最长窗口 1 天再加缓冲）、已作废或过期超过 1 天的 `sms_codes`、过期的 `sessions`。<br>d. `uploads.sweep`：24 小时未被引用的上传先删存储对象、再删记录。存储接口在 engine 完成前用注入的模拟实现，接口按 `server/src/engine/README.md` 的 `storage.remove(keys)`。<br>e. `projects.expire_sweep`：`delivered` 且 `expires_at <= now()` 的作品：在短事务里改为 `expired`、写 `project_events`，再在事务外删除成片和片段视频对象，并清空对应 `*_key`；封面和作品记录保留。没有作品数据时用测试插入的行验证。<br>f. **注意**：清理已完成的 `jobs` 时，只删除超过 30 天的 `done` 行；删掉后同样的去重键可以再次入队，所以业务处理器本身必须按业务状态幂等，不能只靠去重键。<br>g. 必测：两个 Worker 同时调度只入队一次；清理可重复执行；分批边界；到期作品状态和视频对象都被处理、封面保留。 |
| 2026-10-17 | `agent/be/M1-BE-02-wallet` @ `5b0fd18`（M1-BE-02） | 🔁 需修改（修完 1~6 即可合并） | 遗留第 5 条（冷却拦截不计每日次数）已修好并有回归测试 ✅。钱包主体设计正确：条件 UPDATE 防超扣、报价原子占用 + 重算、兑换码条件更新、计价函数注册表、按锁定档位映射取价。测试 67/67、check、build 通过。Lead 探针复现以下问题：<br>**必须修改**<br>1. `server/src/wallet/service.js:154-173` 流水翻页漏数据：游标用 `toISOString()`（毫秒），库里 `created_at` 是微秒；同一事务内多条流水 `created_at` 完全相同（`now()` 是事务开始时间）。探针：一个事务里扣费 3 次，`limit=1` 翻页只拿到 1 条。期望：游标带完整精度（如 `(extract(epoch from created_at) * 1e6)::bigint` 或 `created_at::text`），补测试「同一事务多条流水跨页不丢不重」。<br>2. `server/src/wallet/service.js:43/62/81/100` `reserve` / `settle` / `refund` / `charge` 不校验金额。探针：`charge(amountFen: -500)` 后余额从 997 变成 1497。期望：入口统一断言 `Number.isSafeInteger(amountFen) && amountFen >= 0`（0 是否允许按调用方需要定，建议允许 0 且不写流水或写 0 流水，二选一并注释），否则抛 `INTERNAL`；补测试。<br>3. `server/src/wallet/service.js:26-40` 幂等键不分用户：查首次流水时没带 `user_id`。探针：用户 B 用 A 用过的键扣费，返回 `replayed: true`（看起来扣成功了），实际 B 的余额没变。后果：调用方以为已扣费并开始生成，等于免费；客户端传入的键（兑换码）也能被别人占用。期望：命中的流水 `user_id` 不同时抛 409 `IDEMPOTENCY_CONFLICT`（或库里存 `userId:key` 做命名空间），补测试。<br>4. `server/src/wallet/service.js:62` `settle` 的重放比对只看 `amount_fen`（永远是 0）。探针：同键先结算 100、再结算 200，第二次被当作重放放过。期望：首次流水查询带出 `frozen_delta_fen`，`settle` / `refund` / `reserve` 都比对它；补测试。<br>5. `server/src/wallet/pricing.js:174` `consumeQuote` 只收 `quoteId`，不校验报价属于哪个作品 / 片段 / 数字人，靠调用方自己核对，后续 BE-04/05 容易漏，变成「拿 A 作品的便宜报价确认 B 作品」。期望：参数增加 `{ kind, refType, refId }`，不一致抛 409 `QUOTE_MISMATCH`；`priceSegmentTake`（`pricing.js:128`）同时校验 `segmentId` 属于传入的 `projectId`。补测试。<br>6. `server/src/wallet/pricing.js:217-235` 首页价格区间与 PRD §6.3【默认】不一致。探针：标准档 `minFen=100`（按最短 5 秒）。PRD：下限按 1 个 30 秒片段、上限按最长时长；形象费按「本风格缺形象的已勾选数字人数」计入**上下限**（不是全部勾选数，也不是只算上限）。「缺形象」= 该数字人在 `character_looks` 里没有这个风格、或 `selected_version_id` 指向的版本不是 `succeeded`。期望：按此修改，30 秒取 `min(30, SKU 最长时长)`，补测试。<br>**建议修改**<br>7. `server/src/wallet/service.js:119` 兑换码没有失败次数限制，短码可被暴力猜。建议按用户限制失败次数（如每小时 10 次）。注意：失败会抛错导致事务回滚，计数要在事务外提交（参考 BE-01 的做法）。<br>**给 BE-05 的约定（不需本分支处理，已记录）**：`priceCastLooks` 把「缺形象」定义为 `project_cast.look_version_id IS NULL`，所以故事理解 job 必须为已有本风格形象的角色写好 `look_version_id`。 |
| 2026-10-17 | `agent/be/M1-BE-01-auth` @ `e315aac`（M1-BE-01 复审） | ✅ 通过并合并（`6a741a7`） | 4 条意见全部处理，新增 4 个回归测试；测试 52/52、check、build 通过。Lead 并发探针复测：10 次并发发码只成功 1 次、只发 1 条、只剩 1 条有效码；15 个并发错误码只比对 5 次且验证码作废。<br>**遗留 1 条，在 M1-BE-02 分支的第一个提交里修复**：<br>5. `server/src/auth/sms.js` `sendSmsCode` 先调用 `hitRateLimit`（每日计数 +1）、后在锁内检查冷却，导致被冷却拦下的请求也计入每日上限。探针：并发 10 次发码只发出 1 条，但 `sms:daily:<手机号>` 计数到 10，该手机号当天再也收不到验证码；别人用 10 个请求就能锁住任意手机号一天的登录。期望：冷却检查通过后再计每日次数（在同一事务锁内用 `t` 计数，或冷却拦截时不计数），补回归测试「冷却期内并发 10 次后，冷却过后仍能再发」。<br>**M1-BE-02 开工要点**（对照 API.md §3、ARCHITECTURE §3/§4）：<br>a. 钱包服务要能被别的模块在**它们自己的事务里**调用：`reserve / settle / refund / charge(t, …)` 接收事务作用域，余额用一条带条件的 `UPDATE … WHERE available_fen >= $amount` 扣减，影响 0 行即 `INSUFFICIENT_BALANCE`；每笔流水带 `idempotency_key`，重放返回首次结果。<br>b. 报价：四种 kind 用「每种一个计价函数」的注册方式实现。本任务先做 `look_regenerate`（数字人表已存在）和 `/quotes/estimate`；`cast_looks` / `project_render` / `segment_take` 的计价函数也写好，测试里直接插入作品、片段行即可，不用等 BE-05。`project_render` / `segment_take` 按作品锁定的 `tier_mapping_id` 取价，**不是**当前映射；形象单价取 `settings.look_image_sku_code` 的当前生效 SKU。<br>c. 报价单存 `params_hash` 与 `price_snapshot`；使用时在事务里 `UPDATE quotes SET consumed_at = now() WHERE id = $1 AND consumed_at IS NULL AND expires_at > now()` 原子占用，再按当前参数和价格重算，不一致时 409 `QUOTE_MISMATCH`，过期时 409 `QUOTE_EXPIRED`。<br>d. 兑换码只存哈希，`used_by IS NULL` 条件更新防并发重复兑换；流水 `title` 用中文。<br>e. 必测：并发预占不超扣、幂等重放、同键不同参数 409、调价后旧报价 `QUOTE_MISMATCH`、过期报价、并发兑换同一码只成功一次。 |
| 2026-10-17 | `agent/be/M1-BE-01-auth` @ `25564b9`（M1-BE-01） | 🔁 需修改（修完 1、2 即可合并） | 整体质量好：结构清晰、只改了自己的路径、无需迁移、Cookie/CSRF/会话设计正确，测试 48/48 通过、check/build 通过，测试覆盖全面。Lead 用并发探针复现了 2 个问题：<br>**必须修改**<br>1. `server/src/auth/sms.js:42-58` 发码冷却有竞态：`checkCooldown` 的查询和后面的作废/插入不在同一把锁里。探针直接并发调用 10 次 `sendSmsCode`（同一手机号），3 次运行均为 6 次成功、实际发出 6 条短信、库里同时有 6 条未作废验证码。后果：并发请求可绕过 60 秒冷却刷短信费用（只剩每日上限兜底），且「只认最新一条」不成立。期望：同一手机号的「冷却检查 → 作废旧码 → 插入新码」放进一个短事务并加按手机号的锁（如 `pg_advisory_xact_lock(hashtext('sms:' \|\| phone))`），短信发送仍在事务外；补并发回归测试（并发 10 次只成功 1 次、只发 1 条）。<br>2. `server/src/auth/sms.js:72-95` 错误次数上限有竞态：先读 `attempts` 再比对哈希，最后才自增，并发提交时多个请求读到同一个旧值。探针并发提交 15 个错误码，最终 `attempts=10`，即 10 次猜测被实际比对，超过「错 5 次作废」。期望：先原子地占用一次尝试再比对，例如 `UPDATE sms_codes SET attempts = attempts + 1 WHERE id = $1 AND consumed_at IS NULL AND attempts < $max RETURNING attempts`，没返回行就直接 `SMS_CODE_INVALID`；补并发回归测试（并发 15 个错误码后被比对的次数 ≤ 5）。<br>**建议修改（可同分支顺手改）**<br>3. `server/src/auth/sms.js:19` 控制台文案写死「10 分钟内有效」，实际默认 `codeTtlSeconds=300`（5 分钟），改为按配置输出。<br>4. `server/src/auth/routes.js:48` `logout` 挂了 `requireAuth`，会话已过期时返回 401 且不清 Cookie。建议无会话时也清 Cookie 并返回 `{ ok: true }`（API.md §1 未要求登录态）。<br>**不需本分支处理（Lead 已登记到 TASKS）**：`rate_counters` / 过期 `sms_codes` / 过期 `sessions` 的清理并入 M1-BE-03；面向用户的「每天」限额（免费故事理解）按北京时间切日，见 M1-BE-05。短信每日上限按 UTC 切日可接受。 |

## 7. 变更记录（最新在上）

### 2026-10-17 · Engine · M1-ENG-03 第三轮修复（真实 DOCX 与线性标签扫描）

- **背景**：在原分支合并 `origin/main`（0490b92）后处理 §6 第三轮两条必改：真实 Word 段落的 `<w:pPr>` / `<w:pict>` 被当作嵌套段落误拒绝，`<w:br>` / `<w:tab>` 后空白属性仍触发平方回溯。
- **改动**：`engine/extract/index.js` 改为单遍 `indexOf('<')` / `indexOf('>')` 标签扫描，标签名按字符单向读取；仅对准确的 `w:p` 标签建立段落栈，忽略 `w:pPr`、`w:pict` 等属性标签。`w:t` 仅取下一个 `<` 之前的文本，`w:br` 与 `w:tab` 分别转为换行与空格，不再使用可重叠量词正则。文本框里嵌套段落可提取；LibreOffice 导出的 `mc:Choice` / `mc:Fallback` 两份兼容表示只提取一次。
- **真实夹具**：提交两份由 LibreOffice 26.8 保存的 `.docx`（均小于 50KB、只含虚构文字）：`server/test/engine/fixtures/miv-word-styles-fixture.docx` 包含标题、粗体、居中、多段落、换行、制表符及实际页眉页脚部件；`miv-textbox-fixture.docx` 含 `w:txbxContent` 文本框。测试对两份正文做精确相等断言，页眉页脚不并入正文，文本框兼容表示不重复。
- **验证**：1MB 空白属性的 `<w:br/>` 和 `<w:tab/>` 分别在 200ms 内返回正确文本（本机聚焦测试合计约 10ms）；未闭合段落和文本标签继续返回 `ExtractError`。`npm run test:server` 134/134，连续四轮通过；`npm run check` 与 `npm run build` 通过。
- **未完成 / 风险**：真实 Word/WPS 的更多方言仍需后续夹具扩展；七牛真实桶的中文、空格 key 下载行为留在 M2 授权联调。复审通过前不开始 M1-ENG-02。

### 2026-10-17 · Engine · M1-ENG-03 复审修复（线性正文解析）

- **背景**：在 `agent/eng/M1-ENG-03-infra` 合并 `origin/main`（462cc19）后，处理 §6 复审唯一必改：未闭合 `<w:p>` / `<w:t>` 使正则平方增长、阻塞 API 事件循环；顺手处理建议项 2（七牛上传 MIME 头注入）。
- **改动**：`engine/extract/index.js` 将解压 XML 上限由 20MB 降为 5MB，正文改为 `indexOf` 单向扫描段落与文本标签，未闭合标签抛 `ExtractError`，并将 `<w:br/>` 转换行、`<w:tab/>` 转空格。`engine/storage/qiniu.js` 在 `put` 入口过滤 `contentType` 中的 CR/LF，不合法时统一回退 `application/octet-stream`，覆盖表单与分片路径。
- **验证**：构造压缩后小于 20KB、解压后由 70 万个未闭合 `<w:p>` 或 `<w:t>` 组成的 docx，均在 1 秒内返回 `ExtractError`（本机聚焦测试约 39ms）；正常多段落和 `w:br`/`w:tab` 提取通过。表单及分片上传 MIME 换行注入回归通过。`npm run test:server` 132/132，连续四轮通过；`npm run check` 和 `npm run build` 通过。
- **未验证**：七牛真实桶的中文/空格 key 下载与 `Content-Disposition` 行为列入 M2 授权联调，当前没有访问真实七牛服务或产生模型费用；复审通过前不启动 M1-ENG-02。

### 2026-10-17 · Engine · M1-ENG-03 审查修复（§6 第 1、2 条及建议项）

- **背景**：在 `agent/eng/M1-ENG-03-infra` 合并 `origin/main`（b5e0823）后，按 §6 审查意见修复；用户决定继续使用七牛原生协议，不改回 S3。
- **改动**：`engine/storage/qiniu.js` 改为上传凭证 + 小对象表单上传、大对象分片上传 v2；私有下载参数改为 `attname`、`e` 在 `token` 前并参与签名；RS 删除保留旧版 QBox 管理凭证。`engine/extract/index.js` 加 docx 解压大小预检与异步限额解压、ZIP 全路径边界检查、十六进制及非法字符实体处理、GBK txt 兜底。`api/uploads.js` 将 `ExtractError` 转为 400 `UPLOAD_TYPE_INVALID`，txt/docx 统一用注入的 `extractText`。`engine/net/index.js` 只接受 2xx、所有 DNS 结果校验后 IPv4 优先并在连接失败时尝试下一个，单个总截止时间覆盖 DNS、响应头、重定向和响应体。
- **核心实现**：上传凭证为 `AccessKey:EncodedSign:EncodedPutPolicy`，策略含 `scope=bucket:key` 与 `deadline`；≤8MB 的 Buffer/流使用 `POST /` 表单，较大对象经 `/buckets/<bucket>/objects/<仅对象名的URL-safe Base64>/uploads` 初始化、4MB 分片上传、按服务端返回的 etag 完成，上传或完成失败时 abort。签名下载 URL 同步返回，`token` 永远最后。docx 正文解压上限 20MB，中央目录声明值和 zlib `maxOutputLength` 双重约束，损坏文件不向 API 泄漏 `RangeError`。真实桶联调仍留 M2，需要用户授权，不在本任务访问。
- **验证**：`npm run test:server` 129/129，通过连续四轮；`npm run check` 0 错误；`npm run build` 成功。新增/调整固定时间上传凭证与私有下载签名向量、QBox 管理签名向量、分片顺序/大小/etag/失败 abort、压缩炸弹/损坏 ZIP/非法及十六进制实体、接口级损坏 docx 400/GBK txt、网络非 2xx/公网地址回退/全程超时测试。测试只使用假 HTTP/模拟存储，未产生真实供应商费用。
- **未完成 / 风险**：七牛真实桶的上传、分片、删除和 `Content-Disposition` 行为未验证，留 M2 授权联调；本分支保持待审查，复审通过前不开 M1-ENG-02。

### 2026-10-17 · Engine · M1-ENG-03 net / storage / transfer / extract

- **背景**：引擎迁移第一个任务（§6 要点 b 顺序：ENG-03 → ENG-02 → ENG-01）。按要点 a/c 与 ARCHITECTURE §5/§6、engine/README 实现。源码取自超搭云 `2926b42`（本机 `/Users/wuhen/Documents/New project`，只读未改），全部文件头注明来源与适配点；无新增第三方依赖。
- **改动（文件/模块）**：
  - 单独提交（5a8d195）：`createMemoryStorage` 从 `queue/cron.js` 迁至 `engine/storage/memory.js`（要点 c 批准的跨所有权改动），app.js/worker.js/assets.test.js 同步引用。
  - 新增 `engine/net/index.js`（Source: network-safety.js 简化适配）、`engine/storage/qiniu.js`（Source: qiniu-kodo.js + object-storage.js，S3 SDK → 原生协议）、`engine/storage/index.js`、`engine/transfer/index.js`（Source: video-transfer.js 简化）、`engine/extract/index.js`（Source: screenwriter/extract.js，mammoth → 零依赖解 ZIP）。
  - 接线：`app.js` / `worker.js` 主入口按 `config.storage.driver` 经 `createStorageFromConfig` 注入存储，API 主入口注入 `extractText`；`buildHandlers` 未注入存储时也走该解析。无新环境变量（复用 config.storage 既有配置）。
- **核心实现**：
  - `net.safeFetch(url, { maxBytes, timeoutMs })`：只允许无凭证 http(s)；DNS 预解析并校验全部结果为公网（`isPublicAddress`：v4 私网/回环/链路本地/CGNAT/保留段，v6 仅 2000::/3 且剔除 IETF 协议、Teredo、文档段，IPv4 映射因不在公网段天然拒绝），经 node:http(s) 的 `lookup` 钩子把连接**钉定**到已验证 IP（防 DNS 重绑定；Host 头与 TLS SNI 仍用原始主机名）；重定向逐跳重新解析校验、最多 3 次；Content-Length 预检 + 流式计数超限立即销毁；整体超时销毁。`resolver` 与 `httpImpl` 可注入，测试不访问外网。
  - `storage`：七牛原生协议——PUT 直传（`QBox` 签名 = path\n+body）、RS 删除（612 视为已删除，幂等）、私有空间下载签名（`?e=deadline&token=`，`download` 附 `attachment` 文件名）；内存实现同接口且支持流式 body；`createStorageFromConfig`：driver=qiniu 时要求配置完整（缺失启动报错），生产 driver=memory 直接报错。
  - `transfer.transferFromUrl(url, key, { maxBytes, timeoutMs })`：经 safeFetch 下载并流式 `storage.put`，contentType 优先参数 → 上游 → octet-stream，put 失败中断下载流。
  - `extract.extractText(buffer, mime)`：文件头优先（PK=OOXML）；docx 零依赖解 ZIP（EOCD → central directory → 本地头重算偏移 → inflateRaw）读 `word/document.xml`，按 `<w:p>` 段落、合并 `<w:t>`、解码实体；txt UTF-8 去 BOM；老式 .doc（OLE2）与二进制明确拒绝；签名与 app.js 注入点一致（`async (buffer, mime) => string`）。
- **验证（命令与结果）**：
  - `npm run test:server`：121 通过 0 失败（100 → 121，新增 21 用例：公网地址判定 30+ 例、URL/私网解析/重定向链/maxBytes 双路径/超时/HTTP 错误、七牛 PUT-RS-签名形状（注入 fetch 比对签名）与失败、createStorageFromConfig 三分支、transfer 回退链与失败中断、txt/docx/遗留 doc/损坏 ZIP/空文档）。
  - `npm run check` 0 错误；`npm run build` 成功；连续 4 轮稳定。
- **未完成 / 风险**：
  - 七牛签名按官方文档实现、单测验证「签名形状与请求拼装」，真实桶联调放 M2（`qiniu put` 的 signStr 细节以真桶为准）；默认 node:http 传输层因 SSRF 防护禁回环、无法离线联测，属薄胶水层。
  - 净逻辑移植自超搭云并简化（去掉重试/Range/公网 DNS 回退/并行分段），M2 如需断点续传再按原文件补。
  - `extractText` 的 docx 解析覆盖常规文档；加密/损坏 docx 报 `EXTRACT_INVALID`，样式类内容（表格内文本）已由 `<w:t>` 合并覆盖但编号/脚注未处理。
  - 下一步按 §6 要点 b 顺序：M1-ENG-02（providers，分支 `agent/eng/M1-ENG-02-providers`），完成后再 ENG-01。

### 2026-10-17 · BE-Core · M1-BE-04 修复（§6 审查意见 1~5）
### 2026-10-17 · BE-Core · M1-BE-04 修复（§6 审查意见 1~5）

- **背景**：Lead 审查（§6）指出 3 条必须修改 + 2 条建议（BE-05 前补上）。分支已 `git merge origin/main`（75900d4，含 PRD v2.3 文档）后修复，仍在同一分支追加提交（1fc2c25）。
- **改动（文件/模块）**：`server/src/characters/service.js`（意见 1、2、3、4）、`server/src/queue/cron.js`（意见 1③）、`server/src/api/uploads.js`（意见 5 注释）、`server/src/db/ids.js`（意见 5：新增 `cph` 前缀）、`server/test/{assets,cron}.test.js`（新增 4 组回归 + 同键并发改为真并发首发）。
- **核心实现**：
  1. 上传引用独占：`referenceUploads` 条件改为「没有被**其他**数字人的照片行引用」（`NOT EXISTS (… cp.character_id <> 本数字人)`）——被其他数字人使用返回 400；本数字人替换流程先删后加不受影响（首轮实现误用 `referenced_at IS NULL` 条件导致并发替换 400，被测试抓住后修正语义）。解除旧引用前确认无其他照片行使用；`runUploadsSweep` 删除条件加 `NOT EXISTS (character_photos)`，异常遗留数据跳过不删、不再报 23503 整批失败。
  2. 同键并发：`createLookVersion` 事务开头对 `replayKey`（用户 id+请求键）加 `pg_advisory_xact_lock`——双击场景第二个事务串行后能查到重放返回同一版本，不再误报 409 `QUOTE_EXPIRED`。回归：同键并发首发 2 请求 → 都 202、同一版本、1 条 gen_tasks/look_versions、只预占一次。
  3. submitting 策略：只有 `created` 允许提交；遇 `submitting` 且刚更新（可能仍在执行）→ 抛可重试错误让队列退避后再看；停滞超 10 分钟 → 置 `unknown`、保持冻结、记 error 日志、job 正常完成，**绝不调 provider**（等 M2 对账）。调用 provider 前后 `ctx.extendLease()` 续租。回归：模拟提交后崩溃（gen_task=submitting）→ 重领取后 provider 零调用、job 重新排队；停滞 11 分钟后转 unknown、版本 pending、金额保持冻结、job done。
  4. provider 输入补全：`generate` 入参携带该数字人照片 storage key、外貌描述、风格 `prompt_hint`；`gen_tasks.provider` 创建时暂为 `unassigned`，处理器提交时写 `imageProvider.id`。回归断言三项入参与 provider id。
  5. `character_photos` 主键改用新增 `cph` 前缀；上传上限检查处注明「检查与插入非原子、并发可略超，属可接受软限制」。
- **验证（命令与结果）**：`npm run test:server` 100 通过 0 失败（96 → 100），连续 6 轮稳定；`npm run check` 0 错误；`npm run build` 成功。
- **未完成 / 风险**：接口层面 `referenceUploads` 的独占语义为「跨数字人不可共用」，产品如需「多数字人共用照片」需走 §5 变更申请调整条件与 sweep 防御；上游重复提交窗口已由 submitting 策略收敛到「provider 调用进行中进程崩溃」一种（M2 对账工具兜底）；下一个任务是 **M1-ENG-01/02/03**（Lead 已指定顺序，BE-05 等 ENG 与 RND-01 完成后再开工）。

### 2026-10-17 · BE-Core · M1-BE-04 数字资产库与上传
### 2026-10-17 · BE-Core · M1-BE-04 数字资产库与上传

- **背景**：M1 第四个任务，按 §6 M1-BE-04 开工要点 a~g 实现。依赖 M1-BE-02（报价/钱包）与 M1-BE-03（uploads.sweep）均已就绪。无需新迁移、未改 `docs/API.md`；新增依赖 `busboy@1.6.0`（版本写死）。
- **改动（文件/模块）**：新增 `server/src/characters/service.js`、`server/src/api/{uploads,characters}.js`、`server/test/helpers/providers.js`（模拟图片模型）；`app.js`（挂载路由 + `storage`/`extractText` 注入，生产缺省报错）、`worker.js`（注册 `look.generate`，生产未注入 `imageProvider` 报错）、`config.js`/`.env.example`（`UPLOADS_MAX_UNREFERENCED=50`）；新增 `server/test/assets.test.js`（12 用例），cron.test.js 期望的处理器清单加 `look.generate`。
- **核心实现**：
  - 上传（要点 a）：busboy 流式解析（`defParamCharset: 'utf8'` 修正中文文件名）；图片按**文件头**识别 jpg/png/webp，>10MB 立即中断返回 `UPLOAD_TOO_LARGE`；key `users/<uid>/uploads/<uplId>`；未引用图片按用户限量（默认 50，超出 `RATE_LIMITED`）。故事 txt UTF-8 去 BOM 提取，docx（PK 头）走注入的 `extractText`，未注入返回 `UPLOAD_TYPE_INVALID`；只提取不落库，标题取文件名去扩展名。
  - 引用（要点 b）：创建/替换照片在同一事务条件 UPDATE 引用上传（`RETURNING id` 行数不符 400，覆盖他人/已清理/不存在）；整体替换先删旧关联行再引用新照片，被替换旧照片**解除引用**交由 uploads.sweep 回收；同数字人并发替换用 advisory 锁串行化（并发全 200、最终一致）。
  - 数字人（要点 c）：全部查询带 `user_id`、他人 404；无照片必填描述（description 列 NOT NULL，空串表示无）；`defaultVoiceId` 须为上架音色、显式 `null` 清除；软删除不动形象版本与历史作品引用；`avatarUrl` 优先最近成功选中形象、`styleIds` 只算成功选中版本、`worksCount` 按未删除作品计；媒体地址一律走注入 `urlFor`，缺素材省略字段。
  - 生成形象（要点 d）：一个事务完成 `consumeQuote({kind:'look_regenerate', refType:'character', refId})`（按 BE-02 三元组约定）→ `reserve`（金额 0 跳过，钱包约定）→ `character_looks` 补行 → `look_versions(pending)` + `gen_tasks` → `enqueue look.generate`，202 返回 LookVersion；幂等键 `look.create:<uid>:<key>`，重放返回同一版本、不重复扣费；余额不足 402 且不留版本（报价消费随事务回滚）。
  - look.generate（要点 e）：`created→submitting` 提交守卫（submitting 超 10 分钟视为上次已死，允许重提）；上游调用与转存全在事务外，异常回退状态交队列重试；`unknown` 保持 pending + 冻结 + `gen_tasks=unknown`，job 正常完成不重提；成功转存 `users/<uid>/looks/<versionId>`、**自动选中新版本**（旧版本保留）、结算；失败置 failed、全额退回。结算/退回走 `look:<versionId>:settle|refund` 幂等键，且版本状态迁移带 `AND status='pending'` 守卫——重复执行、租约被抢都不会重复动钱。
- **验证（命令与结果）**：
  - `npm run test:server`：96 通过 0 失败（83 → 96，新增 12 用例覆盖要点 g 全部必测：文件头伪装/超大/上限 429、引用他人与已清理上传 400、并发替换最终一致、并发重放只扣一次、402 不留版本、失败全额退回对账、unknown 冻结不重提、重复执行不重复结算/退回、软删除后历史作品 join 可用、生产守卫）。
  - `npm run check` 0 错误；`npm run build` 成功；连续 6 轮稳定。
- **未完成 / 风险**：
  - 图片 provider 与 storage 为注入接口：测试用 `test/helpers/providers.js` 与内存实现；ENG-02/ENG-03 完成后由 Worker/API 主入口替换注入（生产缺省已拦截）。
  - `gen_tasks.provider` 暂记 `'mock-image'`，ENG-02 接入后写真实渠道；`look_versions.view_keys` 多视角图字段已序列化但生成端暂不产出。
  - 上游重复提交的窗口：租约过期（>120s）后另一 Worker 可能重复调用 provider（gen_tasks 状态守卫只能挡住状态层面的重放）；M1 无真实费用，M2 接真实渠道时按上游幂等键（`gen_tasks.idempotency_key` 透传）兜底。
  - description 列 NOT NULL（L-02 迁移即如此），「无描述」用空串表示，API 输出时空串省略字段；如需严谨可后续迁移改 nullable（需走变更申请）。

### 2026-10-17 · BE-Core · M1-BE-03 修复（§6 审查意见 1~3）
### 2026-10-17 · BE-Core · M1-BE-03 修复（§6 审查意见 1~3）

- **背景**：Lead 审查（§6）指出 2 条必须修改（上传清理误删被引用照片、到期清理漏删片段视频）+ 1 条建议（生产禁用内存存储）。分支已 `git merge origin/main`（13f933f）后修复，仍在同一分支追加提交。
- **改动（文件/模块）**：`server/src/queue/cron.js`（意见 1、2）、`server/src/worker.js`（意见 3 与处理器传 logger）、`server/test/cron.test.js`（新增 3 个回归 + 既有断言随返回值语义调整）。
- **核心实现**：
  1. uploads.sweep 认领式删除：先在短事务里 `DELETE … WHERE id IN (候选 LIMIT n) AND referenced_at IS NULL … RETURNING storage_key`——与引用操作靠行锁互斥，引用先行则认领不到该行，对象绝不误删；提交后再删存储对象。删对象失败只记 `uploads_sweep_remove_failed` 日志：孤儿对象可接受，误删用户照片不可接受；记录已删，任务照常成功。
  2. projects.expire_sweep：成片与片段视频 key 分两条查询、以 `project_id = ANY($1)` 为条件（旧实现以 renders 为起点——无成片记录的作品漏删片段视频，且 renders × takes 笛卡尔积重复删除）；`removeAndClearVideoKeys` 事务外删对象、成功后**按 key 精确清空**（只清本次确实已删除对象的 key，`WHERE video_key = ANY($1)`）；删对象失败记日志、返回 0、本次不清 key，补偿循环遇失败即结束本轮留待下次调度（避免空转）。返回值 `cleared` 改为 `clearedKeys`（按 key 计数）。
  3. `buildHandlers` 在 `config.production` 且未注入 `storage` 时抛错拒绝启动；非生产缺省内存实现不变。处理器把 `ctx.logger` 传入清理函数，失败日志带 jobId 可追溯。
- **验证（命令与结果）**：
  - `npm run test:server`：83 通过 0 失败（80 → 83）。新增回归：①模拟删第一批对象期间引用 upl_r3——upl_r3 认领不到不被删除，行保留且 `referenced_at` 已标记，对象不在删除列表；②无 renders 行的到期作品片段视频被删且 key 清空、两成片版本全清且 `removed` 无重复、封面保留；③生产配置未注入存储抛错、非生产四个处理器正常注册。
  - `npm run check` 0 错误；`npm run build` 成功；连续 6 轮稳定。
- **未完成 / 风险**：§6「给 BE-04 / BE-05 的约定」与本分支三条约束共同生效：BE-04 引用上传用条件 UPDATE（返回行数不足即 400）；BE-05 写视频 key 前确认作品未过期；`createMemoryStorage` 待 engine/storage 完成后移入 `engine/storage/` 并删除本实现。

### 2026-10-17 · BE-Core · M1-BE-03 定时任务调度
### 2026-10-17 · BE-Core · M1-BE-03 定时任务调度

- **背景**：M1 第三个任务，按 §6 M1-BE-03 开工要点 a~g 实现。队列核心（SKIP LOCKED/租约/退避/去重）复用 L-02，无需新迁移、未改 `docs/API.md`。
- **改动（文件/模块）**：新增 `server/src/queue/cron.js`（调度器 + 四个清理任务 + 内存存储实现）；`server/src/worker.js`（注册 4 个 cron 处理器，主入口启动/停止调度器）；`server/src/config.js` 与 `.env.example`（`cron` 配置组：调度间隔、各任务周期、done 保留天数、批量）；新增 `server/test/cron.test.js`（6 用例）。
- **核心实现**：
  - 调度（要点 a）：`createScheduler` 按 `cron.tickSeconds`（默认 60s）循环、启动先调一次；每任务入队键 `cron:<类型>:<窗口起点 ISO>`，窗口起点 `floor(now/周期)×周期` 对齐——多 Worker 并发调度同窗口只入队一次。周期：auth.sweep / uploads.sweep 1h，projects.expire_sweep 5min，jobs.cleanup 1d（均可配）。
  - 分批（要点 b）：统一 `deleteInBatches`（`ctid IN (… LIMIT 批量)`，每批一个短事务，无行即停）；uploads/expire 为「选批 → 事务外动作 → 短事务收尾」结构；单批失败抛错交队列退避重试，全部可重复执行。
  - auth.sweep（要点 c）：过期限流窗口（1 天最长窗口 + 1 天缓冲）、作废或过期超 1 天的 `sms_codes`、过期 `sessions`。
  - uploads.sweep（要点 d）：24h 未引用上传先事务外 `storage.remove(keys)` 再删记录；存储为注入接口（engine/README `storage.remove`），缺省 `createMemoryStorage()`，Engine 迁移（M1-ENG-03）后替换为七牛实现。
  - projects.expire_sweep（要点 e）：短事务锁批（`FOR UPDATE SKIP LOCKED`）把 delivered 且到期的作品改 `expired` 并写 `project_events`，事务外删成片与片段视频对象，再清空 `renders.video_key` / `segment_takes.video_key`；封面、尾帧、海报与作品记录保留。另含补偿循环：清理上次中断遗留的 expired 作品视频 key。
  - jobs.cleanup（要点 f）：只删超过 `jobsDoneRetentionDays`（默认 30 天）的 done 行；删后同去重键可再入队，因此各处理器按业务状态幂等（到期清理的补偿路径即该原则的落实）。
- **验证（命令与结果）**：
  - `npm run test:server`：80 通过 0 失败（74 → 80，新增 6 用例覆盖要点 g 全部必测：两个调度器并发 tick 同窗口每任务仅 1 条 job 且重复调度不再新增；auth.sweep 清理/保留规则与可重复执行；uploads.sweep 分批边界 batchSize=2 五行删净、已引用与 24h 内保留；到期作品状态/事件/视频对象删除/`video_key` 清空/封面海报尾帧保留/未到期不动/补偿路径/可重复；jobs.cleanup 只删超期 done 行；调度入队 → `buildHandlers` 注册 → Worker `runOne` 端到端执行成功）。
  - `npm run check` 0 错误；`npm run build` 成功。
- **未完成 / 风险**：
  - `storage` 缺省为进程内内存实现（开发/测试用），生产需等 M1-ENG-03 的七牛实现并在 worker 主入口注入；接口已按 engine/README 对齐。
  - `projects.expire_sweep` 的状态迁移暂写在 cron 模块，BE-05 做作品状态机时可把它挪进 projects 模块复用统一的状态迁移函数（结构变化走变更申请）。
  - 各清理周期为【默认】值（已做成 config 可调），上线前可按数据量调整；到期的 SSE 事件依赖 `project_events` 表补发，前端 SSE 在 M1-BE-06 接入。
  - 未在长时运行的 Worker 真机上验证调度循环（测试直接驱动 `tick()`）；`setInterval` 已 `unref`，不阻塞进程退出。

### 2026-10-17 · BE-Core · M1-BE-02 修复（§6 审查意见 1~7）
### 2026-10-17 · BE-Core · M1-BE-02 修复（§6 审查意见 1~7）

- **背景**：Lead 审查（§6）指出 6 条必须修改 + 1 条建议（兑换码暴力猜解）。分支已 `git merge origin/main`（084e88b）后修复，仍在同一分支追加提交（bb26717）。
- **改动（文件/模块）**：`server/src/wallet/service.js`（意见 1~4）、`server/src/wallet/pricing.js`（意见 5~6）、`server/src/api/wallet.js`（意见 7）、`server/test/wallet.test.js`（更新 4 处既有断言/调用 + 新增 8 个回归测试）。
- **核心实现**：
  1. 流水翻页：游标改用微秒时间戳（`(extract(epoch from created_at) * 1000000)::bigint` + id 作 keyset），修复同事务多条流水 `created_at` 完全相同（`now()` 为事务开始时间）被毫秒游标整段跳过的丢数据问题。回归：同一事务 3 笔扣费，`limit=1` 逐页翻满 3 条不丢不重。
  2. 金额入口校验：`reserve/settle/refund/charge` 统一 `Number.isSafeInteger(amountFen) && amountFen > 0`，否则 INTERNAL（0 元操作无业务含义，选择直接拒绝并注释，不写流水）。回归：`charge(-500)`、`charge(0)` 均 INTERNAL 且余额不变。
  3. 幂等键隔离：首次流水命中时 `user_id` 与调用方不同 → 409 `IDEMPOTENCY_CONFLICT`。回归：他人复用同键得 409、双方余额不变。
  4. 重放比对：`withIdempotency` 查询带出 `frozen_delta_fen`，`reserve/settle/refund` 的 expect 增加该字段。回归：同键结算 100 后再结算 200 → 409。
  5. 报价归属：`consumeQuote` 必须声明 `{ kind, refType, refId }`，与报价不符抛 `QUOTE_MISMATCH`（占用随事务回滚，已测）；`priceSegmentTake` 校验 segment 属于传入 `projectId`。回归：拿 chr_a1 报价确认 chr_a2、换 kind 声明均 MISMATCH 且占用回滚；跨作品 segment_take 报价 404。**注意：BE-04/05 调用 `consumeQuote` 时必须传三元组**。
  6. estimate 对齐 PRD §6.3【默认】：下限 = 1 个 30 秒片段（30 取 `min(30, SKU 最长时长)`），上限 = 最长作品时长；形象费按「本风格缺形象的已勾选数字人数」计入上下限（缺形象 = 无该风格形象或选中版本非 succeeded，SQL 用 `NOT EXISTS … selected_version_id → status='succeeded'`）。回归：3 个勾选中 2 个缺形象 → standard {min:700, max:1900}；空勾选 {600, 1800}；hd {1200, 3600}。
  7.（建议项）兑换码尝试上限：按用户每小时 10 次（`redeem:attempt:<userId>` 固定窗口），事务外预计数（BE-01 登录限流同款，失败回滚不丢计数，并发猜码也计入）。回归：连续 10 次错码 400 后第 11 次 429 `RATE_LIMITED`。
- **验证（命令与结果）**：`npm run test:server` 74 通过 0 失败（67 → 74，新增 8 个回归 + 调整 4 处既有断言），连续 6 轮稳定；`npm run check` 0 错误；`npm run build` 成功。
- **未完成 / 风险**：给 BE-05 的约定（Lead 已记录）继续有效——`priceCastLooks` 以 `look_version_id IS NULL` 为缺形象，故事理解 job 需为已有本风格形象的角色写好该字段；`consumeQuote` 新签名的调用方适配在 BE-04/05 落地。

### 2026-10-17 · BE-Core · M1-BE-02 钱包与计价（含遗留 5 修复）
### 2026-10-17 · BE-Core · M1-BE-02 钱包与计价（含遗留 5 修复）

- **背景**：M1 第二个任务。分支前两个提交先修 §6 遗留第 5 条（发码冷却拦截不计每日次数），随后按 §6 M1-BE-02 开工要点 a~e 实现钱包与计价。复用现有表结构与错误码，无需新迁移，未改 `docs/API.md`。
- **改动（文件/模块）**：
  - 遗留 5：`server/src/auth/sms.js`（每日上限移入手机号级事务锁内、冷却通过后计数）+ `server/test/auth.test.js` 回归。
  - 新增 `server/src/wallet/service.js`：`reserve/settle/refund/charge/redeem`（接收调用方事务作用域 `t`，要点 a）、`getWallet`、`listLedger`（keyset 分页）。
  - 新增 `server/src/wallet/pricing.js`：四种 kind 计价函数注册表（要点 b）、`createQuote`、`consumeQuote`（要点 c）、`estimateQuote`、`getActiveTierSku`。
  - 新增 `server/src/api/wallet.js`（GET /wallet、GET /wallet/ledger、POST /wallet/redeem）、`server/src/api/quotes.js`（POST /quotes、POST /quotes/estimate），逐路由挂 `requireAuth`；`app.js` 接线。
  - `server/src/auth/session.js`：`requireAuth` 改为模块级导出供业务路由复用（auth/index.js 行为不变）；新增 `server/test/wallet.test.js`（14 用例）。
- **核心实现**：
  - 账本（要点 a）：余额用带条件 `UPDATE … WHERE available_fen/frozen_fen >= $amount` 原子增减，影响 0 行即 402（结算/退回的冻结不足属调用方错误，按 INTERNAL 兜底暴露）；幂等键加事务级 advisory 锁后查首次流水，同键重放返回首次结果，同键不同参数（kind/金额/ref）409 `IDEMPOTENCY_CONFLICT`。
  - 计价（要点 b）：`project_render`/`segment_take` 按作品锁定 `tier_mapping_id` 对应 sku_code 的当前生效版本取价（非当前映射）；形象单价取 `settings.look_image_sku_code` 当前生效 SKU；`cast_looks` 按 `project_cast.look_version_id IS NULL` 计数；四种 kind 的 `project_render`/`cast_looks`/`segment_take` 计价函数已就绪，测试直接插作品/片段行验证，不等 BE-05。
  - 报价（要点 c）：落库 `params_hash`（结构参数：片段清单、角色/风格、数量）+ `price_snapshot`（含请求参数与 sku 版本单价，供重算）；`consumeQuote` 原子占用（`consumed_at` 条件更新）→ 按当前状态与价格重算 → 比对，不一致 409 `QUOTE_MISMATCH`（占用随调用方事务回滚），过期/已消费 409 `QUOTE_EXPIRED`，他人报价 404。
  - 兑换码（要点 d）：只存 sha256 哈希；`used_by IS NULL` 条件更新防并发重复兑换；无效/已用统一「兑换码无效或已被使用」（400，不暴露区分）；流水标题中文。
- **验证（命令与结果）**：
  - `npm run test:server`：67 通过 0 失败（新增 14 用例覆盖要点 e 全部必测：并发预占不超扣（100 分并发预占 30 分仅 3 次成功、终态 10/90）、幂等重放、同键不同参数 409、调价后旧报价 `QUOTE_MISMATCH` 且占用回滚、参数变化 `QUOTE_MISMATCH`、过期 `QUOTE_EXPIRED`、并发兑换同一码仅一次、流水分页与非法 cursor、他人资源 404、HTTP 契约与登录守卫），连续 6 轮稳定。
  - `npm run check` 0 错误；`npm run build` 成功。
  - 遗留 5 回归：冷却期内并发 10 次发码后 `sms:daily` 计数仅 1，冷却过后仍能再发。
- **未完成 / 风险**：
  - `estimate` 的 min/max 口径为【默认】实现（min=档位单价×最短单段时长；max=档位单价×最长作品时长+数字人数×形象单价），待用户确认（HANDOFF §4.3 已登记），确认后只改 `estimateQuote` 一个函数。
  - `quotes` 表未存原始请求 JSON，重算依赖 `price_snapshot.request`；若后续 kind 增加参数需同步两处。
  - 结算/退回的冻结不足按 500 兜底（正常流程不会出现），供审查确认该取舍。
  - 充值（`recharge`）真实支付在 M3，当前只有兑换码入账路径。

### 2026-10-17 · BE-Core · M1-BE-01 修复（§6 审查意见 1~4）

- **背景**：Lead 审查（§6）指出 2 个并发竞态必须修复，另 2 条建议顺手改。本分支已 `git merge origin/main`（67fb2f5）后修复，仍在同一分支追加提交。
- **改动（文件/模块）**：`server/src/auth/sms.js`（意见 1、2、3）、`server/src/auth/routes.js`（意见 4）、`server/src/auth/index.js`（console provider 接收 config）、`server/test/auth.test.js`（新增 4 个用例并调整 logout 401 断言）。
- **核心实现**：
  1. 发码竞态：「冷却检查 → 作废旧码 → 插入新码」放进带 `pg_advisory_xact_lock(hashtext('sms:' || phone))` 的短事务，同手机号并发请求在此串行化，冷却不可被并发绕过；短信 provider 发送仍在事务外，发送失败按行 id 删除、不占冷却。
  2. 错误次数竞态：改为**先原子占用一次尝试再比对哈希**（`UPDATE … SET attempts = attempts + 1 WHERE id = $1 AND consumed_at IS NULL AND attempts < 上限 RETURNING id`，无返回行即拒绝），占用语句自带行锁，并发提交不再读到旧值；错达上限即作废；正确路径保留短事务行锁复核，防并发同码双登录。
  3. console provider 文案按 `codeTtlSeconds` 向上取整到分钟输出，不再写死「10 分钟」。
  4. `POST /auth/logout` 去掉 `requireAuth`：无会话（含已过期 Cookie）也清 Cookie 并返回 `{ ok: true }`，与 API.md §1 一致；有会话时仍校验 CSRF 并删除会话行。
- **验证（命令与结果）**：
  - `npm run test:server`：52 通过 0 失败，连续 4 轮稳定。新增并发回归：同手机号并发 10 次发码仅 1 次 200、仅发 1 条短信、未作废码仅 1 条（其余 9 次 429 `SMS_COOLDOWN`）；并发 15 个错误验证码 `attempts=5`（比对次数不超上限）且已作废。另新增无会话 logout 200+清 Cookie、console 文案 5 分钟/2 分钟两例。
  - `npm run check` 0 错误；`npm run build` 成功。
- **未完成 / 风险**：同上一条记录；`rate_counters`/过期 `sms_codes`/过期 `sessions` 清理已由 Lead 登记进 M1-BE-03，免费次数按北京时间切日登记在 M1-BE-05，本分支不处理。

### 2026-10-17 · BE-Core · M1-BE-01 认证

- **背景**：M1 骨架跑通的第一个任务。复用 L-02 的 `users` `sms_codes` `sessions` `rate_counters` 表结构与既有错误码，无需新迁移，未改 `docs/API.md`（即无需 §5 变更申请）。
- **改动（文件/模块）**：
  - 新增 `server/src/auth/`：`ratelimit.js`（PG 固定窗口限流）、`session.js`（会话中间件 / CSRF 守卫 / 用户序列化）、`sms.js`（验证码发放与校验 + 登录注册 + console provider）、`routes.js`（5 个端点）、`index.js`（`createAuth` 组装）。
  - `server/src/config.js`：新增 `sms` 配置组（provider、验证码 TTL、冷却、每日上限、错误次数上限、登录限流）+ 生产禁用 console provider 的启动拦截；`server/.env.example` 同步。
  - `server/src/app.js`：在预留插入点接线 `createAuth`（会话 → CSRF/Origin → 认证路由），`createApp` 新增 `smsProvider` 注入点；新增 `server/test/auth.test.js`（22 个用例）。
- **核心实现**：
  - 验证码：6 位码按手机号掺盐 sha256 存储（10^6 空间不掺盐可被离线碰撞）；冷却看最近一次发送时间（避免固定窗口边界连发），每日上限走 `rate_counters`；发新码前作废旧码，登录只认最新一条；发送失败删行、不占冷却，返回 502 `UPSTREAM_FAILED`。
  - 登录：失败计数（`attempts` 自增、达上限作废）在**事务外自提交**——首版放在事务内，抛错即回滚导致计数永不生效，被本任务测试暴露后修正；成功路径短事务：行锁复核 → 消费验证码 → 建用户 + 钱包行（随注册建好，M1-BE-02 无需懒建）→ 建会话。新用户 `tourCompletedAt=null`（验收点）。
  - 会话与 CSRF：Cookie `miv_sid`（HttpOnly / SameSite=Lax / 生产 Secure），库中只存 token 哈希；过期或被停用账号的会话在中间件里顺手删除。写请求先校验 Origin 白名单（无 Origin 放行，兼容非浏览器客户端）；存在会话时再校验 `X-CSRF-Token`；`/auth/sms`、`/auth/login` 登录前无 token，由 Origin + SameSite 防护。
  - `PATCH /me/onboarding`：`tourCompletedAt` 只记首次完成（完成与跳过都传 true，重播不改服务端状态），`tipsSeen` 追加去重，两字段至少一个。
- **验证（命令与结果）**：
  - `npm ci` ✓；`npm run test:db:up` ✓（miv-test 容器健康）。
  - `npm run test:server`：48 通过 0 失败（原 26 + auth 22：未登录 401、CSRF 缺失/错 Origin 403、冷却 429、错 5 次作废、过期码、日发送上限、登录限流、新用户 `tourCompletedAt=null`、onboarding 幂等/去重/参数校验、logout 失效并清 Cookie、provider 故障 502 不占冷却、生产配置拦截）。
  - `npm run check` 0 错误；`npm run build` 成功。
- **未完成 / 风险**：
  - 短信 provider 仅实现 console（开发/测试把验证码打印到控制台）；生产启动会拦截并要求注入真实 provider（接真实短信放 M2/M3）。
  - 验证码哈希为 sha256+手机号掺盐 + 5 次错误上限，上线前可评估升级 argon2/bcrypt（需新增依赖）。
  - 每日上限窗口按 UTC 对齐；如需按北京时间「每天」，后续在运营配置里调整。
  - 真实短信发送未验证（遵守不产生真实费用的约束）；限流仅按手机号维度，未做按 IP（M2 结合部署形态评估）。

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
