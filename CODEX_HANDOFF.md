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
| 阻塞项 | M0 需用户授权真实费用与上限（不阻塞 M1）；中文产品名暂用代号 |

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
| M1-BE-05 | BE-Core（本机开发 Agent） | `agent/be/M1-BE-05-projects` | `server/src/projects/**` `server/migrations/00{2,3}*.sql` `server/src/worker.js` `server/src/config.js` `server/test/projects/**` `server/.env.example` | 待复审（复审补充 2 条必改已修复，233/233） | 2026-10-21 |
| M1-BE-06 | BE-Core（本机开发 Agent） | `agent/be/M1-BE-06-project-api` | `server/src/api/projects.js` `server/src/app.js` `server/src/projects/service.js` `server/src/projects/segment.js` `server/src/projects/compose.js` `server/test/projects/project-api.test.js` | 已合并 main | 2026-10-21 |
| M1-ENG-01 | Engine（本机开发 Agent） | `agent/eng/M1-ENG-01-story` | `server/src/engine/{story,llm}/**` `server/test/engine/{story*,pi-llm*,fixtures/story/**}` `server/package.json` | ✅ 完成（Lead 第三轮复审通过并合并 `298929d`） | 2026-10-19 |
| M1-ENG-02 | Engine（本机开发 Agent） | `agent/eng/M1-ENG-02-providers` | `server/src/engine/providers/**` `server/test/engine/{providers*,fixtures/**}` | ✅ 完成（Lead 第三轮复审通过并合并） | 2026-10-17 |
| M1-ENG-03 | Engine（本机开发 Agent） | `agent/eng/M1-ENG-03-infra` | `server/src/engine/{net,storage,transfer,extract}/**` `server/src/{app.js,worker.js,queue/cron.js,db/ids.js}` `server/test/engine/**` | ✅ 完成（Lead 第四轮复审通过并合并） | 2026-10-17 |
| M1-ENG-04 | Engine（本机开发 Agent） | `agent/eng/M1-ENG-04-skills` | `server/src/engine/skills/**` `server/src/engine/story/**` `server/src/engine/README.md` `server/test/engine/**` | ✅ 完成（Lead 复审通过并合并 `6daa673`） | 2026-10-19 |
| M1-RND-01 | Render（本机开发 Agent） | `agent/render/M1-RND-01-compose` | `server/src/render/**` `server/test/render/**` | ✅ 完成（Lead 复审通过并合并 `fddb5df`） | 2026-10-20 |
| M0-02（渠道接入部分：Modelhub seedance-2.5 + gpt-image-2.5-flare） | Engine（本机开发 Agent） | `agent/eng/M0-02-modelhub-channel` | `server/src/engine/providers/**` `server/src/config.js` `server/.env.example` `server/scripts/modelhub-smoke.js` `docs/m0/**` | 进行中（用户 2026-10-21 提供渠道密钥并指定模型） | 2026-10-21 |
| M1-WEB-01 | — | — | — | 待认领 | — |
| M1-WEB-02 | — | — | — | 待认领 | — |

状态取值：待认领 / 进行中 / 待审查 / 🔁 需修改 / ✅ 完成 / ⛔ 阻塞（写原因）。

**建议开工顺序**（只有一个开发 Agent 时）：M1-BE-01 → M1-BE-02 → M1-BE-03 → M1-ENG-01 / 02 / 03 → M1-BE-04 → M1-RND-01 → M1-BE-05 → M1-BE-06 → M1-WEB-01 / 02。ENG 与 BE 无代码依赖，有多个 Agent 时可并行。BE 系列必须串行，同一时间只开一个 BE 分支。

## 3. 决策记录（最新在上）

| 日期 | 决策 | 来源 |
|---|---|---|
| 2026-10-20 | **美术素材**：团队有专业美工；素材清单与规格见 `docs/ASSETS.md`（P0 内测前、P1 上线前）。六张风格示例图由美工制作，以美工版本为准。**用户已确认（2026-10-20）：素材可以公开，不考虑版权问题**，可直接提交进仓库。开发 Agent 在美工素材到位前继续用占位。 | 用户 |
| 2026-10-20 | **片段失败的资金口径（Lead 追认 BE-05 §5①，A 口径）**：片段上游失败或基础技术检查不通过 → 作品进入 failed，该段预占**保持冻结**；用户 `retry` 免费重建该片段并复用冻结金额，成功后才结算；取消时一次性退回全部未结算部分；失败产生的上游成本由平台承担（重试无次数限制的资损敞口待运营数据后评估上限）。提交结果未知（unknown）的片段金额冻结待对账，**项目 failed 后 retry 必须拒绝**（不自动、也不经重试重复提交）。后续项（M2-BE-02）：failed 作品超过 N 天（默认 7 天，【默认】可配置）自动取消并退回未结算冻结，并在到期前提醒。 | Lead 裁决（实现与账本约束使然；用户可随时推翻） |
| 2026-10-20 | **M0 真实模型验证授权**：费用上限 **300 元**（累计，含图片/视频/LLM）。规则：① **由开发 Agent 在其设备上执行**（它写渠道接口/SDK 适配并持有渠道密钥）；Lead 不需要也不接收密钥；② 密钥只放执行设备的环境变量或不入库的本地 `.env`，**禁止**写入仓库、handoff、日志、提示词或聊天（仓库公开）；③ 运行器必须有**硬上限**：每次调用前按已知单价估算并累计到 `docs/m0/cost-ledger.json`（只记渠道、模型、时长、估算与实际费用，不含密钥），累计达到 **270 元（上限的 90%）停止并报告**，不得超出 300 元；估算不确定的调用先用最短时长小样；④ 渠道账户侧尽量再加一层保护（给 M0 单独充值有限额度或使用有额度的子密钥）；⑤ 范围仅限 TASKS M0-02 所列验证项，超出范围的真实调用需另行授权；⑥ 完成后产出 `docs/m0/report.md`（结论、成本表、对 Skill 参数与 SKU 的建议、未验证项）并通知 Lead 审查。 | 用户 |
| 2026-10-20 | ① 充值预设金额 **50 / 100 / 500 / 1000 元**（`amountsFen=[5000,10000,50000,100000]`），单笔上限 1000 元，1:1 到账；② 中文产品名暂用开发代号 **Mini AI Video**，正式名上线前再定。 | 用户 |
| 2026-10-20 | **运行环境**：开发在 Mac，**上线运行在 Linux 云服务器**（用户提醒）。含义：① 以 Linux 容器为准——FFmpeg、中文字体、路径大小写、`/tmp` 与磁盘都按 Linux 设计；② 代码与测试不得依赖 Mac 特有行为（路径、字体、系统自带 FFmpeg、`ffmpeg-full` 的额外滤镜如 `drawtext`/`libfreetype`）；③ 生产镜像必须自带 `ffmpeg`/`ffprobe` 与中文字体（如 Noto Sans CJK），并在镜像里跑 render 测试；④ 开发 Agent 可能是 arm64 Mac，服务器多为 amd64，依赖不得有平台专属二进制（安装脚本、原生模块要在 Linux 上验证）；⑤ 提交里不得出现开发机本地路径或系统产物（如 `{{pkgetc}}` 符号链接）。Lead 的审查环境是 Linux，更接近生产。**已确认（2026-10-20）：生产服务器 Ubuntu amd64，Docker 部署**——镜像以 amd64 为准（基础镜像用 Debian/Ubuntu 系的 `node:22-bookworm-slim` 一类，Worker 镜像装 `ffmpeg` 与 `fonts-noto-cjk`），arm64 仅用于开发机本地构建。 | 用户 |
| 2026-10-19 | ① 想法/剧本判定阈值改为**约 60 字**；② 总时长仍由 agent 决定、上限 90 秒、用户不选；③ Wan 3.0 Skill：部分参考官方，**尽量每片段 30 秒、输出 30 秒提示词**，保留英文动作与镜头语言 + 中文对白，镜头长度放宽为 3~8 秒（对白镜头 10 秒），官方 2~5 秒作 M0 对照；④ **片段全部串行生成**；⑤ **第一版做基础技术检查**（可解码、有视频与音频流、时长、画幅、非全黑、非卡住、非静音），智能质检仍暂缓；⑥ 场景与道具只做文字设定集，不做用户可替换的资产 | 用户 |
| 2026-10-19 | **编剧扩写**：用户输入剧本/脚本时忠实处理（不新增对白）；只有一句话想法时由 pi 按想法、风格、时长上限扩写成剧本（可创作对白），用户在确认点 A 确认/编辑剧本全文后进入自动流程；Wan 3.0 Skill 已按阿里云官方提示词指南重写为 v2（`图N`/`音频N` 记号、每镜头 2~5 秒、`无台词`、`口型同步`、负向清单规范） | 用户 |
| 2026-10-19 | 故事理解输出增加「设定集」（人物简称与外观、场景、道具，英文，一次生成后只读）和每段「结束状态」；最终提示词由代码拼装、设定集逐字注入；提示词 Skill 按视频模型分文件，主力 Wan 3.0，用户提供的实测提示词已改造为 `docs/skills/wan-3.0.md` | 用户 |
| 2026-10-17 | 生成数字人形象只使用第一张参考照片（当前图片模型参考图上限 1 张），其余照片保存在资产库；换用支持多图的模型后再启用 | 用户 |
| 2026-10-17 | 视频使用「全能参考（omni_reference）」模式的模型（图片 + 音频参考）；「接上段尾帧」只作为普通参考图（尽力而为），首尾帧模式与音频冲突暂时忽略；上线渠道不绑定 Modelhub，适配器可替换，渠道与模型以 M0 结论为准 | 用户 |
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

1. ~~中文产品名~~ 已决：暂用开发代号 Mini AI Video。
2. ~~M0 授权与费用上限~~ 已决（2026-10-20）：授权真实模型调用，**累计费用上限 300 元**；执行规则见 §3 同日决策记录。
3. PRD【默认】细则：首页价格区间估算方式、保存期从首次交付起算且替换片段不延长、到期前 7 天提醒、每天 20 次免费故事理解、新手引导步骤与文案。
4. 定价与 SKU 档位映射（M0 后给建议；当前为占位 mock 价：标准 0.20 元/秒、高清 0.40 元/秒、形象 0.50 元/个）。
5. 生成式 AI 备案主体（M3）。
6. 充值相关（PRD 6.4、§12 第 4 条）：（预设金额已决：50/100/500/1000 元，上限 1000 元）充值退款政策、易支付商户资质 / 结算周期 / 费率、真实小额联调的授权与金额上限。

## 5. 接口/跨域变更申请

| 日期 | 申请人 | 内容 | 影响 | 处理结果 |
|---|---|---|---|---|
| 2026-10-21 | BE-Core（M1-BE-06） | **types.ts 与 API.md §6.2 的 StoryResult 字段不一致**：API.md 有 `inputKind`/`expanded`/`script`（M1-WEB-01 确认点 A 需要 script 与 expanded 标注），apps/web/src/api/types.ts 的 StoryResult 缺这三个字段。契约测试按「types.ts 声明的字段必须存在且类型一致（API.md 多出的字段允许）」执行，后端按 API.md 全量返回。请 Web 角色把 types.ts 的 StoryResult 补齐为与 API.md 一致（补丁 3 行），避免后续契约漂移。 | 影响：apps/web/src/api/types.ts（Web 角色）；后端不变 | 待 Web/Lead 处理 |
| 2026-10-20 | BE-Core（M1-BE-05） | ① **「失败即退回 + 重试免费」的资损口径**：ARCHITECTURE §4 写「inspect 不通过 → 该片段失败并退回预占」，API §6.5 的 `retry` 不带 quoteId（免费重试、无次数限制）。实现时发现按字面（B）**在账本上不成立**：失败退回该段冻结后，重试成功无处可结算。**已按 A 口径实现：失败保持冻结（不退回），重试免费重建并照常结算，取消/放弃（failed → cancel）时按未结算部分一次性退回**；重试无次数限制的资损敞口同前。如需改回「失败即退回」请同时给 retry 定价（quoteId），我再调整。② **片段提交结果未知（take unknown）时项目的呈现**：gen_task/take 置 unknown、金额保持冻结、不自动重提（BE-04 既有惯例）已定；项目本身我实现为进入 `failed`（`error.code=TAKE_UNKNOWN`、中文提示、`retry` 空转不重提），让用户看到终态而不是永远「生成中」。请确认两项。 | 影响：确认点 B 预占 → 片段失败/取消/重试的钱包流；BE-06 API 呈现 | 待 Lead 追认（实现按 A） |
| 2026-10-19 | Engine（M1-ENG-04） | 按规格实现时做了以下解释口径，请 Lead 确认；如需调整都是小改动：① `understand` 输出的 segments[].takeMode（`multi_shot`/`single_take`，缺省 `multi_shot`）——wan-3.0.md §8 说 takeMode 由规划阶段逐段指定，但 ARCHITECTURE §5 的输出清单未列该字段，已按 §8 实现并写入 README；② `bindPrompts` 的 `ratio` 参数保留但不再进提示词正文（wan-3.0.md §6 拼装模板没有画幅块），画幅由生成请求的 ratio 字段表达；③ `assemble` 注入 startState/endState/mood/brief 前去掉尾部英文句号、按模板补标点——§6 模板与成品示例在「连贯性」行尾差一个字符（模板 `。` vs 示例 `.`），按模板执行，成品示例逐字测试按此口径；④ `classifyInput` 确定性细则：不超过阈值（默认 60 字，可配置）且不含对白标记（「」『』引号对白、说/问/答/喊等+冒号）与场景字段（场景/地点/时间/内景/外景+冒号）判为「想法」；⑤ 设定集与 endState 的英文-only、handle 唯一、sceneId/propIds 引用存在为**硬校验**（进修复重试），词数上限（mood ≤8、brief ≤25、场景 ≤50、endState ≤50 词）为**软限制**（归一化截断并记 warn），避免真实模型频繁被打回兜底；⑥ `single_take`（一镜到底）整段即一个镜头，豁免逐镜头 3~8 秒上限（否则 30 秒一镜到底必然校验失败，§7 未明确此例外；兜底时间线同理）。 | 影响：BE-05 需按 `server/src/engine/README.md` 的新字段对接（bible/script/final_prompt/expandIdea/classifyInput）；无数据库变更 | ✅ 已裁决：六条全部接受（Lead 2026-10-19，见 §6 M1-ENG-04 审查记录；①已同步写入 ARCHITECTURE §5） |

## 6. 审查记录（Lead 填写，最新在上）

| 日期 | 分支 / 任务 | 结论 | 问题清单 / 备注 |
|---|---|---|---|
| 2026-10-21 | `agent/be/M1-BE-06-project-api` @ `c011798`（M1-BE-06 复审） | ✅ 通过并合并 | 4 条必改 + 3 条建议均已修复并核对代码：re-take 明确失败当场 `refundRetake`（幂等，明确失败判定先于 unknown）；改剧情后 re-take 提交前只为该段重绑定提示词（剧情快照比对，没改不调 LLM）；SSE 无 Last-Event-ID 从当前最大 id 起、到期 `res.end()`、每用户连接上限 5；结算/退款一律取 `request.amountFen`；`PUT /cast` null 语义。测试 242/242、check 通过（Linux amd64）。**下一步**：M0 真实模型验证（待用户提供渠道/LLM 密钥给开发 Agent）、七牛联调（待测试桶与费用上限）、前端 M1-WEB-01。 |
| 2026-10-21 | `agent/be/M1-BE-06-project-api` @ `cee9ad7`（M1-BE-06） | 🔁 需修改（4 条必改） | 做得好的：路由只做校验与编排、业务在 service；`Fields` 严格校验未知字段；他人作品一律 404；列表用 `(updated_at,id)` 游标；契约测试把 `types.ts` 的类型解析出来逐字段核对响应形状；re-take 复用 gen_tasks 幂等键、新增候选永不覆盖；重新拼接走新 render 记录且状态保持 delivered；`delivered_at` 用 COALESCE 不被覆盖；下载链接带 `attname`。测试 238/238、check 通过（Linux amd64）。<br>**必须修改**<br>1. **交付后 re-take 失败不会退款，钱永久冻结**（`money.js` 新增的 `refundRetake` 全仓库没有任何调用；`segment.js` 的 `failSegment` 在 `keepDelivered` 分支只写日志）。delivered 作品没有 retry/cancel 入口，用户为一次失败的重新生成预占的钱永远回不来。期望：redelivery 的 take 在“明确失败”（上游失败 / inspect 不通过）时，同事务调用 `refundRetake` 退回该笔预占（幂等键已按 takeId 区分）；“结果未知/轮询超时”保持冻结待对账（与首次生成口径一致）；补测试：re-take 失败 → 钱包可用额恢复、`frozenFen` 归零、旧 take 仍为选中、项目仍 delivered；重复执行只退一次。<br>2. **`PATCH …/segments/:segmentId`（改剧情）对 re-take 没有任何效果**（`createSegmentTake` 直接复用旧的 `segments.final_prompt.prompt`，`plot` 列只用于展示）。用户改了剧情再重新生成，得到的还是原来的画面，既不对又照样扣钱。期望：redelivery 的 `segment.generate` 在提交前，若该片段 `plot` 在上次绑定之后被修改过，就用 `storyAgent.bindPrompts` 只为这一段重新生成镜头时间线和最终提示词（`startState` 取上一段 `endState`，bible 从 `projects.story.raw.bible`，角色形象/音色沿用已锁定的），写回 `final_prompt` 与 gen_task 请求；绑定失败走引擎的确定性兜底，不阻塞；对白以 `segments.dialogue` 为准（本接口只改 `plot`，不改对白）；补测试：改 plot → re-take → 提交给上游的提示词里包含新剧情；没改 plot 不重复调用 LLM。<br>3. **SSE 两处缺陷**（`api/projects.js`）：(a) 没带 `Last-Event-ID` 的新连接 `lastId` 为 `null`，查询没有 `id >` 条件，会把整个作品的历史事件（每秒 100 条）按顺序全部重放，客户端先收到当前快照再收到历史状态，界面会回跳到旧状态。期望：无 `Last-Event-ID` 时 `lastId` 初始化为该作品当前最大事件 id（快照代表“当前”）。(b) 超过 `SSE_MAX_AGE_MS` 后只把 `closing = true`，响应并没有结束：心跳和轮询都停了，连接却一直挂着，客户端既收不到事件也不会重连，界面永远停在旧状态。期望：到期直接 `res.end()`（客户端按 EventSource 默认行为带 `Last-Event-ID` 重连）。补测试：新连接不重放历史；最大存活期很短（可注入）时服务端主动结束连接。<br>4. **结算金额应取任务创建时的 `amountFen`，不是结算当时重新查价**（`gen.poll` 里 `videoUnitFen(...) × 秒数`）。运营在片段生成过程中调价（SKU 新版本生效）时，结算额与预占额不一致：调高 → 结算超过冻结，结算失败，视频已生成却无法交付；调低 → 冻结残留。`segment.generate` 已把 `amountFen` 写进 `gen_tasks.request`，请 `gen.poll`、`failSegment` 一律使用它；补测试：生成过程中把 SKU 价格调高，结算仍按下单时的金额成功。<br>**建议修改（不阻塞）**<br>5. 测试里残留 `console.log('DEBUG …')`（project-api.test.js 多处），请删除。6. SSE 每个连接每秒查一次库，用户多时压力线性增长；先加每用户并发连接上限（如 5），M2 再改成 LISTEN/NOTIFY（`appendEvent` 已发 `pg_notify`）。7. `PUT /cast/:castId` 的 `lookVersionId: null` 被转成 `undefined`，无法“清除选择”，与 API 语义不一致，请按 `hasOwnProperty` 传递 `null`。 |
| 2026-10-20 | `agent/be/M1-BE-05-projects` @ `6f6ebe2`（M1-BE-05 第三轮） | ✅ 通过并合并 | 2 条小必改已修：`extractLastFrame` 传入 job 的 `workDir`，清空 `/tmp` 后单独跑作品测试 25/25，`miv-frame-`/`miv-take-`/`miv-compose-` 残留均为 0（`server/test/render` 自身用例用默认临时目录，属测试范围内，不是 Worker 路径）；casting 的 unknown 守卫改查 `gen_tasks.status`，新增用例覆盖 形象 unknown → `failed(LOOK_UNKNOWN)` → retry 被拒 → 上游调用不增加 → cancel 退未冻结部分。测试 233/233、check、build 通过（Linux amd64；合并后 `main` 同样通过）。**下一步**：M1-BE-06（作品 API + SSE + 交付后片段替换与重新拼接 + 下载）。 |
| 2026-10-20 | `agent/be/M1-BE-05-projects` @ `7a9b393`（M1-BE-05 复审） | 🔁 需修改（2 条必改，都很小；其余 4 条已验证修好） | 已验证修好：③ 提交给上游的是签名链接、`gen_tasks.request` 仍存 key（测试断言 https 形态）；④ 轮询超时默认 7200 秒，超时按 unknown、冻结、不重提；② 形象失败 → 项目 `failed(LOOK_FAILED)` → retry 复制原请求的描述与参考照片 → 推进 cast_review；`projectMoneySummary` 改为按角色关联归集形象流水，换版本后不再丢退款；① 片段 unknown 后 retry 被拒、上游提交次数保持 1；建议项 6~11 全做了（usage、skillId、固定取消幂等键、IDEMPOTENCY_CONFLICT、只吞 PROJECT_STATE_INVALID）。测试 232/232、check 通过。<br>**必须修改**<br>1. **`extractLastFrame` 仍在泄漏临时目录**（`segment.js` 第 301 行 `render.extractLastFrame(localPath)` 没有传 `workDir`；上一轮必改 5 只改了 compose）。探针：清空 `/tmp/miv-frame-*` 后跑 3 个用例，留下 4 个 `miv-frame-*` 目录（每段一个）。现有“必改 5”测试只统计 `miv-take-` 和 `miv-compose-` 前缀，所以没发现。期望：传入 job 自己的 `workDir`（`finally` 已清理）；测试把 `miv-frame-` 也纳入统计，并断言 job 结束后为 0。<br>2. **casting 阶段 `LOOK_UNKNOWN` 的 retry 守卫是死代码**（`service.js` `retryProject` 的 casting 分支查 `look_versions.status = 'unknown'`，而该列的 CHECK 约束只有 `pending/running/succeeded/failed`，unknown 记在 `gen_tasks.status`）。后果：形象结果未知后用户点重试，项目回到 `casting`，但没有任何东西入队（失败版本筛选的是 `failed`），作品又卡在 casting，且没有错误提示。期望：守卫改查 `gen_tasks`（`JOIN look_versions lv ON lv.gen_task_id = gt.id` 且 `gt.status = 'unknown'`，范围为本作品的 `project_cast.look_version_id`），命中时 409 “该形象结果待核对，请联系客服”；补测试：让图片模型返回 unknown → 项目 `failed(LOOK_UNKNOWN)` → retry 被拒 → 上游调用次数不增加 → cancel 退回未冻结部分。 |
| 2026-10-20 | `agent/be/M1-BE-05-projects` @ `b232745`（M1-BE-05） | 🔁 需修改（5 条必改；其余实现扎实） | 做得好的：状态迁移用条件 UPDATE+事件+NOTIFY 同事务、事务内不等上游；确认点幂等重放先于状态校验；免费次数按北京日；consumeQuote 重新计价防篡改；串行链、提交守卫（`created→submitting` 条件更新、停滞 submitting 置 unknown）、尾帧排最前与提示词 `图1` 一致；完成态下载→inspect→转存→尾帧→逐段结算；暂停/恢复/取消；测试 228/228、check 通过（Linux amd64）。**§5 两项口径 Lead 追认**：① A 口径（失败保持冻结，重试复用，取消退未结算）成立，已写入 PRD/ARCHITECTURE/§3 决策并登记 M2-BE-02「failed 超 7 天自动取消退款」；② unknown 呈现为 failed 可接受，但见必改 1。Lead 探针（把测试夹具改成探针复现）：<br>**必须修改**<br>1. **`retry` 会重复提交 unknown 的片段**（`service.js` `retryProject` rendering 分支）。探针：首段提交返回 `unknown` → 项目 `failed(TAKE_UNKNOWN)` → `retryProject` → 状态回 `rendering`、入队 `segment.generate` → 再执行：上游**第二次**收到提交（`submissions.length === 2`）。这违反“结果未知保持冻结、不重提”，上游第一次可能已受理，会双倍扣费，且 unknown 那段冻结永远挂着。期望：`error.code === 'TAKE_UNKNOWN'`（或该作品存在 `unknown` take）时 `retry` 直接 409 `PROJECT_STATE_INVALID`，文案“该片段结果待核对，请联系客服”；只能 cancel（现有逻辑）；补测试：unknown 后 retry 被拒、上游提交次数保持 1。<br>2. **形象生成失败后项目永远停在 `casting`**（`characters/service.js` 的 look.generate 失败/unknown 路径没有通知项目）。探针：故意让图片模型返回 `failed` → 形象版本失败并退款，但项目仍是 `casting`、无 `error`，用户既不能 retry（retry 要求 failed）也看不到原因，只能 cancel；`retryProject` 的 casting 分支因此是死代码。并且该分支重建形象时 `description: ''`、`referenceKeys: []`，丢了原来的描述与参考照片，生成结果会和第一次不一致。期望：① look.generate 终态失败（definitive failed）→ 同事务把引用该版本的 `casting` 作品置 `failed`（`code: LOOK_FAILED, step: 'casting'`，中文提示）；`unknown` 置 `failed(LOOK_UNKNOWN)` 且 retry 拒绝（同必改 1）；② casting 重试时从失败版本的 `gen_tasks.request` 复制 `description`/`referenceKeys`/`promptHint`（金额 0：平台承担，已在失败时退款）；补测试：失败→failed→retry→新版本请求里描述与参考照片与原请求一致→成功后推进 cast_review；retry 后 `pricing`/取消退款金额与钱包一致（再次探针 `frozenFen`，注意失败版本的退款流水以 look 为 ref，换版本后不能让 `projectMoneySummary` 丢掉它）。<br>3. **参考素材是存储 key，不是上游可访问的地址**（`segment.js` `segment.generate`）。探针：提交给 `videoProvider` 的 `imageRefs` 是 `["users/.../looks/lkv_..."]`，音频同理；`modelhub-video` 适配器原样写进 `image_file_N`/`audio_file_N`，上游取不到。期望：提交前把 `imageRefs`/`audioRefs`/`tailRef` 经 `storage.signedUrl(key, { ttlSeconds })` 转成 HTTP(S) 链接（TTL 至少覆盖轮询超时（120 分钟），建议 6 小时，配置化），`gen_tasks.request` 里**仍存 key**（链接会过期，重新提交/对账用 key 再签），测试里用断言 URL 形态的假 provider。<br>4. **轮询没有上限**（`gen.poll`）。上游永远 `running` 时一直每 5 秒重排，金额永远冻结。期望：配置 `projects.genPollTimeoutSeconds`（**默认 7200 即 120 分钟，用户 2026-10-20 指定**；M0 后按真实耗时调），超过后按 unknown 处理（冻结、项目 failed(TAKE_UNKNOWN)、不重提、写 error 日志）；补测试（可用小超时 + 假时钟或把 `created_at` 回拨）。<br>5. **临时文件泄漏**（`gen.poll`/`compose`）。`render.extractLastFrame(localPath)` 与 `render.compose({...})` 未传 `workDir`，产物落在各自的 `mkdtemp` 目录且从不删除；每个作品会在 Worker 磁盘上留下成片+封面（几十 MB），生产容器会被慢慢写满。期望：把 job 自己的 `workDir`（已有 `finally` 清理）传给这两个调用，测试断言 job 结束后临时目录下无残留。<br>**建议修改（不阻塞）**<br>6. `project.understand` 没有保存 LLM `usage`（引擎已返回），平台要核算成本；请写入 `projects.story.usage`（累计）。7. `understand` 调引擎时未传 `skillId`（只有 bind 按 SKU 选 Skill），目前默认 wan-3.0 恰好相同，换模型时会不一致，请与 bind 同样按 SKU 取。8. `cancelProject` 的 `purpose: cancel:${Date.now()}` 作为幂等键不稳定，改为固定 `cancel`（状态迁移守卫已保证只会成功一次）。9. 创建作品幂等键重放时不比对参数，同键不同内容静默返回旧作品；建议比对 `storyText`/`styleId` 等，不一致返回 409 `IDEMPOTENCY_CONFLICT`。10. `segment.js` 末尾的 `import { appendEvent as appendEventDb }` 挪到文件顶部。11. 多处 `.catch(() => {})` 吞掉 `transition` 失败（意图是竞争时忽略），请只吞 `PROJECT_STATE_INVALID`，其他错误仍抛出。 |
| 2026-10-20 | `agent/render/M1-RND-01-compose` @ `fa552aa`（M1-RND-01 复审） | ✅ 通过并合并 | 3 条必改已修：尾帧提取改 `-sseof -0.3 -update 1`，Lead 探针取到真正最后一帧（蓝色），0.1 秒短视频也能出帧；悬空符号链接已删（仓库无 `{{` 路径）；`inspect` 画幅 2% 误差、短边不低于档位 90%（1088x1920 通过，360x640 与 1:1 判不符）。建议项也做了：`blackRatio`/`frozenRatio` 可配置，README 写明调用方先保证文件存在。测试 208/208、check、build 通过（Linux amd64 + 发行版 FFmpeg 7.1；合并后 `main` 同样通过）。**下一步**：M1-BE-05（作品状态机），其依赖 ENG-01~04 与 RND-01 均已就绪。 |
| 2026-10-20 | `agent/render/M1-RND-01-compose` @ `b5a2fd4`（M1-RND-01） | 🔁 需修改（3 条必改，都很小） | 做得好的：`runBin` 用 argv 不走 shell、`close` 事件判定、输出限流与超时；`compose` 在滤镜图里统一缩放/补边/30fps、逐段 `loudnorm`、硬切、MP4(H.264+AAC)+faststart、元数据标识、封面；显式标识缺省走 PNG 叠加，仅注入中文字体才走 `drawtext`（识别并规避了缺字体画出方框的合规风险，这个判断很好）；`inspect` 全部用 FFmpeg 自带检测、零模型成本。Lead 在本机装了 FFmpeg 7.1（Debian）后复测：测试 206/206（含 9 个需要 FFmpeg 的用例，全通过）；探针——全黑 → `BLACK_VIDEO`+`FROZEN_VIDEO`，静音 → `SILENT_AUDIO`，无音轨 → `AUDIO_STREAM_MISSING`，截断损坏 → `UNDECODABLE`；三段不同分辨率（1088x1920、360x640、720x1280）与不同帧率输入拼接为 720x1280/30fps/AAC 48k 双声道，元数据 `comment=AI生成内容`，11 秒内完成，成片再过 `inspect` 通过。<br>**必须修改**<br>1. **`extractLastFrame` 取到的不是最后一帧**（`server/src/render/index.js` `createLastFrameExtractor`：`-ss duration-1 -frames:v 1` 取的是倒数第 1 秒处的那一帧）。探针：4 秒红、0.5 秒绿、0.5 秒蓝的视频，提取结果是**绿色**（t=4s），不是蓝色。这张图要给下一段当起始参考，并与 `endState`（最后一帧状态）对应，差一秒就可能是不同动作。期望：`-sseof -0.3 -i video -update 1 -q:v 3 out.jpg`（去掉 `-frames:v 1`，让 `-update 1` 持续覆盖到最后一帧；我复测得到蓝色）；补测试：用颜色分段的视频断言提取的是最后一段的颜色；很短（<0.3 秒）与无法探测时仍能产出一帧。<br>2. **提交了一个指向开发者本机路径的悬空符号链接 `{{pkgetc}}/cert.pem` → `/Users/.../{{etc}}/ca-certificates/cert.pem`**（`b5a2fd4` 中）。请用 `git rm` 删除，并检查是否有脚本把 `{{pkgetc}}` 当作路径创建了东西（疑似 ffmpeg-full 安装产物）。<br>3. **`inspect` 的分辨率检查过严，会让真实视频被误判失败**（`inspect.js`，`video.width !== expected.width || video.height !== expected.height`）。探针：9:16、`720p` 请求，上游返回 1088x1920（模型常见的 16 的倍数规格）→ `RESOLUTION_MISMATCH`。误判后果是退回整段、作品失败，用户白等。期望：① 画幅比例允许 2% 相对误差；② 分辨率只在**短边低于档位的 90%** 时判不符（高于档位不算问题）；③ 补测试：720x1280 通过、1088x1920 通过、360x640 判不符、比例错（1:1）判不符。<br>**建议修改（不阻塞）**<br>4. `inspect` 对「大部分静止」设为 90% 阈值，探针里 1 秒内容+4 秒定格（80% 静止）会通过；这是有意取舍，M0 看真实素材再调，请把阈值放进 `createRender` 参数（`frozenRatio`、`blackRatio`），方便调参。<br>5. `inspect` 对不存在的文件返回 `UNDECODABLE`，BE-05 应区分“本地文件丢失”（基础设施问题，应重试转存）与“视频损坏”（该段失败）；请在 README 写明调用方在调用前自己保证文件存在。 |
| 2026-10-19 | `agent/eng/M1-ENG-04-skills` @ `f344bfc`（M1-ENG-04 复审） | ✅ 通过并合并 | 必改已修：有尾帧时提示词 `图1`=尾帧、人物从 `图2`，无尾帧人物从 `图1`；新增跨模块测试用假上游捕获 `image_file_N` 与提示词 `图N` 逐一对应（有/无尾帧）。Lead 探针复测编号正确。建议 2 也已做：剧本/扩写模式下对白去空白标点后必须出现在剧本原文，否则进修复重试。测试 197/197、check、build 通过（合并后 `main` 同样通过）。**下一步**：M1-RND-01（含 `inspect`）可立刻开；M1-BE-05 依赖 ENG 已全部就绪，可开。 |
| 2026-10-19 | `agent/eng/M1-ENG-04-skills` @ `2cfd6d8`（M1-ENG-04） | 🔁 需修改（1 条必改） | 做得好的：Skill 注册表与 `defineSkill` 分层清楚；输出示例有契约测试；镜头校验（逐镜头时长、对白逐字一致且顺序不变、语速预算、英文字段）严格；代码拼装块顺序、`Lip sync.`/`No dialogue.`、固定避坑清单符合规格；设定集硬规则进修复重试、词数软限制截断并记日志的划分合理；`expandIdea` 校验与兜底合理；`classifyInput` 确定性、无回溯。测试 194/194、check 通过。**§5 的六处口径全部接受**（①`takeMode` 已写入 ARCHITECTURE §5；②画幅不进正文；③标点归一化；④`classifyInput` 细则；⑤bible 软硬校验划分；⑥`single_take` 豁免逐镜头上限——请在认领行/§5 把这条申请标为已裁决）。<br>**必须修改**<br>1. **提示词里的图片编号与实际提交顺序不一致**（`server/src/engine/skills/base.js` `assemble`）。探针：两个有形象图的人物、`prev_tail` 片段，提示词写 `图1 the girl`、`图2 the woman`、`图3 上一段的最后一帧`，而 `imageRefs` 是 `[a.png, b.png]`，提交时 `modelhub-video.js:80-83` 组成 `[tailRef, a.png, b.png]`（尾帧排最前，ENG-02 已合并）。结果：视频模型的 `图1` 是尾帧，提示词却说它是 the girl，人物与参考图整体错位。这是我的规格（`图K`）含糊造成的，已更正 `docs/skills/wan-3.0.md` §6：有尾帧时尾帧是 `图1`，人物依次 `图2…`；无尾帧时人物从 `图1` 开始。期望：① `assemble` 按此编号，音频编号不变；② 补**跨模块一致性测试**：用 `bindPrompts` 的结果（`imageRefs`、`usePrevTail`）调用 `modelhub-video` 适配器（假上游捕获请求体），断言 `image_file_N` 顺序与提示词 `图N` 描述的内容一一对应（有尾帧与无尾帧两种）。<br>**建议修改（不阻塞）**<br>2. 剧本模式下 `understand` 返回的片段对白没有与用户剧本原文比对（目前只靠提示词要求不新增对白）。建议加确定性检查：`inputKind: 'script'` 时，某句对白文字（去空白与标点后）不出现在 `storyText` 中就判校验失败进修复重试；`expanded: true` 的剧本同理。 |
| 2026-10-19 | `agent/eng/M1-ENG-01-story` @ `76f403e`（M1-ENG-01 第三轮） | ✅ 通过并合并 | 2 条必改已修：调用方信号 abort 后（默认原因、自定义原因、`bindPrompts`、调用前已 abort）都直接抛出，LLM 调用 ≤1 次；超过最大允许时长的片段向下取到剩余预算内的最大允许值（`[100]`→30，`[60,30]`→30,30，不再丢弃）；`story-smoke.js` 去掉仓库外导入，`pi-ai` 写死 0.87.1。测试 169/169、check、build 通过（合并后 `main` 同样通过）。下一步：M1-ENG-04（设定集/结束状态/Skill/扩写，规格 `docs/skills/wan-3.0.md` v2）。 |
| 2026-10-19 | `agent/eng/M1-ENG-01-story` @ `65e0b6e`（M1-ENG-01 复审） | 🔁 需修改（2 条必改，都在 `understand`/`normalizePlan` 里，改动很小） | 第 1~9 条里大部分已修好，Lead 探针复测：提示词现在写明了完整输出结构与示例，契约测试把示例跑过 `parseModelJson`+`validatePlan`+`normalizePlan`；角色匹配 `宝宝的妈妈` 在有「宝宝」「妈妈」时不再错绑，同名只绑一个；`[30,3,30]` 变成 `30,5,30`（65 秒、`compressed: true`）；无勾选数字人时保底有「主角」；挂起的 LLM 到时间后走兜底；音色不足时部分分配、其余留空（**接受**这个取舍，用户在确认点 B 补选，比整个作品卡死好）。测试 167/167、check 通过。未实现「设定集」「结束状态」等第 10~15 条属预期（见下）。<br>**必须修改**<br>1. **取消不生效**（`server/src/engine/story/index.js` 的 `isCallerCancelled`，靠错误信息里的魔法字符串「LLM 调用已取消」「用户停止」判断）。探针：调用方 `AbortController.abort()`（默认原因）或 `abort(new Error('项目已取消'))`，`understand` 与 `bindPrompts` 都**照常重试 3 次、最后返回 `degraded: true` 的兜底结果**，`llm.complete` 被调用 3 次；现有取消测试只因恰好用了「用户停止」才通过。后果：用户取消作品后 Worker 仍在烧 LLM 调用并继续往下走。期望：调用方信号已 abort（`signal?.aborted`）就直接抛出（`signal.reason`，没有则 `AbortError`），不管原因文字是什么；循环每次尝试前先检查；删除字符串判断；补测试：默认原因取消、自定义原因取消、`bindPrompts` 取消、调用前已 abort，都必须抛出且 LLM 调用次数 ≤ 1。<br>2. **模型给出超过最大允许时长的片段会被整段丢弃**（`plan.js` `normalizePlan`，条件 `requested > Math.max(...budget)` 同时覆盖了「预算不够」与「模型给了不在允许范围的大数」）。探针：允许 `[5,10,15,30]`，模型规划 `[100]` → 抛出「片段规划没有可用时长」（靠重试兜住）；规划 `[60,30]` → 第一段（60）被当成溢出丢弃，剧情被拼接到最后一段末尾的「压缩叙事」里，第二段变成开场。期望：请求时长大于允许的最大值时，向下取到「不超过剩余预算的最大允许值」保留该段；只有剩余预算小于最小允许值时才算溢出。补测试：`[100]`、`[60,30]`、`[30,30,30,5]`（第 4 段预算耗尽被合并并 `compressed`）。<br>**建议修改**<br>3. `server/scripts/story-smoke.js`：硬编码导入 `/root/chaodayun/backend/agent/llm.js`（仓库外路径），并且直接导入不是 `server` 直接依赖的 `@earendil-works/pi-ai`，末尾还有遗留的 `void readFile;`。请只保留自带的 OpenAI 兼容路径，`pi-ai` 若确需使用就在 `package.json` 里写死版本，删除多余行。<br>**关于第 10~15 条（设定集、结束状态、按视频模型的 Skill、`expandIdea`、`classifyInput`、60 字阈值）**：这些是我在你完成原审查之后追加的需求，**不在本轮必改范围**。本轮修完上面 2 条后合并，随后以新任务 **M1-ENG-04**（同一分支命名规则，`agent/eng/M1-ENG-04-skills`）单独开做，规格在 `docs/skills/wan-3.0.md`（v2）与 `docs/ARCHITECTURE.md` §5，改动会替换 `plan.js` 里的 `sceneId` 与 `bindPrompts` 现有拼装，请到时再读最新文档。
| 2026-10-19 | `agent/eng/M1-ENG-01-story` @ `9f07342`（M1-ENG-01） | 🔁 需修改（5 条必改，其中第 1 条会让整个功能在真实大模型下失效） | 做得好的：解析逻辑单遍线性、无回溯（围栏、前后文字、尾逗号、深度匹配、200KB 上限）；故事文本放在带标记的不可信数据区并在系统提示里声明不执行其中指令；时长预算、压缩提示 `notice`、`prev_tail` 只允许同场景连续片段、默认声音优先且同作品音色不重复、音色不足明确报错；有限修复重试（2 次）+ 确定性兜底（`degraded: true`）+ `usage` 汇总；9 份样本夹具来源说明诚实。测试 161/161、check、build 通过，与最新 `main` 无冲突；依赖：`@earendil-works/pi-agent-core` 写死 `0.87.1`，传递依赖 93 个包（含各家模型厂商 SDK，许可证均为宽松协议，2 个有安装脚本 `@google/genai`、`protobufjs`），不阻塞，M2-OPS 生产镜像请用 `npm ci --omit=dev`。Lead 探针复现 5 个必改问题：<br>**必须修改**<br>1. **提示词里没有告诉大模型要输出什么结构**（`server/src/engine/story/prompts.js:1-25`）。探针：系统提示与用户消息里没有出现 `cast`、`segments`、`durationSeconds`、`plot`、`transition`、`castIndexes`、`castIndex`、`dialogue`、`cameraNotes`、`ambience` 等任何字段名；`BIND_SYSTEM` 也没有说明要返回 `{"prompt": "..."}`（只有校验失败后的重试消息里才说）。真实大模型不知道字段名，会每次都校验失败，3 次后走保底方案，`degraded` 永远为 `true`。当前测试全部使用预设答案的模拟大模型，所以没有发现。期望：① 在 `STORY_SYSTEM` 与 `BIND_SYSTEM` 里写明完整输出结构，包含字段说明和一个完整示例 JSON（字段含义、取值范围：`gender` 取值、`ageGroup` 取值、`transition` 取值、`castIndexes` 是 `cast` 数组下标、`dialogue[].castIndex`、时长只能取 `allowedDurations`）；② 补一个**契约测试**：把提示词里的示例 JSON 取出来，必须能通过 `parseModelJson` + `validatePlan` + `normalizePlan`，这样提示词与校验代码一旦不同步，测试就会失败；③ 提供一个默认不运行的真实调用冒烟脚本（`server/scripts/story-smoke.js`，读取环境变量里的模型配置，打印 `degraded`、重试次数和 token 用量），**不要在审查和测试里运行**，留给 M0 经你授权后使用。<br>2. **名字匹配会张冠李戴、同一数字人可被重复绑定**（`server/src/engine/story/plan.js:114-118`）。探针：大模型返回角色「宝宝的妈妈」，资产库有「宝宝」「妈妈」→ 被匹配到「宝宝」（按数组顺序第一个包含者）。期望：① 精确同名优先；② 子串匹配只在**唯一**候选时才采用，多个候选一律视为不匹配（宁可新建也不要错绑）；③ 一个 `characterId` 只能绑定给一个 `cast` 成员（先到先得，后面的视为新角色）；补测试：上述 3 种情形。<br>3. **片段时长短于最小允许值时，后面的片段全部被丢弃**（`plan.js:160-163`，`break`）。探针：允许 `[5,10,15,30]`，大模型规划 30 / 3 / 30 秒，预算 90 秒 → 结果只剩一段 30 秒，第二、三段的剧情被塞进第一段的文字里，`compressed: true`，而剩余预算还有 60 秒。期望：片段时长小于最小允许值时**向上取整到最小允许值**（预算够就保留这一段）；只有剩余预算小于最小允许值时才停止；片段不能被静默丢弃，丢弃或合并必须设置 `compressed`。补测试：短片段、中间短片段、预算不足三种情形，断言总时长与段数。<br>4. **保底方案在用户没有勾选数字人时，`cast` 为空**（`plan.js:194-214`）。探针：大模型连续 3 次输出不合法且 `characters: []` → `cast: []`，`castIndexes: [[]]`。BE-05 拿到空 `cast` 无法进入角色确认。期望：保底方案至少包含一个默认角色「主角」（`gender: 'unknown'`，`ageGroup: 'young'`，描述为「故事中的主角」），所有片段引用它；补测试。<br>5. **调用大模型没有超时与取消**（`server/src/engine/story/index.js:41`、`:78`）。探针：`llm.complete` 永不返回时 `understand` 永不结束，`llm.complete` 收到的请求里没有 `signal`。后果：Worker 的并发位被永久占用，租约过期后任务还会被重复领取。期望：`understand` 与 `bindPrompts` 接受 `{ signal, timeoutMs }`（默认每次调用 90 秒），内部用 `AbortSignal.any` 合并外部取消与超时后传给 `llm.complete`；超时按失败处理（走修复重试 / 兜底），外部取消直接抛出；补测试：挂起的 LLM 在超时后触发兜底，不再无限等待。<br>**建议修改**<br>6. 修复重试时没有把大模型上一版输出带回去（`index.js:48`、`:88`，只追加了一条「校验失败」的用户消息），大模型看不到自己错在哪里。请把上一版输出（截断到 2000 字）作为一条 `assistant` 消息放进 `messages`；同时 `llm/pi.js:12` 把历史消息一律转成 `user` 角色，请按 `role` 原样映射。<br>7. `bindPrompts` 的对白归属：`understand` 返回的对白用的是 `castIndex`，而 `bindPrompts` 按 `castId` 查名字，探针结果是「角色：「你好」」，丢失了说话人。请同时支持两种写法（`castId` 缺省时用 `cast[castIndex]`），并在 `engine/README.md` 写清 `understand` 输出与 `bindPrompts` 输入的字段对应（`lookImageKey`、`refAudioKey`、`castIds` 等），BE-05 将直接依赖这份说明。<br>8. `bindPrompts` 在 `usePrevTail` 为 `true` 时没有给尾帧预留一个参考图位置：`maxImageRefs=2` 时返回 2 张图再加尾帧共 3 张，超过视频模型上限会在渲染阶段被判输入不合法。请在 `usePrevTail` 时把可用图片数减 1。<br>9. `plan.js:176-179` 被压缩掉的片段剧情会无限拼接到最后一段的 `plot` 里，请限制总长度（如 1000 字），超出部分截断并在日志里记录。<br>**【2026-10-19 更新】追加需求第 10~14 条以 `docs/skills/wan-3.0.md` v2 为准（已按阿里云官方指南重写：镜头 3~8 秒（对白镜头 10 秒，官方 2~5 秒作对照）、尽量每段 30 秒、`第N个镜头[a-b秒]`、`图N`/`音频M`、`无台词`/`口型同步`、关键帧参考、`bible.mood`、`takeMode`），并新增第 15 条：15. 编剧扩写——新增 `server/src/engine/story/expand.js`：`classifyInput(text)`（确定性、阈值可配置，默认**约 60 字**且无对白与场景描述为想法）与 `expandIdea({ idea, style, maxSeconds, allowedDurations, characters, skillId, signal, timeoutMs }) → { title, script, usage, degraded }`（提示词与输出格式见文档第 3 节，示例 JSON 同样要有契约测试；输出校验：对白字数预算、目标时长不超过 `maxSeconds`、勾选的数字人必须出场、不含镜头运镜；失败重试 2 次后确定性兜底——直接把用户想法原文作为剧本，`degraded: true`）；`understand` 的入参增加 `inputKind`、`expanded`，返回里带 `script`；剧本模式**不新增对白**。**追加需求（用户 2026-10-19 已确认，取代上一句「不在本次审查范围」）**：请按 [`docs/skills/wan-3.0.md`](./docs/skills/wan-3.0.md) 和 `docs/ARCHITECTURE.md` §5 的新契约实现：10. 输出增加 `bible`、`sceneId`、`propIds`、`endState`，提示词里写明字段与示例（第 1 条的契约测试同样覆盖）；11. 新增 `server/src/engine/skills/`（`index.js`、`wan-3.0.js`、`generic.js`），把 `STORY_SYSTEM` 里与模型相关的部分挪进 Skill 的 `planningGuide`，`BIND_SYSTEM` 换成文档第 4 节的 `shotSystem`，最终提示词由 Skill 的 `assemble` 拼装（风格、场景、道具、人物外观、连贯性、写实与避坑模板逐字注入，对白按第 6 节逐字校验，镜头时间线校验与兜底）；12. `bindPrompts` 返回里带 `startState`、`endState`、`shots`、`skillId`、`skillVersion`、`degraded`；13. 文档第 8 节「未验证的假设」全部做成 Skill 里的可配置项（`refPhrase`、时间码写法、`dialogueCharsPerSecond`、`maxChars`），不要写死；14. 测试：假设与单测中的示例必须来自文档第 4.3 与第 5 节（示例 JSON 能通过校验、拼装结果与成品示例逐字一致）。这部分较大，**请单独成提交**，与第 1~9 条的修复分开。 |
| 2026-10-17 | `agent/eng/M1-ENG-02-providers` @ `483a01a`（M1-ENG-02 第三轮） | ✅ 通过并合并 | 全部修复，测试 148/148、check、build 通过（合并后 `main` 同样通过）。Lead 复测：读取参考照片失败抛出 `PROVIDER_REFERENCE_UNAVAILABLE`（可重试、未提交），此时上游零调用，存储恢复后重试一次生成成功；参考图内容不是 Buffer 时判失败并记 `image_provider_local_invalid` 错误日志；分辨率 `2k`（本项目占位 SKU 名）被拒并记错误日志；视频失败结果的 `error` 是固定中文提示、上游原文在 `providerMessage`；满载全部 CPU 核心时完整套件连续 2 次通过，共用传输层超时 2500ms、专测超时的用例才用 60ms。<br>**M1-ENG-01（故事理解与片段规划）开工要点**——新分支 `agent/eng/M1-ENG-01-story`；接口以 `docs/ARCHITECTURE.md` §5 为准（`bindPrompts` 的输出已按用户决定改为 `usePrevTail`），产品行为以 `docs/PRD.md` §4.2、§4.7 为准：<br>a. **参考源码**（在你那台设备上）：`/root/chaodayun/backend/agent/{index,llm,prompts,tools}.js`、`agent/skills/{wan-video,storyboard}.js`、`backend/screenwriter/{prompts,tools,index}.js`；pi agent 依赖 `@earendil-works/pi-agent-core` 在超搭云的锁文件里解析到的是 `0.87.1`，本项目**写死这个精确版本**。去掉对超搭云仓库、计费、会话的依赖，LLM 调用全部通过注入。<br>b. **形态**：`createStoryAgent({ llm, logger })` → `{ understand, bindPrompts }`。`llm` 是注入的最小接口（建议 `complete({ system, messages, jsonSchema?, signal }) → { text, usage: { inputTokens, outputTokens } }`），测试用脚本化的模拟 LLM（按调用顺序返回预设文本，可返回不合法输出）。每次调用返回 `usage` 汇总，供平台内部核算成本（LLM 价格恒为 0，用户不付费）。<br>c. **`understand` 必须满足（逐条写测试）**：① 每段 `durationSeconds` 只取 `allowedDurations` 中的值；② 总时长 ≤ `maxSeconds`；超出时压缩剧情，`compressed: true`，`notice` 为「故事较长，已为您精简为 N 秒」；③ 优先用接近模型上限的长片段（目标 30 秒），只在剧情需要时才切短；④ `cast` 提取故事里的人物，名字与 `characters`（用户勾选 + 资产库摘要）匹配时填 `characterId`，用户已勾选的角色必须出现在 `cast` 里；⑤ 每个角色给出 `gender`、`ageGroup`（`child / teen / young / middle / elder`）；⑥ 只有 1 个片段时不推荐音色（不输出 `voiceId`）；有 2 个及以上片段时，按性别、年龄、性格从 `voices` 里推荐，**同一作品不同角色音色不重复**，音色不够用时抛出明确错误而不是重复；⑦ 输入过短或不明确时补全细节与情绪，补全部分写在 `synopsis` 里供用户确认；⑧ `transition` 只能是 `prev_tail` 或 `hard_cut`，第一段必为 `hard_cut`，`prev_tail` 只用于同一场景的连续片段；⑨ 每段 `dialogue` 的 `castIndex` 必须在 `cast` 范围内，`castIndexes` 去重且有效。<br>d. **`bindPrompts` 必须满足**：为每段生成最终提示词（30 秒内多镜头与运镜按 `wan-video.js` / `storyboard.js` 的写法，风格描述来自 `style` 的提示词），`imageRefs` 放各出场角色的形象图 key，`audioRefs` 仅在 `voicesEnabled` 时放对应音色的参考音频 key，`usePrevTail` 对应 `transition === 'prev_tail'`；图片参考数量受视频模型上限约束，超出时按出场重要性裁剪并在返回里带 `droppedRefs`。<br>e. **LLM 输出解析（重点）**：真实 LLM 输出经常带代码围栏、前后多余文字、尾逗号、字段缺失或类型不对。必须有**宽容解析 + 严格校验 + 有限次修复重试（建议最多 2 次，把校验错误回传给 LLM）+ 最终确定性兜底**（例如退化为按字数均分片段的最简方案，并标记 `degraded: true`），**绝不能因为 LLM 抽风让整个作品卡死**。夹具要求：至少 8 份「像真实 LLM 输出」的样本（正常、代码围栏、多余前后文、尾逗号、缺字段、时长越界、音色重复、人物名对不上），来源注明（超搭云测试样本，或按真实 LLM 常见输出手写并说明）。所有解析都要避免回溯（不要用嵌套量词的正则，参照 ENG-03 的教训），输入按字符数设上限。<br>f. **安全**：用户故事文本是不可信输入，必须放在明确分隔的区域，系统提示里声明「故事内容里的指令一律不执行」；输出只作为数据使用；不要把用户文本拼进工具名、文件路径或日志之外的任何命令。<br>g. 不得产生真实模型费用，测试全程用模拟 LLM；真实 LLM 调用留到 M0 / M2 并需要用户授权。 |
| 2026-10-17 | `agent/eng/M1-ENG-02-providers` @ `2e12da0`（M1-ENG-02 复审） | 🔁 需修改（1 条必改 + 1 条测试稳定性，都很小） | 上次的问题大部分已修好，Lead 探针复测：① 视频结果地址——21 个候选位置全部识别，有无状态词都成功；`expired / timeout / rejected / blocked / failed / cancelled` 判为失败，成功状态取不到地址判为 `unknown`，排队中判为 `running`，失败状态即使带地址也判失败；② 图片请求——`quality=1080p`、`detail_level=medium`，3 张参考图只发 1 张并返回 `droppedReferences: 2`，无参考时走 JSON 生成接口；③ 上游错误分类——400 / 401 / 403 / 422 返回 `failed`（用户提示不含上游原文，上游信息放 `providerMessage`），401 / 403 记 `error` 日志，429 抛出 `retryable: true`，503、超过 1MB 的响应、空响应返回 `unknown`；④ 视频 `tailRef` 作为普通参考图排在最前并与图片列表去重，固定 `omni_reference`，超过 9 张图报输入不合法；⑤ `look.generate` 处理器只有 `retryable === true` 才重试，其他置 `unknown` 并保持冻结；渠道相关内容按渠道分文件（`modelhub-video.js` / `modelhub-image.js`），注册表按 id 取用，换渠道只需新增适配器。测试 146 个。<br>**必须修改**<br>1. `server/src/engine/providers/modelhub-image.js:59-65` 读取参考照片（`loadReference`）失败被归为「结果未知」。这一步发生在**请求上游之前**，一定没有提交，却会让金额被冻结、需要人工处理。探针：`loadReference` 抛出 `storage 503`，`generate` 返回 `{ status: 'unknown' }`。期望：适配器在 `submit` 里捕获 `loadReference` 的异常，包装成 `ProviderError`（`code: 'PROVIDER_REFERENCE_UNAVAILABLE'`、`submitted: false`、`retryable: true`），由 `generate` 抛出让队列重试；参考图拿到但内容不是图片 Buffer 时仍按 `PROVIDER_INPUT_INVALID`（失败并退回）。补测试：存储读取失败时抛出可重试错误、第二次成功后正常生成、全程只调用一次上游。<br>2. 测试稳定性：`server/test/engine/providers.test.js:50` 共用传输层的超时只有 **70 毫秒**，机器忙时（我在刚装完依赖后第一次运行）`图片请求字段按模型能力校验` 失败，之后连续 4 次完整运行都通过，说明是偶发超时。期望：共用传输层改为 2000ms 以上，只有专门测试超时的用例使用短超时的独立传输层；其他测试里的固定短超时（如第 258 行的 100ms）同样检查一遍。<br>**建议修改**<br>3. `server/src/engine/providers/modelhub-video.js:49-50` 视频失败结果的 `error` 直接带上游原文，和图片不一致。请改成固定的中文提示，上游原文放 `providerMessage`（供日志），避免以后展示给用户。<br>4. `server/src/engine/providers/image.js:23-29` `PROVIDER_CONFIG_INVALID`、`PROVIDER_INPUT_INVALID` 这类「我们自己配置或参数有问题」的失败被当成「渠道拒绝」且只记了 401 / 403 的日志；请对这类失败也记一条 `error` 日志，运维才能发现是配置问题而不是用户内容被拒。<br>**留给集成阶段的提醒**：真实图片适配器的 `sku`（分辨率）在 `createImageProvider` 创建时就固定了，而作品报价里的 SKU 是每次不同的；M2-BE-01 接入真实渠道时，需要按 `gen_tasks.sku_code` 取对应分辨率，不要写死。当前 Worker 主入口仍用开发图片模型（生产环境缺省会直接报错），这是预期的。 |
| 2026-10-17 | `agent/eng/M1-ENG-02-providers` @ `7d41440`（M1-ENG-02） | 🔁 需修改（修完 1~4 即可合并） | 做得好的：注册表校验与去重；视频字段名（`image_file_N` / `audio_file_N` / `functionMode` / `resolution` / `ratio` / `duration`）、接口路径、Wan 3.0 与 Seedance 2.5 的时长与参考数量上限与超搭云已验证配置一致；传输层「只有连接被拒才算明确未提交、其余不确定」的分类思路正确；`redirect: 'manual'`、路径不得越出 origin；HTTP 假服务覆盖受理后断开与超时；夹具来源说明很诚实（写明是按超搭云假上游构造、未经真实验证）。测试 141/141、check 通过，与最新 `main` 无冲突。Lead 对照超搭云生产代码并用探针复现 4 个问题：<br>**必须修改**<br>1. `server/src/engine/providers/video.js:27-38` `normalizeVideo` 只认 4 种结果地址，且成功状态拿不到地址时返回 `running`。探针：超搭云 `backend/providers.js:154-157` 的 `getVideoUrl` 认可 20+ 种位置（`data.url`、`video`、`result_url`、`data.output.video`、`output.outputs[0]`、`output.urls.get`、`outputs[0]`、`content.video_url`、`data.data.content.video_url`、`data.results[]`（type=video）等），本实现中 8 种常见形状只识别 2 种，其余全部返回 `running`——真实任务一旦换了形状就会**无限轮询、金额永远冻结**。另外 `expired`、`timeout`、`rejected`、`blocked` 等状态也全是 `running`。期望：① 完整移植 `getVideoUrl` 的候选位置与 URL 校验（只接受 http(s)、无用户名密码）；② 按超搭云 `backend/task-routes.js:67-68` 的规则判定：状态词在 `failed / error / rejected / expired / cancelled / canceled` 之内 → `failed`；**能取到合法视频地址 → `succeeded`（不论状态词）**；③ 状态词是 `succeeded / completed / success` 但取不到地址 → 返回 `{ status: 'unknown' }`（不是 `running`），由对账处理；④ 为每种候选位置各做一个夹具与测试，夹具来源注明「按 getVideoUrl 候选位置构造」。<br>2. `server/src/engine/providers/image.js:98-110` 图片请求与已验证规格不符。探针：请求字段是 `model, prompt, ratio, quality=2k`，且带了 3 个 `images` 文件。超搭云（`modelhub-models.js` 的 `gpt-image-2`、`dimensio-image-generation.js:22-33` 的 `requestFields`）：`quality` 取值是分辨率档 `1080p / 1440p / 2160p`（默认 `1080p`），`2k` 是本项目占位 SKU 的名字、上游并不认；该模型有多档细节，请求必须带 `detail_level`（`low / medium / high`，默认 `medium`）；**参考图最多 1 张**（`maxImages: 1`），本实现发了多张。期望：图片适配器内置模型能力表（比例、分辨率、细节档、参考图上限，数据取自超搭云 `modelhub-models.js`），`quality` 与 `detail_level` 按表校验，不在表内的 SKU 分辨率报 `PROVIDER_INPUT_INVALID`（不要静默改值）；参考图超过上限时取排序靠前的一张（BE-04 已按 `sort` 传入），并在返回结果里带上 `droppedReferences` 计数、日志里记一条；补测试：请求字段与超搭云假上游一致。**这是产品层面的限制（用户上传 1~5 张照片，当前图片模型只能用 1 张），已登记到 §4 待确认第 7 条，M0 验证时对比其他图片模型。**<br>3. `server/src/engine/providers/image.js:154-170` `createImageProvider.generate` 把「明确被拒绝」当成可重试异常抛出，BE-04 的处理器会对它重试 5 次、最后任务失败、金额永久冻结。探针：上游返回 400 / 401 → `generate` 抛出 `PROVIDER_REJECTED`；返回 429 → 返回 `unknown`（其实上游并没有受理）。期望按下表分类，并给 `ProviderError` 增加 `retryable` 字段：连接被拒、DNS 失败、429（带 `Retry-After` 则记录）→ **抛出**且 `retryable: true`、`submitted: false`；400 / 401 / 403 / 422 等明确拒绝与输入不合法 → **返回** `{ status: 'failed', error }`（`error` 是不含上游原文的中文提示，上游原始信息放 `providerMessage` 供日志与运维，401 / 403 同时记 `error` 日志）；超时、5xx、受理后断开、响应无法解析 → **返回** `{ status: 'unknown' }`。**配套改动（跨所有权，已批准，同一分支单独提交）**：`server/src/characters/service.js` 的 `look.generate` 处理器，provider 抛异常时只有 `err.retryable === true` 才回退 `created` 并重试，其他异常一律置 `unknown`、保持冻结、记 `error` 日志，并补测试。<br>4. `server/src/engine/providers/image.js:163-169` 图片已经生成成功，但下载结果失败时直接返回 `unknown`（金额冻结、需人工处理）。结果地址已知，重试下载不会重复计费。期望：`downloadImage` 失败时在 `generate` 内最多重试 3 次（指数退避，总共不超过 10 秒），仍失败才返回 `unknown`；补测试。<br>**建议修改**<br>5. （**已按用户决定更正**）`server/src/engine/providers/video.js:60-67`：用户确认使用「全能参考（`omni_reference`）」模式，「首尾帧模式与音频冲突」暂时忽略，所以**不要**再对 `firstFrame` 报错，也不要实现首尾帧模式。请把参数改名为 `tailRef`（上一段尾帧的图片地址，可选），行为是：作为**普通参考图**放在 `imageRefs` 最前面（计入图片参考上限），在代码注释和 `engine/README.md` 里写明「尽力而为，不保证首帧衔接」；`functionMode` 固定为 `omni_reference`，删除 `first_last_frames` 分支及其测试。适配器不要写死 Modelhub：渠道相关的内容（路径、字段名、能力表）全部收在各渠道自己的适配器文件里，注册表按适配器 id 取用，方便上线时换渠道。<br>6. `server/src/engine/providers/transport.js:68-70` 明确拒绝时丢弃了上游返回的错误信息。请把上游 `error.message` / `error.code`（截断到 200 字符）放进 `ProviderError.providerMessage` / `providerCode`，不展示给用户，只供日志与运维排查。<br>7. `server/src/engine/providers/transport.js:74` `response.json()` 没有大小限制，建议读取前限制响应体（如 1MB）。 |
| 2026-10-17 | `agent/eng/M1-ENG-03-infra` @ `ebf8e16`（M1-ENG-03 第四轮） | ✅ 通过并合并 | 三轮审查意见全部修复，测试 134/134、check、build 通过（合并后 `main` 同样通过）。Lead 复测：两份真实 docx 夹具提取与预期一致；带 `<w:pPr>`、`<w:pict>`、修订（`delText` 被忽略、`ins` 保留）、表格、文本框（`mc:Choice` 与 `mc:Fallback` 重复内容只取一份）的结构全部正确；恶意输入——4MB 空白的 `<w:br`、40 万个未闭合 `<w:p>` / `<w:t>`、百万个 `<`、20 万个 `AlternateContent`、60 万个无分号实体——均在毫秒级返回错误或结果；1.3 / 2.7 / 4.0MB 的真实结构文档耗时 105 / 133 / 207ms，线性增长。<br>**后续要点**：<br>• `M2` 七牛真实桶联调清单已登记到 `docs/TASKS.md`（需要你授权），含「中文 / 空格 key 能否下载」「`attname` 是否生效」「分片上传」「删除」。<br>• 不是阻塞：`extract` 只取 `word/document.xml` 正文，页眉页脚、脚注不提取（合乎预期）；段落之间的空行会被合并为单个换行。<br>**M1-ENG-02 开工提醒**（要点仍见上一条 §6 的 d 项）：新分支 `agent/eng/M1-ENG-02-providers`；**解析上游响应必须带真实或按官方文档构造的样本夹具**；模拟上游做成本地 HTTP 假服务（成功、业务失败、超时、连接被拒、受理后断开应返回 `unknown`）；provider 对「是否已提交」的分类规则见 M1-BE-04 复审记录的「留给后续的一条」；`createImageProvider` 要实现 BE-04 已在用的 `generate()` 接口。 |
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

### 2026-10-21 · BE-Core · M1-BE-06 复审修复（re-take 退款、剧情重绑定、SSE 两处、结算价）

- **背景**：§6 复审 4 条必改 + 3 条建议全部处理；已合并 origin/main（`6308742`），分支不变 `agent/be/M1-BE-06-project-api`。
- **受影响文件**：`server/src/projects/segment.js`、`server/src/projects/bind.js`、`server/src/projects/handlers.js`、`server/src/api/projects.js`、`server/src/config.js`、`server/.env.example`、`server/test/projects/project-api.test.js`。
- **必改 1（re-take 失败退款）**：`failSegment` 的 `keepDelivered` 分支在同事务调用 `refundRetake`（金额取下单时 `amountFen`，幂等键按 takeId 区分，重复执行只退一次）；「明确失败」判定前置——`segment.generate` 的提交结果分支把 `failed` 判定移到 `unknown/!upstreamId` 之前（上游明确拒绝提交本就没有 upstreamId，原顺序会把它误记成 unknown 冻结不退）；「结果未知/轮询超时」仍保持冻结待对账（与首次生成同口径）。测试：re-take 失败 → 可用额恢复、冻结归零、旧 take 仍选中、项目仍 delivered、重复执行只退一次。
- **必改 2（改剧情重绑定）**：`bind_prompts` 写 `final_prompt` 时记录绑定时的剧情快照 `plot`；redelivery 的 `segment.generate`（新增注入 `storyAgent`）提交前比对 `segments.plot` 与快照，改过才用 `bindPrompts` 只为这一段重新生成镜头时间线与最终提示词（输入数组首部放上一段占位使 `startState` 取其 `endState`，bible 取 `story.raw.bible`，形象/音色沿用已锁定的，对白以 `segments.dialogue` 为准），写回 `final_prompt` 与 `gen_tasks.request`；绑定意外失败沿用旧提示词不阻塞；顺带修复 redelivery 提交缺尾帧参考的问题（createSegmentTake/重绑定均只存形象 key，提交前按当前上一段选中 take 的尾帧补在最前）。测试：改 plot → 提交上游的提示词含新时间线内容、没改 plot 不调 LLM。
- **必改 3（SSE）**：(a) 无 `Last-Event-ID` 的新连接 `lastId` 初始化为该作品当前最大事件 id（快照代表当前，不重放历史）；(b) 超过最长存活期直接 `res.end()`（清理定时器与连接计数），客户端按 EventSource 默认行为带 `Last-Event-ID` 重连。存活期与每用户并发上限可配置（`PROJECTS_SSE_MAX_AGE_MS` 默认 30 分钟、`PROJECTS_SSE_MAX_CONNECTIONS` 默认 5，建议 6）。测试：新连接只收 1 条快照；极短存活期下服务端主动结束连接；超限 429。
- **必改 4（结算价）**：`gen.poll` 结算与 `failSegment` 退款一律使用 `gen_tasks.request.amountFen`（下单时写入），不再结算时重新查价；`amountFen` 缺失按 PermanentJobError 暴露（内部不变量）。测试：生成中途把 SKU 调到 50 分/秒，结算仍按下单时 600 分、无冻结残留。
- **建议 5~7**：删除测试内 DEBUG `console.log`；SSE 每用户并发连接上限（默认 5）；`PUT /cast/:castId` 的 `lookVersionId`/`voiceId` 显式 `null` 按 hasOwnProperty 传透（可清除选择，测试覆盖 null → missing → 重选 ready）。
- **测试**：`npm run test:server` 242/242（新增 4 例）；`npm run check`、`npm run build` 通过；`/tmp` 无 `miv-frame-`/`miv-take-`/`miv-compose-` 残留；未调真实模型。
- **未完成 / 风险**：与上条相同（types.ts 的 StoryResult 字段待 Web 补齐；SSE 单进程内存态，M2 评估 LISTEN/NOTIFY）。

### 2026-10-21 · BE-Core · M1-BE-06 作品 API + SSE + 交付后替换 + 下载（待审查）

- **背景**：M1-BE-05 合并（`3c69ae7`）后实现 docs/API.md §6 全部路由。分支 `agent/be/M1-BE-06-project-api`（基于 main `3c69ae7`）。
- **受影响文件**：`server/src/api/projects.js`（新增，全部路由）、`server/src/app.js`（挂载）、`server/src/projects/service.js`（listProjects/deleteProject/updateSegmentPlot/createSegmentTake/selectSegmentTake/projectDownload）、`server/src/projects/segment.js`（delivered re-take：redelivery 放行、选中覆盖、失败退回该笔预占）、`server/src/projects/compose.js`（delivered 重拼接：状态保持、新 render 行、失败不置 failed）、`server/src/projects/money.js`（reserveProjectVideo 增加 purpose，re-take 用独立键；新增 refundRetake）、`server/test/projects/{helpers/projects-http.js,project-api.test.js}`（新增）。
- **路由与语义**（全部 requireAuth；写操作走既有 csrfGuard 同源+CSRF；他人资源一律 404）：GET /projects（group 过滤+游标翻页）、POST /projects（201/幂等重放 200）、GET /projects/:id、GET /projects/:id/events（SSE）、DELETE（进行中先 cancel→软删除→立即删除视频文件并清 key）、story/reanalyze、cast/:castId/character、confirm-story、PUT cast/:castId、cast/:castId/looks、confirm-cast、pause/resume/retry/cancel、PATCH segments/:segmentId（delivered 改剧情）、POST segments/:segmentId/takes（delivered re-take，segment_take 报价，独立预占键）、PUT segments/:segmentId/selection（切换选中→新 render 重拼接）、GET download（302 到带 attname 的签名链接）。
- **SSE**：会话鉴权；他人 404；先发当前快照，再按 `Last-Event-ID` 从 project_events 增量补发（每秒轮询+15 秒心跳+30 分钟服务端断开由客户端重连）；事件格式 `id/event: project/data: {projectId,status,progress,changed}` 与 API.md ProjectEvent 一致。
- **交付后替换**（新增候选+切换选中，永不覆盖）：POST takes 建新 take（segment_take 报价、预占键 `video:retake:<takeId>:reserve`）→ gen.poll 成功后**直接切换选中**（旧 take 保留）并入队重拼接；selection 免费切换→重拼接；两者都走**新的 render 记录**（delivered 状态保持、delivered_at 不变、expires_at 续期由现有逻辑 COALESCE 处理）；re-take 失败立即退回该笔预占（delivered 无 retry/cancel 入口，不适用 A 口径的保持冻结）。
- **契约测试**：project-api.test.js 从 `apps/web/src/api/types.ts` 抽取 interface 声明（逐行解析，支持单行/多行/extends），对 ProjectDetail/CastMember/Segment/Pricing/ProjectSummary 运行时校验「声明的字段存在且 JSON 类型/枚举取值一致」；5 例 HTTP 测试覆盖：CSRF/同源 403、未登录 401、他人 404、幂等重放、交付后 PATCH/re-take/selection/下载 attname、SSE 鉴权与 Last-Event-ID 补发、删除清 key、expired 410。
- **测试**：`npm run test:server` 238/238（新增 5 例）；`npm run check` 通过；未调真实模型。
- **未完成 / 风险**：① §5 已登记 types.ts 的 StoryResult 缺 inputKind/expanded/script（后端按 API.md 全量返回，契约测试按「声明字段必须一致、多余字段允许」），请 Web 补齐；② SSE 是单进程内存态实现（每连接每秒查库），M2 若多实例部署建议改 LISTEN/NOTIFY 或 Redis pub/sub（已按「M1~M2 不引入 Redis」约定暂缓）；③ download 的 302 目标是七牛签名链接（含 attname），文件名取作品标题清洗后 + `.mp4`。

### 2026-10-21 · BE-Core · M1-BE-05 复审修复补充（尾帧 workDir、casting unknown 守卫）
### 2026-10-21 · BE-Core · M1-BE-05 复审修复补充（尾帧 workDir、casting unknown 守卫）

- **背景**：按 §6 M1-BE-05 复审修复 2 条必改。已合并 `origin/main`（16fcff5），推同一分支。
- **改动**：
  - **必改 1**：`gen.poll` 的 `render.extractLastFrame(localPath)` 补传 job 的 `workDir`（与 take.mp4 同目录、随 finally 清理）；「无残留」测试把 `miv-frame-` 前缀纳入统计（`miv-take-`/`miv-compose-`/`miv-frame-` 三类，job 结束后为 0）。
  - **必改 2**：casting 的 unknown 守卫从查 `look_versions.status`（CHECK 约束里不存在 unknown，原守卫是死代码）改为 **`gen_tasks.status = 'unknown'`**，经 `look_versions.gen_task_id` JOIN `project_cast.look_version_id` 限定本作品；命中即 409，文案「该形象结果待核对，请联系客服」。
  - **测试**：新增「形象 unknown → failed(LOOK_UNKNOWN) → retry 被拒 → 无新 job → cancel 退回未冻结部分」（合成 gen_task 用 `relook:` 前缀独立幂等键、amountFen=0，image provider 返回 unknown）；`miv-frame-` 统计断言覆盖尾帧目录。
- **验证**：`npm run test:server` 233/233（projects 25 例）；`npm run check` 通过；`git merge origin/main` 无冲突。
- **未完成 / 风险**：无新增；M2-BE-02「failed 超 7 天自动取消退款」已由 Lead 登记为后续任务。

### 2026-10-20 · BE-Core · M1-BE-05 复审修复（unknown 重试守卫、形象失败通知、签名链接、轮询超时、临时文件清理）
### 2026-10-20 · BE-Core · M1-BE-05 复审修复（unknown 重试守卫、形象失败通知、签名链接、轮询超时、临时文件）

- **背景**：按 §6 M1-BE-05 复审修复 5 条必改、6 条建议。已合并 `origin/main`（d2d074a），修复 2 个提交推同一分支。
- **改动**：
  - **必改 1**：`retryProject` 在 step 为 rendering/casting 时先查 `unknown` 状态的 take / look_versions，存在即 409（文案「该片段结果待核对，请联系客服」），只可 cancel；unknown 后上游不再收到第二次提交。
  - **必改 2**：`characters/service.js` 新增 `failProjectsForVersion`——look.generate 终态失败（LOOK_FAILED）/未知（LOOK_UNKNOWN，含停滞 submitting、提交异常、result unknown 三处）时同事务把引用该版本的 casting 作品置 `failed(step=casting)`；`retryProject` casting 分支从失败版本 `gen_tasks.request` 复制 `description/referenceKeys/promptHint`（金额 0）；`projectMoneySummary` 的形象流水聚合从「当前 look_version_id」扩展为「角色全部版本」，换版本后退款/结算流水不丢。
  - **必改 3**：`segment.generate` 提交前把 `imageRefs/audioRefs` 经 `storage.signedUrl(key, { ttlSeconds: projects.refUrlTtlSeconds（默认 6 小时，可配） })` 转签名 URL；`gen_tasks.request` 仍存 key（重新提交/对账重签）。测试 storage 加 `httpMemoryStorage` 包装（https 链接形态）。
  - **必改 4**：`gen.poll` 开头检查 `gen_tasks.created_at` 距今超过 `projects.genPollTimeoutSeconds`（默认 7200 秒 = 120 分钟，用户 2026-10-20 指定，可配）即按 unknown 处理（冻结、项目 failed(TAKE_UNKNOWN)、写 error 日志、不重提）。
  - **必改 5**：`gen.poll` 的 `extractLastFrame` 与 `project.compose` 的 `render.compose` 都传入 job 自己的 `workDir`，随 job 的 finally 一并清理；测试断言 job 结束后 /tmp 下无 `miv-take-*`/`miv-compose-*` 残留。
  - **建议 6~11**：`projects.story.usage` 保存扩写+理解累计的 LLM usage；`understand` 与 bind 同口径按 SKU 的 model 选 Skill；cancel 幂等键固定为 `cancel`；创建幂等键重放时比对 storyText/styleId/qualityTierId/ratio/characterIds，不一致 409 `IDEMPOTENCY_CONFLICT`；`segment.js` 顶部 import；所有 `.catch(() => {})` 收敛为只吞 `PROJECT_STATE_INVALID`。
- **测试**：新增复审修复 describe（4 例）——look 失败→failed(LOOK_FAILED)→retry 复制请求→成功推进（含钱包一致性）；轮询超时（回拨 created_at）；unknown 后 retry 拒绝且上游提交次数不变；临时目录无残留；另改 2 处断言（签名 URL 形态、串行链 imageRefs）。`npm run test:server` 232/232。
- **验证**：`npm run test:server` 232/232；`npm run check` 通过（本次未动前端，build 不受影响）；`git merge origin/main` 无冲突。
- **未完成 / 风险**：签名 URL 的 TTL（6 小时）与轮询上限（120 分钟）是可配参数，M0 按真实耗时调；`retryProject` 对 LOOK_UNKNOWN 同样拒绝（与必改 1 同口径）。

### 2026-10-20 · BE-Core · M1-BE-05 作品状态机与各 job（待审查）
### 2026-10-20 · BE-Core · M1-BE-05 作品状态机与各 job（待审查）

- **背景**：引擎与渲染线完成后，实现作品状态机、各 job 与钱包流（docs/TASKS.md M1-BE-05、ARCHITECTURE §4/§5、API §6）。分支 `agent/be/M1-BE-05-projects`（基于 main `fddb5df`），按阶段 6 个提交（认领 0e0ef76 → C2 17ebb8b/e9554fc → C3 c2941a8 → C4 9832e00/065cde9 → C5~C7 5743f25），每个提交全量测试通过。
- **受影响文件**：`server/src/projects/`（state/money/service/understand/bind/segment/compose/download/handlers/dev-stub，retry 内联在 service）、`server/migrations/002-projects-idempotency.sql`、`003-project-confirm-log.sql`、`server/src/worker.js`、`server/src/config.js`、`server/.env.example`、`server/test/projects/projects.test.js`（20 例）、`server/test/cron.test.js`（处理器清单断言随注册扩充同步）。
- **状态机落地**（认领说明的迁移表已全实现）：创建 → understanding →（project.understand：classifyInput→想法先 expandIdea→understand→持久化 story/cast/segments→回填已有形象）→ story_review ◆A →（confirmStory：未匹配角色自动建数字人、缺口形象按 cast_looks 报价扣费预占→casting→look.generate 成功回填→全就绪 cast_review ◆B）→（confirmCast：project_render 报价扣费+视频费预占+锁定→rendering）→ bind_prompts（final_prompt 落库）→ segment.generate/gen.poll 严格串行（提交→轮询→下载→render.inspect→转存→尾帧→逐段结算→下一段）→ project.compose（成片+封面转存）→ delivered（delivered_at/expires_at=+90 天）。pause/resume/retry/cancel、重启续跑（job 落库，resume 按 pausedFrom 重入队，retry 按 error.step 续跑）、免费次数（rate_counters 按北京日切日，创建与重新整理各计 1 次，重放不重复计）全部实现。projects.expire_sweep 为 BE-03 既有实现。
- **测试**：projects.test.js 20 例——创建校验/幂等重放/免额 429/北京日窗口；understand 剧本与想法分支、单片段无音色、幂等空转；confirmStory 扣费预占/重放/余额不足回滚；look 回填推进 cast_review；confirmCast 预占锁定/缺声音拒绝；bind_prompts final_prompt/startState=endState 串联/串行首段；全链（模拟上游）提交→轮询→转存→inspect→尾帧→逐段结算→拼接→delivered（时长≈60 秒、冻结清零）；inspect 全黑失败→failed→retry 免费重建→交付；take unknown→failed(TAKE_UNKNOWN)+取消只退未提交部分；暂停停链/恢复续跑。`npm run test:server` 228/228、check、build 通过；未调真实模型（story=mock LLM、视频=进程内假渠道、样片=lavfi/FFmpeg 合成）。
- **口径与风险**：① §5① 已改按 A 口径实现并说明理由（B 在账本上不成立），**待 Lead 追认**；② §5② unknown 呈现为 failed 待确认；③ confirmStory/confirmCast 的幂等重放先于状态校验（双击不报错）；④ cast_review 内 POST cast looks 复用 BE-04 createLookVersion（自动选中写资产库，作品内绑定由 PUT cast 完成）；⑤ worker 生产守卫：storyAgent/videoProvider 缺省启动报错，开发为确定性桩（视频桩提交即失败——真实渠道 M0/M2）；⑥ compose 的 fetchLocal 需要存储驱动提供 HTTP 下载地址（生产 qiniu ✓，memory 驱动会明确报错）；⑦ failed 作品的冻结金额需用户 cancel 退回（或 retry 消化），无自动退款定时任务——如需「失败 N 天自动退款」请 Lead 指示（建议挂到 §4 待确认）。

### 2026-10-20 · Render · M1-RND-01 复审修复（真末帧、悬空链接、分辨率放宽）
### 2026-10-20 · BE-Core · M1-BE-05 认领：状态迁移表与提交拆分（开工计划）

- **背景**：引擎（ENG-01~04）与渲染（RND-01）均已合并，本任务把作品状态机、各 job 与钱包流接起来。模块：`server/src/projects/`（状态迁移 + 服务函数 + job 处理器）、`worker.js`/`config.js` 接线、`server/test/projects/`。API 路由与 SSE 属 M1-BE-06，本任务只提供服务函数（测试直接调用服务层）。
- **状态迁移表**（每次迁移=短事务：校验当前状态 → 写状态+`project_events`+`NOTIFY` → 同事务 `enqueue` 下一个 job；事务内不调上游）：

| From | 触发 | To | 关键动作 |
|---|---|---|---|
| — | `createProject`（服务函数；免额次数校验、幂等键、锁定 tier_mapping） | understanding | enqueue `project.understand` |
| understanding | `project.understand` 成功 | story_review | 写 `story`（含引擎原始输出 bible/segments 全字段）、`project_cast`（含 characterId/voiceId 推荐/matchSource）、`segments`；给已选数字人回填本风格 succeeded 的 `look_version_id` |
| story_review | `reanalyze`（耗 1 次免费，按剧本处理不扩写） | understanding | 覆写 story_text、inputKind=script，清空 cast/segments/story 后重跑 |
| story_review | `confirmStory`（looks>0：consumeQuote `cast_looks` + reserve 形象费 + 为缺形象 cast 建 look_versions/gen_tasks；looks=0 直接跳） | casting / cast_review | enqueue `look.generate`×N |
| casting | 每个 `look.generate` 成功后回填 `project_cast.look_version_id`；全部就绪 | cast_review | （characters/service 的 handler 成功路径加项目回填与推进检查，同属 BE-Core） |
| cast_review | `confirmCast`（consumeQuote `project_render` + reserve 视频费；锁定 look/voice `locked_at`） | rendering | enqueue `project.bind_prompts` |
| rendering | `project.bind_prompts` 成功 | rendering | 每段写 `final_prompt`（skillId 按视频 SKU 的 model 选 Skill）；enqueue `segment.generate`(idx=0) |
| rendering | `segment.generate`：建 take/gen_task（幂等键=take）→ `prepare/submit`（prev_tail 时先取上段 `last_frame_key` 作 tailRef） | rendering | 成功：take running + enqueue `gen.poll`；unknown：take unknown、冻结不动、项目 failed（见 §5②） |
| rendering | `gen.poll`：running→退避重排；succeeded→下载临时文件→`render.inspect`→通过：转存+`extractLastFrame`+结算该段→enqueue 下一段；最后一段→enqueue `project.compose` | rendering | inspect 不通过/上游业务失败：take failed + **退回该段预占** + 项目 failed（§5① 口径） |
| composing | `project.compose`：取各段已选 take→`render.compose`→上传成片/封面→renders succeeded | delivered | delivered_at、expires_at=now+90 天 |
| 进行中 | pause / resume / retry / cancel | paused / pausedFrom / 失败步骤 / canceled | retry 从 `error.step` 续跑（失败片段免费重建新 take）；cancel 退回未提交部分（unknown 不退） |
| delivered | cron `projects.expire_sweep`（BE-03 已实现） | expired | — |

- **进度 percent 分档**（内部口径）：understanding 5~15、story_review 15、casting 30、cast_review 40、rendering 45~90（每段均分）、composing 95、delivered 100。
- **提交拆分**（每个提交 self-contained、全量测试通过后才有下一个）：C2 创建+understand；C3 确认点 A+casting；C4 确认点 B+bind_prompts；C5 串行片段链（segment.generate+gen.poll+inspect/尾帧/结算）；C6 compose+delivered；C7 暂停/恢复/取消/重试+worker 生产守卫；C8 §7 交接与待审查。
- **生产/开发注入**：worker `buildHandlers` 增加 `{ storyAgent, videoProvider, transfer, fetchLocal }` 注入点；生产缺省启动报错（同 BE-03/04 守卫）；开发缺省给确定性桩（story LLM 返回固定合法规划；片段链不注册并 warn，因真实上游属 M0/M2）。`config.projects`: `freeDailyQuota=20`（北京日界，PRD【默认】）、`retentionDays=90`、`ideaCharThreshold=60`；新增环境变量登记 `.env.example`。
- **测试**：`server/test/projects/`——mock LLM（engine story mock）+ 假视频 provider（进程内 prepare/submit/query）+ memory storage + 真 render（FFmpeg）+ 假 fetchLocal；覆盖验收列出的每一项。


### 2026-10-20 · Render · M1-RND-01 复审修复（真末帧、悬空链接、分辨率放宽）

- **背景**：按 §6 M1-RND-01 复审修复 3 条必改、2 条建议。已合并 `origin/main`（`47599db`），推同一分支。
- **改动**：
  - **必改 1（尾帧不是最后一帧）**：`extractLastFrame` 改为 `-sseof -0.3 -i video -update 1 -q:v 3 out.jpg`，**去掉 `-frames:v 1`**——image2 muxer 逐帧覆盖同一文件，结束时留下的就是真正的最后一帧；同时不再预探测时长（少一次 ffprobe），个别容器寻址索引异常时退回顺序解码（至少产出一帧）。测试改用红 3 秒→绿 0.5→蓝 0.5 的样片断言尾帧为蓝（旧实现取 t=dur-1=3 秒处的绿帧会在此挂掉），并补极短样片（0.2 秒，`-sseof` 越过头）仍能提取的用例。
  - **必改 2（悬空符号链接）**：`git rm '{{pkgetc}}/cert.pem'`。根因：本机 `brew install ffmpeg-full` 时 ca-certificates 依赖的安装脚本把 `{{pkgetc}}` 模板变量原样落成了目录和指向本机绝对路径的悬空链接，被当次提交的 `git add -A` 误收。已核查提交内容，其余文件均为本任务产物。
  - **必改 3（分辨率检查过严）**：改为①画幅比例相对误差 ≤2%（旋转方向不区分）；②分辨率只在**短边低于档位的 90%** 时判不符（高于档位不算问题）。测试覆盖：720x1280 通过、1088x1920（16 的倍数规格）通过、360x640 判不符、1:1 比例错判不符；原「9:16 文件对 16:9 请求判不符」断言删除（放宽后比例族相同即通过）。
  - **建议 4**：`blackRatio`、`frozenRatio`（缺省 0.9）提升为 `createRender` 参数；测试验证 1 秒内容+4 秒定格（80% 静止）在缺省下通过、`frozenRatio: 0.5` 时检出。
  - **建议 5**：README 写明「调用方需在调用前保证本地文件存在」——`UNDECODABLE` 不区分文件丢失（基础设施问题，BE-05 应重试转存）与视频损坏（该段失败退回预占），BE-05 调用前检查文件存在即可区分。
- **验证**：`npm run test:server` 208/208（render 11 例）；`npm run check`、`npm run build` 通过；`git merge origin/main` 无冲突。
- **未完成 / 风险**：`blackRatio`/`frozenRatio` 缺省 0.9 与比例容差 2% 按审查口径定死在代码常量，M0 看真实素材后经 `createRender` 参数调整即可（引擎不改代码）。

### 2026-10-20 · Render · M1-RND-01 补记：drawtext 分支修复与验证（用户提议升级本机 FFmpeg 引出）

- **背景**：用户问「能否通过升级本机 FFmpeg 解决 drawtext 缺失」。查证结论：**升级无用**——Homebrew 的 `ffmpeg` 配方已刻意精简（配方注释明说其他依赖放 `ffmpeg-full`），8.1.2 与最新 9.0.2 都没有 drawtext。改为安装 keg-only 的 `ffmpeg-full` 9.0.2（不链接、不影响系统命令），把 render 的 `ffmpegPath` 注入指向它做端到端验证。
- **验证发现并修复 2 个 bug**（系统 ffmpeg 无 drawtext，首轮测试从未走到该分支，全部靠 ffmpeg-full e2e 暴露）：
  1. drawtext 的 y 表达式误用了 `overlay_h`（那是 `overlay` 滤镜的变量，drawtext 只有 `text_h`），滤镜初始化失败导致编码器 EINVAL。已修复并抽为 `drawtextFilter()` 导出，单测断言 `text_h` 且禁止 `overlay_h`。
  2. **中文豆腐块合规风险**：即使 drawtext 可用，fontconfig 找不到 CJK 字形时把「AI 生成内容」画成方框（本机 ffmpeg-full 实测截图确认）。已改为：**显式标识缺省一律走 PNG 资产叠加**（渲染跨平台一致）；只有调用方注入 `drawtextFontFile`（中文字体文件路径）才启用 drawtext（文案可自定义）。注入本机字体后 e2e 截图复核「AI 生成内容」渲染正常。
- **环境变化（本机）**：`brew install ffmpeg-full`（keg-only，路径 `/opt/homebrew/opt/ffmpeg-full/bin`）顺带升级了共享依赖，系统 ffmpeg 一度断链，已 `brew upgrade ffmpeg` 修复至 9.0.2（无 drawtext，render 缺省路径不受影响）；测试 PostgreSQL 容器一度未运行，已重启并全量回归。
- **验证**：`npm run test:server` 206/206（新增 drawtextFilter 用例）；系统 ffmpeg 9.0.2 与 ffmpeg-full 9.0.2 双路径 e2e（drawtext 分支注入字体后水印区域 YAVG 差异 24.3 且截图确认中文渲染）；`npm run check`、`npm run build` 通过。
- **M2 提醒**：服务器上若启用 drawtext，必须同时装 CJK 字体（如 Debian `fonts-noto-cjk`）并注入 `drawtextFontFile`、人工核对渲染，否则合规标识可能显示为方框（已写入 `server/src/render/README.md`）。

### 2026-10-19 · Render · M1-RND-01 成片合成与片段技术验收（待审查）

- **背景**：M1-ENG-04 合并（`6daa673`）后引擎线完成，按 Lead 指示开工 M1-RND-01（`render.compose` / `extractLastFrame` / `inspect`）。分支 `agent/render/M1-RND-01-compose`（基于 main `6daa673`），认领 + 实现 + 交接共 3 个提交。本机 FFmpeg/FFprobe 8.1.2。
- **受影响文件**：`server/src/render/{index,ffmpeg,compose,inspect}.js`、`server/src/render/README.md`（骨架扩写为对接说明）、`server/src/render/assets/ai-mark.png`（新增资产）、`server/test/render/render.test.js`（新增）。
- **核心实现**：
  1. **compose**（PRD §4.4）：每段 `scale+pad` 归一到目标画幅（`dimensionsFor`：短边=档位、两边取偶）+ fps30 + `loudnorm=I=-16:TP=-1.5:LRA=11`（EBU R128）→ 48k AAC；`concat` 滤镜硬切拼接；**显式 AI 标识**——构建带 drawtext 时绘制 `watermarkText`（缺省「AI 生成内容」、首次调用探测并缓存），否则叠加内置 PNG 资产 `assets/ai-mark.png`（本机 FFmpeg 8.1.2 无 drawtext 滤镜，`overlay` 为核心滤镜任何构建可用；资产由本机 Swift CoreText 生成一次后提交，自制素材无第三方版权）；**隐式标识**写 MP4 `comment`；封面取 1 秒处 JPEG；输出 H.264+AAC MP4 `+faststart`；支持可选 `workDir`（对齐 Lead 骨架 README 的约定），缺省系统临时目录、文件名含 UUID 防并发碰撞。**不加 BGM/字幕**。
  2. **extractLastFrame**：探测时长后 `-ss duration-1` 取最后一帧 JPEG，供下一段普通参考图。
  3. **inspect**（PRD §4.3，全部 FFprobe/FFmpeg 零模型调用）：`UNDECODABLE`（probe 失败即返回，不再后续检查）、`VIDEO_STREAM_MISSING`、`AUDIO_STREAM_MISSING`（受 `expectAudio` 控制）、`DURATION_MISMATCH`（±2 秒）、`RESOLUTION_MISMATCH`（`dimensionsFor` 精确比对）、`BLACK_VIDEO`（blackdetect 黑色累计 ≥90% 时长）、`FROZEN_VIDEO`（freezedetect n=-60dB/d=2s，冻结累计 ≥90% 时长，未闭合的冻结延伸到片尾）、`SILENT_AUDIO`（volumedetect max < -60dB）。`message` 中文、`code` 供 BE-05 分支；错误统一 `RenderError`（`RENDER_INPUT_INVALID`/`RENDER_FFMPEG_MISSING`/`RENDER_FFMPEG_FAILED`/`RENDER_TIMEOUT`），上游细节只在 `detail` 供日志。
- **测试**：`server/test/render/render.test.js` 8 例——`dimensionsFor` 表；`inspect` 正常样片全绿；全黑（只报 BLACK 不误报静音）、红色静帧（只报 FROZEN 不误报全黑）、静音各自命中；缺音轨受 `expectAudio` 控制、时长 ±2 秒容差两侧、分辨率不匹配、截断 30% 的损坏文件 `UNDECODABLE`；`extractLastFrame` 用红→蓝视频断言取到末帧（signalstats YAVG 蓝≈29/红≈76 对照）；`compose` 两段拼接时长≈6 秒、h264+aac/720x1280/元数据标识/封面存在、同一输入有/无水印时左下角水印区域 YAVG 差异 >2 证明显式标识真实叠加；compose 输入校验 4 例；`escapeDrawtext` 转义。样片全部 `lavfi` 合成，无真实模型费用。
- **验证**：`npm run test:server` 205/205（197 + 8）；`npm run check`、`npm run build` 通过；`git merge origin/main` 无冲突。
- **未完成 / 风险**：① 显式标识在本机走 PNG 叠加路径（drawtext 缺失），drawtext 分支逻辑已实现但本机无法 e2e 验证，M2-OPS 若用带 freetype 的构建建议人工过一眼；② 生产镜像必须装 FFmpeg（含 `libx264`/`aac`，Homebrew 与 Debian 默认均满足）；③ 水印 PNG 上的文字为静态资产，改文案需重新生成资产或用 drawtext 构建；④ BE-05 接入时 `inspect` 失败分支（片段失败、退回预占）由 BE-Core 实现，接口已就绪。

### 2026-10-19 · Engine · M1-ENG-04 复审修复（图片编号与提交顺序一致 + 剧本对白确定性比对）

- **背景**：按 §6 M1-ENG-04 审查修复必改 1；建议 2 一并实现。已合并 `origin/main`（`0aa9c34`，含 Lead 更正的 `docs/skills/wan-3.0.md` §6），修复 2 个提交推同一分支。
- **改动**：
  - **必改 1（图片编号错位）**：`skills/base.js` 的 `assemble` 与 `refLabels` 按更正后的规格改为「尾帧占 `图1`、人物形象图从 `图2` 开始；无尾帧时人物从 `图1` 开始」，音频编号不变（`音色参考音频M` 按 `audioRefs` 顺序）。参考素材块内尾帧行排在首位，与编号一致。
  - **必改 1②（跨模块一致性测试）**：新增 `server/test/engine/skill-provider-numbering.test.js`——用 `bindPrompts`（模拟 LLM 返回合法镜头）的 `prompt`/`imageRefs`/`usePrevTail` 走 `createWan30Adapter` 的 `prepare + submit`（本地假上游捕获请求体），断言有尾帧时 `image_file_1=尾帧`、`image_file_2/3=形象图` 且提示词 `图1/图2/图3` 一一对应，无尾帧时人物从 `图1` 对应 `image_file_1/2`。
  - **建议 2（剧本对白确定性比对）**：`story/plan.js` 新增 `assertDialogueFromSource(plan, storyText)`（去空白与全部标点/符号后逐句 `includes`，线性正则无回溯）；`understand` 在 `inputKind: 'script'` 或 `expanded: true` 时于校验阶段调用，新增的对白会带着「剧本模式不得新增对白」进修复重试，2 次后仍失败走既有兜底；`inputKind: 'idea'`（未扩写）跳过。测试默认剧本与 `duplicate-voice` 用例的 storyText 已改为包含各自对白原句。
- **验证**：`npm run test:server` 197/197 通过（新增跨模块 2 例 + 剧本忠实 1 例；skills/story 的逐字与编号断言同步更新）；`npm run check`、`npm run build` 通过；`git merge origin/main` 无冲突。
- **未完成 / 风险**：真实模型下「模型改写对白被拦下修复」会增加重试次数，M0 冒烟脚本（剧本模式）可观察 `story_plan_repair` 频率，必要时在 §5 再提调整（如对白比对放宽为仅在 `compressed` 时告警）——当前严格按审查意见执行。

### 2026-10-19 · Engine · M1-ENG-04 设定集/结束状态/Skill/编剧扩写（待审查）

- **背景**：M1-ENG-01 合并（`298929d`）后按 Lead 指示以新分支实现审查记录第 10~15 条：`docs/skills/wan-3.0.md`（v2）与 `docs/ARCHITECTURE.md` §5 新契约。分支 `agent/eng/M1-ENG-04-skills`（基于 main `298929d`），共 4 个提交（认领 + 三个功能提交）。
- **受影响文件**：`server/src/engine/skills/{index,wan-3.0,generic,base}.js`（新增）、`server/src/engine/story/{index,prompts,parse,plan,call}.js`、`server/src/engine/story/expand.js`（新增）、`server/src/engine/README.md`（BE-05 对接说明重写）、`server/test/engine/{skills,expand}.test.js`（新增）、`server/test/engine/story.test.js`（重写）、`server/test/engine/fixtures/story/*`（有效样本补齐 bible/endState 等新字段）。
- **核心实现**（按任务规格顺序）：
  1. **设定集 bible**：`understand` 输出 `bible`（mood/characters/scenes/props，英文），提示词写明字段与示例（STORY_EXAMPLE 含 bible，契约测试保证示例过 parse+validate+normalize）；硬规则（英文-only、handle 唯一、castIndex/sceneId/propIds 引用存在）失败进修复重试，软限制（词数 8/25/50/25）归一化截断并记 `story_bible_clamped`；保底方案也生成确定性英文 bible。
  2. **endState/startState/shots**：每段输出 `sceneId`（不再删除）、`propIds`、`endState`（≤50 词截断）、`takeMode`；`bindPrompts` 返回 `startState`（上一段 endState，仅 prev_tail）、`endState`、`shots`、`skillId`、`skillVersion`、`degraded`，BE-05 存 `segments.final_prompt` 无需新列。
  3. **代码拼装提示词**：新增 `skills/`（注册表 `get(skillId)`/`forModel(model)` 回退 generic；`wan-3.0.js` 含 planningGuide 与 shotSystem §4/§5.1 原文+占位符；`base.js` 共享 `validateShots`/`assemble`/`fallbackTimeline`/`refLabels`/`dialogueSentence`/`buildShotMessage`）。`bindPrompts` 改为每段一次 LLM 调用写镜头时间线；`assemble` 按 §6 块顺序逐字拼装（成品示例逐字一致测试）；对白逐字校验（不新增/不改写/不丢/顺序不变）、英文字段禁中文、镜头时间首尾相接、语速预算；超长先裁镜头级 avoid 再截 environment、仍超判失败重试；修复 2 次失败走单镜头确定性兜底（`degraded: true`）。STORY_SYSTEM 里模型相关的节奏规则挪进 Skill 的 `planningGuide`，`understand` 按 `skillId` 注入。
  4. **expandIdea**：`story/expand.js`——目标时长 `min(maxSeconds, 60)`；校验对白字数预算（≤目标秒 × Skill 的 dialogueCharsPerSecond）、已勾选数字人必须出场、不含镜头运镜（保守词表）；2 次修复后兜底（想法原文作剧本，`degraded: true`）；想法原文只进不可信数据区；`createStoryAgent` 暴露 `expandIdea`。
  5. **classifyInput（约 60 字）**：确定性判定——≤阈值（默认 60，`ideaCharThreshold` 可配置）且无对白标记（「」『』、说/问/答等+冒号）与场景字段（场景/地点/时间/内景/外景+冒号）判「想法」；导出自 `story/expand.js` 与 `story/index.js`，BE-05 在 `project.understand` job 里先于 LLM 调用。
- **测试**：新增 `skills.test.js`（12 例：注册表、§5.3 示例契约、镜头校验与对白逐字、§6 成品示例逐字拼装、兜底、generic）与 `expand.test.js`（7 例：classifyInput、扩写契约、修复、兜底、取消/超时）；`story.test.js` 重写为 26 例（原 M1-ENG-01 全部用例保留并适配新契约，新增 bible 修复、script/inputKind/expanded 透传、skillId 注入、bindPrompts 镜头流程/prev_tail/兜底/single_take/超长裁剪/输入校验）。`npm run test:server` 194/194 通过。
- **验证**：`npm run test:server` 194/194；`npm run check`、`npm run build` 通过（见最终推送前自测）；未调用真实模型（全部模拟 LLM）。
- **未完成 / 风险**：① §5 登记了 6 条实现解释口径（takeMode 字段、ratio 不进正文、标点归一化、classifyInput 细则、软硬校验划分、single_take 豁免逐镜头上限），待 Lead 确认；② `docs/skills/wan-3.0.md` 第 9 节的 M0 假设全部落在 `limits` 可配置，M0 A/B 时直接改 Skill 参数即可；③ 敏感信息自查无异常（全部为虚构内容）。

### 2026-10-19 · Engine · M1-ENG-01 复审修复（取消语义与超长片段）

- **背景**：在原分支合并 `origin/main`（996353f）后，按 §6 复审修复 2 条必改与建议 3；已阅工作流新决定与 `docs/skills/wan-3.0.md`（v2）、`docs/ARCHITECTURE.md` §5 新契约、`docs/TASKS.md` M1-ENG-04 任务描述，**本轮未实现**，待 ENG-01 合并后按指示以 M1-ENG-04 单独开工。
- **改动**：
  - 必改 1（取消不生效）：删除按错误信息字符串分类的 `isCallerCancelled`；`understand` / `bindPrompts` 循环每次尝试前 `throwIfCallerCancelled(signal)`——调用方信号已 abort（`signal?.aborted`）就抛 `signal.reason`（默认原因包装为 `AbortError`），不看原因文字；provider 失败路径同样先检查信号再决定重试。取消时 LLM 调用 ≤ 1 次。
  - 必改 2（超长片段被丢弃）：`normalizePlan` 的溢出条件收敛为「剩余预算 < 最小允许值」；请求时长超过允许最大值时**向下取到不超过剩余预算的最大允许值**保留该段，任何时长改动或合并都置 `compressed`。
  - 建议 3：`story-smoke.js` 删除 `/root/chaodayun` 硬编码导入分支与遗留 `void readFile;`，只保留自带 OpenAI 兼容路径；`@earendil-works/pi-ai@0.87.1` 写死为 `server` 直接依赖。
- **测试**：新增取消用例（默认原因、自定义原因「项目已取消」、调用前已 abort、`bindPrompts` 取消——全部直接抛出且 LLM 调用 ≤ 1，调用前已 abort 时为 0）；新增超长片段用例（`[100]` → 30、`[60,30]` → 30+30 顺序不变、`[30,30,30,5]` 第 4 段预算耗尽合并且 `compressed`）；「预算不足」用例按新规则改为 `[30,30,10]`（向下取值保留）。旧「用户停止」魔法字符串测试删除。
- **验证**：`npm run test:server` 169/169 连续四轮通过；`npm run check`、`npm run build` 通过；敏感信息扫描无异常。未调用真实模型。
- **未完成 / 风险**：取消抛出的错误为 `signal.reason` 原样（默认原因是 DOMException AbortError，自定义原因是调用方给的 Error），BE-05 的 Worker 处理器需按 `signal.aborted` 或错误名识别取消，不要比较消息文本；M1-ENG-04（bible/endState/Skill/expandIdea）待 ENG-01 合并后读最新文档开工。

### 2026-10-19 · Engine · M1-ENG-01 审查修复（输出契约、角色匹配与超时）
### 2026-10-19 · Engine · M1-ENG-01 审查修复（输出契约、角色匹配与超时）

- **背景**：在原分支合并 `origin/main`（64d356b）后，按 §6 修复 5 条必改与建议 6~9；「设定集」与「每段结束状态」按 Lead 指示暂不实现。
- **改动**：
  - 必改 1：`STORY_SYSTEM` / `BIND_SYSTEM` 写明完整输出字段说明、取值范围与完整示例 JSON（`STORY_EXAMPLE` / `BIND_EXAMPLE` 导出）；新增契约测试「示例必须通过 `parseModelJson` + `validatePlan` + `normalizePlan`」；新增 `server/scripts/story-smoke.js` 真实调用冒烟脚本（读环境变量，打印 degraded / 重试 / usage，默认不运行、不参与测试）。
  - 必改 2：角色匹配精确同名优先，子串只在唯一候选时采用，`characterId` 先到先得不重复绑（`bindCharacters` 导出并直接单测）。
  - 必改 3：短片段向上取整到最小允许时长，只在剩余预算不足时才停止；任何时长改动或片段合并都置 `compressed`；溢出剧情拼接上限 1000 字并记日志（建议 9）。
  - 必改 4：保底方案在无勾选数字人时注入默认「主角」（unknown/young）并让所有片段引用。
  - 必改 5：`understand` / `bindPrompts` 接受 `{ signal, timeoutMs }`（默认 90 秒），超时按失败走修复/兜底，调用方取消直接抛出；挂起 LLM 超时后兜底不再无限等待。
  - 建议 6：修复重试把上一版输出（截断 2000 字）作为 `assistant` 消息回传，`llm/pi.js` 按 role 原样映射历史。建议 7：`bindPrompts` 对白同时支持 `castId` 与 `castIndex`（`segmentPrompt` 与重要性排序均回退），`engine/README.md` 新增 understand 输出 ↔ bindPrompts 输入字段对应表。建议 8：`usePrevTail` 时参考图预算减 1 为尾帧留位。
- **测试**：`server/test/engine/story.test.js` 从 9 例扩到 12 例（契约、三种角色匹配情形、短片段/预算不足/压缩标记、保底主角、挂起超时与取消、修复带上版输出、对白回退与尾帧预留）；`llm/mock.js` 支持函数步骤模拟「忽略超时的 provider」并响应 abort。开发中发现并修复：已 abort 的外部信号不会触发 `addEventListener`，`deadlineSignal` 现在立即传播；音色不足以全部分配时留空交由用户在确认点 B 选择，不再抛错卡死（审查原「明确报错」按兜底原则收敛为「部分分配 + degraded 语义」，已在下方风险中标注）。
- **验证**：`npm run test:server` 167/167 连续四轮通过（首轮出现整库 3ms 内全被取消，系测试库容器已停止，`npm run test:db:up` 后恢复）；`npm run check`、`npm run build` 通过；敏感信息扫描无异常。未调用真实模型。
- **未完成 / 风险**：音色不足现为「分配到不重复为止、其余留空」，与开工要点「音色不够用时抛出明确错误」的表述不同——按 §6e「绝不能因 LLM 抽风卡死」的兜底原则处理，请 Lead 复审确认该取舍；`story-smoke.js` 需 M0 授权后人工运行。

### 2026-10-17 · Engine · M1-ENG-01 故事理解与片段规划

- **背景**：按 §6 M1-ENG-01 开工要点 a~g、`docs/ARCHITECTURE.md` §5、PRD §4.2/§4.7，实现注入式故事代理。参考超搭云 `2926b42` 的 screenwriter/agent/wan-video/storyboard 提示词与 pi Agent 接入思路，不复制其仓库、会话、计费依赖；`@earendil-works/pi-agent-core` 精确版本 `0.87.1`。
- **改动**：`server/src/engine/story/{index,parse,plan,prompts}.js` 实现 `createStoryAgent({ llm, logger }) → { understand, bindPrompts }`；`engine/llm/{pi,mock}.js` 实现 pi Agent 桥接与脚本化模拟 LLM；新增 `server/test/engine/{story,pi-llm}.test.js` 及 9 份模拟常见 LLM 输出形态的故事夹具，夹具来源说明在 `fixtures/story/README.md`；更新依赖锁文件。
- **核心实现**：故事作为不可信 JSON 数据区放入消息，系统提示明确故事中的指令不得执行；输出扫描首个完整 JSON 对象，兼容围栏、前后文本、尾逗号，长度上限 200k 字符，无嵌套量词回溯。严格校验角色/片段/对白索引；最多两次校验反馈修复，仍失败则确定性兜底并标 `degraded: true`。每段时长只取 SKU 的 `allowedDurations`，总时长不超 `maxSeconds`；超出时保留因果并把溢出剧情合并到最后片段，给出精简提示；已勾选数字人保证出现，匹配资产 ID，音色优先默认值且全作品不重复，不足时明确报错。`prev_tail` 仅相邻片段有相同 `sceneId` 时保留，否则硬切。`bindPrompts` 输出片段内多镜头运镜骨架、风格、形象/音频引用、`usePrevTail`、按出场和对白重要性裁剪的 `droppedRefs`；坏输出两次修复后确定性提示词兜底。LLM `usage` 汇总 input/output tokens，仅供内部核算，用户价为零。
- **验证**：`npm run test:server` 161/161，连续四轮通过；`npm run check`、`npm run build` 通过；敏感信息扫描与 `git diff --check` 无异常。9 份夹具涵盖正常、围栏、多余前后文、尾逗号、缺字段、超长、姓名不匹配、音色重复、类型漂移；pi 桥接用注入的模拟流运行，所有测试无真实模型调用。
- **未完成 / 风险**：真实 LLM 文本与模型成本、视觉和声音一致性尚未验证，留 M0/M2 经用户授权；`bindPrompts` 当前依赖调用方提供角色的 `lookImageKey/refAudioKey`，与 BE-05 联调时需确认字段映射。复审通过前不开其他任务。

### 2026-10-17 · Engine · M1-ENG-02 复审修复（参考图读取与测试稳定性）

- **背景**：在原分支合并 `origin/main`（bb0cf8a）后处理 §6 复审必改 1、2，顺手处理建议 3、4。
- **改动**：`engine/providers/modelhub-image.js` 捕获 `loadReference` 抛错，包装为 `PROVIDER_REFERENCE_UNAVAILABLE`、`submitted=false`、`retryable=true` 的 `ProviderError`，交 BE-04 队列重试；拿到参考图但不是 Buffer 时仍是 `PROVIDER_INPUT_INVALID`，作为终态失败。`providers.test.js` 共用本地 HTTP 假服务超时由 70ms 调至 2500ms；仅专门的超时用例创建 60ms 独立传输层，连接拒绝用例使用 2500ms。
- **建议项**：Modelhub 视频失败返回固定中文用户提示，最多 200 字的上游原文仅放 `providerMessage`；图片 facade 对本地 `PROVIDER_CONFIG_INVALID`、`PROVIDER_INPUT_INVALID` 也记录 error 日志，鉴权 401/403 日志保留。
- **验证**：新增参考图存储首次失败、第二次成功的回归：首次抛可重试且未提交、上游请求数为零，恢复后仅调用上游一次；非 Buffer 走失败不重试。视频失败脱敏和本地参数错误日志均有断言。`npm run test:server` 148/148 连续四轮通过；`npm run check`、`npm run build` 通过；未访问真实上游。
- **未完成 / 风险**：图片适配器分辨率由 `createImageProvider` 创建时的 SKU 固定，M2-BE-01 真实渠道集成需按 `gen_tasks.sku_code` 配置每次任务的分辨率（§6 已登记）；复审通过前不开始 M1-ENG-01。

### 2026-10-17 · Engine · M1-ENG-02 审查修复（终态与图片请求）

- **背景**：在原分支合并 `origin/main`（d673761）后，按 §6 处理必改 1~4 和建议 6、7；用户更正第 5 条：视频固定 `omni_reference`，`tailRef` 只作普通参考图，图片参考只取第一张。
- **改动**：`engine/providers/modelhub-video.js` 完整覆盖超搭云 `getVideoUrl` 的 21 种候选位置并校验 URL，失败/过期/拒绝等终态为 `failed`，成功无 URL 为 `unknown`；`tailRef` 排在普通图片参考首位，继续携带音频，不实现首尾帧模式。Modelhub 专属能力、字段和路径留在 `modelhub-video.js`、`modelhub-image.js`，注册表和 `image.js` facade 保持渠道无关；`engine/README.md` 写明尽力而为、不保证首帧衔接。
- **图片与错误**：图片模型能力按参考仓库配置校验（GPT Image 2 默认 `quality=1080p`、`detail_level=medium`，不接受占位 SKU 的 `2k`）；按顺序只取第一张参考图，记录 `droppedReferences` 与警告日志。明确 4xx 拒绝返回面向用户的中文 `failed`（上游原文仅作 `providerMessage`），连接拒绝/DNS/429 抛 `retryable=true, submitted=false`，超时/5xx/受理后断开返回 `unknown`；结果图下载最多三次指数退避，不重提交。共享传输保留截断至 200 字符的上游错误详情，并把响应体限制为 1MB。
- **跨所有权批准改动**：`server/src/characters/service.js` 的 `look.generate` 抛错处理单独提交（0c07ff4）：仅 `retryable=true` 回退 `created` 交队列重试，其他异常置 `unknown`、费用冻结；对应数据库回归验证任务与钱包状态。
- **测试**：新增由超搭云 `2926b42` `getVideoUrl` 候选位置构造的逐项 JSON 夹具（非生产抓包），本地 HTTP 假服务验证视频/图片请求、单张参考、拒绝分类、下载重试、429/鉴权详情、响应体上限。`npm run test:server` 146/146 连续四轮通过，`npm run check`、`npm run build` 通过；未调用真实上游。
- **未完成 / 风险**：当前 Modelhub 目录是按参考项目及本地 QA 形状实现，不代表供应商正式承诺；真实响应、模型档位映射与费用需 M2 授权联调。`tailRef` 只是普通图片参考，不保证片段首帧衔接。复审通过前不开始 M1-ENG-01。

### 2026-10-17 · Engine · M1-ENG-02 视频与图片渠道适配器

- **背景**：M1 引擎迁移第二个任务。按 §6 d 项与 `docs/ARCHITECTURE.md` §5，从超搭云参考提交 `2926b42` 的 `backend/providers.js`、`modelhub-models.js`、`dimensio-image-generation.js` 适配。只读参考源码，未连接真实供应商或产生模型费用。
- **改动**：新增 `server/src/engine/providers/`：注册表、共享 Modelhub HTTP 传输、Wan 3.0 / Seedance 2.5 视频适配器、同步图片生成/参考图合成适配器和兼容 BE-04 的 `createImageProvider`。新增 `server/test/engine/providers.test.js`，使用本地 HTTP 假服务；`fixtures/modelhub-{video,image}-qa.json` 与 `modelhub-provenance.md` 分别保存参考项目 QA 形状及证据等级。
- **核心实现**：视频按 `model/prompt/resolution/ratio/duration/functionMode` 和 `image_file_N`、`audio_file_N` 字段白名单提交，首帧占 `image_file_1`；注册表对重复 ID 和契约缺失失败。图片无参考走 JSON `/v1/images/generations`，有参考走 multipart `/v1/images/compositions`；facade 返回 BE-04 所需的 `succeeded {buffer,contentType}`、`failed` 或 `unknown`，不使用固定 `characterId:styleId` 上游幂等键，以免阻断重新生成。明确拒绝的 4xx 和连接拒绝标 `submitted=false` 并抛出；超时、5xx、受理后断开、成功却缺任务 ID 归为 `unknown`，不自动重提。
- **验证**：本地 HTTP 假服务覆盖视频 submit/query/normalize、图片 JSON 与 multipart、成功/业务失败/超时/连接拒绝/受理后断开。`npm run test:server` 141/141，连续四轮通过；`npm run check` 与 `npm run build` 通过。仓库敏感信息扫描与 `git diff --check` 无异常。
- **未完成 / 风险**：公开 Modelhub quick-start 确认视频接口路径，但没有响应 JSON；夹具是超搭云 `2926b42` 的本地 QA 形状或按其解析代码构造，**不是官方响应或生产抓包**。真实渠道能力、响应差异、费用和参考图签名 URL 有效期需 M2 授权联调。当前 `createImageProvider` 仍通过注入的安全下载器获取结果，生产接线留待 BE-05；复审通过前不开始 M1-ENG-01。

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
