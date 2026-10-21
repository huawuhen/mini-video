# M0 渠道实测笔记：Modelhub（seedance-2.5 视频 / gpt-image-2.5-flare 图片）

> 2026-10-21，开发 Agent（Engine 角色）。M0-02 渠道接入部分的真实调用记录与结论。
> 授权与费用规则见 CODEX_HANDOFF §3 2026-10-20（上限 300 元，账本 `cost-ledger.json`，270 元停止线）。
> 本文不含密钥与上游临时链接；产物（图片/视频字节）在本机 `server/.data/m0/`（gitignore，不入库）。

## 1. 结论速览

| 项 | 结论 |
|---|---|
| 渠道连通性 | `https://api.modelhub.cc` 正常；`GET /v1/models?include_capabilities=1` 返回 16 个模型的完整能力与实时单价（免费） |
| 视频 `seedance-2.5` | 提交→轮询→下载全链路通过（4s/480p/9:16 文生视频，h264+aac 60fps，内容与提示词一致）；**上游实际路由到字节系 CDN**（结果域名 `v16-cc.capcut.com`） |
| 图片 `gpt-image-2.5-flare` | 文生图与参考图合成（multipart `images`）均通过；**上游实际路由到 PixVerse**（结果域名 `media.pixverse.ai`） |
| 图片请求形态 | flare 与 `gpt-image-2` 不同：分辨率走独立 `resolution` 字段（`1k/2k/4k`，兼容 `1080p` 等旧写法），`quality` 与 `detail_level` 是 `low→max` 档位（适配器已按模型区分，单测覆盖） |
| 人物一致性 | compositions 用 1 张参考图换视角，脸型/发型/服装/背景保持良好（BE-04 形象生成路径可用） |
| 单价变化 | `seedance-2.5` 实时价 **480p=39 / 720p=47 / 1080p=280 分/秒**；源项目 2026-10-08 快照（38/85/114）已过期，**SKU 报价必须按实时目录** |

## 2. 实时目录要点（2026-10-21 快照：`modelhub-catalog.json`）

- **seedance-2.5**：时长 4~30 秒整数；分辨率 480p/720p/1080p（默认 720p）；ratio `21:9 16:9 4:3 1:1 3:4 9:16 auto`（默认 9:16）；`functionMode: omni_reference | first_last_frames`；`image_file_N / video_file_N / audio_file_N` 参考素材；`generate_audio` 布尔（默认 true）；**参考视频的实际时长会与输出时长合并计费**。计价 `per_second_range`（分/秒）：480p 39、720p 47、1080p 280。
- **gpt-image-2.5-flare**：按张计价（分/张），随分辨率 × 档位：1k {low 10, medium 23, high 33, xhigh 45, max 80}、2k {17/30/44/60/120}、4k {22/37/60/85/150}；`ratio` 默认 1:1（15 种取值）；`resolution` 默认 1k；`quality`/`detail_level` 默认 high（目录价 `default`=high 档）。参考图走 `/v1/images/compositions`（multipart，字段名 `images`）。
- 目录为「自动路由」：能力与价格随当时可用渠道浮动，**调用前可随时重跑 `models` 子命令刷新快照**。

## 3. 实测调用记录（与账本对应）

| 时间（UTC） | 调用 | 结果 |
|---|---|---|
| 07:48 | flare 1k/low 文生图 | 生成成功（18s），下载被 SSRF 防护拦（见 §4 环境坑 1） |
| 07:50 / 07:51 | 同上 ×2 | TLS 握手阶段被本机代理重置（ECONNRESET@5s，见 §4 环境坑 2；未到达上游，预计未计费） |
| 07:59 | flare 1k/low 文生图 | ✅ 成功 18s，PNG 1024×1024 1.5MB，内容与提示词一致 |
| 08:00 | flare 1k/low compositions（参考图=上一张） | ✅ 成功 21s，换视角后人物一致性良好 |
| 08:01 | seedance-2.5 4s/480p/9:16 文生视频（任务 `99bd7564…`） | ✅ 08:45 完成（**排队约 44 分钟**），mp4 480×854 h264+aac 60fps 5.5MB，画面与提示词一致 |

图片同步接口耗时 18~21 秒（1k/low）——transport 超时默认已调为 60s（源项目同款），冒烟时给 180s。
**视频排队时延是重要产品输入**：4 秒 480p 小样在渠道侧排了约 44 分钟（自动路由高峰拥堵），远超生成本身耗时；产品 `PROJECTS_GEN_POLL_TIMEOUT_SECONDS=7200`（2h）可覆盖，但前端「制作中」的用户预期与片段串行总时长估算必须按「排队分钟级～小时级」设计，SKU 上线前建议再实测不同时段的时延分布。

## 4. 环境坑（仅开发机，不影响生产设计）

1. **本机代理 TUN fake-IP 模式**：一切域名（含对外 DNS 查询）被解析成 `198.18.x.x` 保留网段，`engine/net` 的 SSRF 防护会正确拒绝下载上游结果。防护不改；`modelhub-smoke.js` 内检测到 fake-IP 时改用阿里 DoH（`https://223.5.5.5/resolve`）解析真实地址。**生产 Linux 无此环境，`transfer` 默认解析器即正确行为。**
2. **代理节点抖动**：约 4 分钟窗口内到 `api.modelhub.cc` 的 TLS 握手被连续重置（5s ECONNRESET，免费 GET 也一样），自愈。脚本把这归为 `unknown` 并在账本标注「待渠道后台对账」——与产品对「提交结果未知」的口径一致。
3. macOS `os.tmpdir()`、ffmpeg drawtext 等已知坑见 handoff 历史记录，与本渠道无涉。

## 5. 对后续任务的输入

- **M2-BE-01（真实渠道接线 worker）**：
  - 图片传输超时需按分钟级（60s 起步）；图片接口为同步返回，提交「不确定」时同样按冻结对账口径处理。
  - 下载上游结果统一走 `engine/net`/`engine/transfer`（生产无 fake-IP 问题）。
  - SKU 报价以实时目录为准：seedance-2.5 三档 39/47/280 分/秒；flare 建议 `1k/medium`（23 分/张）为形象生成默认档。
  - `Idempotency-Key` 头已随 transport 发送，modelhub 是否落地该语义未见文档，重提去重不能依赖它（沿用产品「提交结果未知不自动重提」原则）。
- **M0-02 剩余验证项**（本分支只覆盖渠道接入）：30 秒多镜头 + 图片/音频参考一致性、尾帧衔接、多片段声音一致、六风格形象、每秒成本曲线 → 待后续按授权继续，用同一脚本与账本。

## 6. 本地凭据存放

`server/.env`（gitignore）含 `MODELHUB_BASE_URL` / `MODELHUB_API_KEY`，取自超搭云项目同款渠道密钥（用户 2026-10-21 指定）。运行方式：`cd server && node --env-file=.env scripts/modelhub-smoke.js <models|image|video> [参数]`。
