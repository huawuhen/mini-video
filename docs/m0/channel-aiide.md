# 渠道笔记：aiide（M2-BE-01 渠道切换，2026-10-23）

> 用户 2026-10-23 指定更换生成渠道为 aiide，视频模型 `dreamina-seedance-2-5-hc`、图片模型 `gpt-image-2`。
> 文档 https://aiide.apifox.cn/chinese（每页有 `.md` 版本可直读）；定价页
> https://www.aiide.com/zh/pricing/dreamina-seedance-2-5-hc 与 `/pricing/gpt-image-2`。
> 本文记录协议要点、计费口径、环境坑与未验证项。SDK 形态参考超搭云 `aiide/materials.js`。

## 1. 协议速览（2026-10-23 按文档核对）

- Base URL `https://www.aiide.com`（定价页示例也出现过 `api.aiide.com`，以可配置的 `AIIDE_BASE_URL` 兜底）；鉴权 `Authorization: Bearer <key>`。
- **视频（火山方舟 Ark 协议）**：
  - 提交 `POST /v1/video/generations`：`{ model, prompt, metadata: { content: [ {type:'image_url'|'video_url'|'audio_url', <type>:{url}, role:'reference_image'|'reference_video'|'reference_audio'} ], generate_audio, ratio, duration(整数秒), resolution('480p'|'720p'|'1080p'), watermark } }` → `{ id, task_id, object:'video', status, progress }`。
  - 轮询 `GET /v1/video/generations/{task_id}` → `{ code, message, data: { status: NOT_START|SUBMITTED|QUEUED|IN_PROGRESS|SUCCESS|FAILURE|UNKNOWN, fail_reason, data: { status: queued|running|succeeded|failed|expired, content: { video_url }, usage: { total_tokens } } } }`。
  - 坑：文档示例里**成功任务**的 `fail_reason` 字段放着成片链接（渠道字段错位），适配器在成功态下把该字段作为地址的最后候选。
- **图片（OpenAI Images，同步）**：
  - 无参考 `POST /v1/images/generations`（JSON `{model, prompt, size, n, quality?, response_format:'b64_json'}`）；
  - 有参考 `POST /v1/images/edits`（multipart，`image` 字段二进制 1~4 张）；响应 `{ data: [{ b64_json | url }], created }`。
  - `size` 取值：`1024x1024 / 1536x1024 / 1024x1536 / 2048x2048 / 2048x1152 / 3840x2160 / 2160x3840 / auto`；2K 没有竖版规格。
- **素材库（视频参考素材过审，免费）**：
  - `POST /v1/assets/upload { url, type: image|video|audio, purpose }` → `{ success, data: { asset_id: 'mat_x', status: ready|pending|failed, failure_reason? } }`；`GET /v1/assets/{asset_id}` 轮询。
  - 文档原话：「涉及人脸，虚拟人图片需走素材库接口过审，否则视频会生成失败」——**数字人形象图必须全部过素材库**，请求里以 `asset://mat_x` 引用。
  - URL 硬性要求：公网 http(s)，**路径扩展名必须与 type 匹配**（图 jpg/jpeg/png/webp/bmp/tiff/gif/heic，视频 mp4/mov，音频 wav/mp3）。为此形象图存储 key 已改为带 `.png`（落盘时按实际字节校正）。
  - 支持模型清单（素材文档内列明）含 `dreamina-seedance-2-5-hc`。试听/参考音频将来上传时 key 必须带 `.wav`/`.mp3`。

## 2. 计费与成本口径（2026-10-23 已按渠道后台实扣校准）

- 视频按 **token** 计费：`$9.63/M`（Seedance 口径 token ≈ 宽×高×帧率 24×秒 ÷ 1024，**已两次实测验证**：5s=48,437、30s=288,625，均 ≈9,6~9,7 tok/s，误差 0.3%）。后台实扣 $0.46 与折算一致。按 7.2 汇率：**480p ≈ 68 分/秒**（实测 67.2）、**720p = 151 分/秒**（实测，2026-10-24：端到端两段各 108,900 tokens/5s 一致 → 21,780 tok/s，比像素比例推算的 142.8 高 5.6%，上游按编码对齐计 token；Lead 裁决采用 151，见迁移 010）。
- 图片后台实扣 **$0.05/张**（两张合计 $0.10）→ **36 分/张**（迁移 007 估 21 偏低，008 已修正）；响应不带 usage，只能以后台扣费为准。
- **定价（迁移 008，用户 2026-10-23 授权「合理上涨 SKU」并委托定价）**：480p **100 分/秒**（1.0 元/s，毛利 32%）、720p **200 分/秒**（2.0 元/s，28.5%）、形象 **60 分/张**（40%）。依据：原 80/150/50 在 aiide 成本下毛利仅 15%/5%/28%，不足以覆盖片段失败重试（A 口径平台承担上游成本）、支付费率、存储与 LLM；90 秒成片标准 90 元、高清 180 元。
- 校准工具：`aiide-smoke.js video` 完成后自动写 `usageTokens/tokenFen` 进账本；价格调整用新 version（当前 v2）。

## 3. 适配器与装配

- `server/src/engine/providers/aiide-{materials,video,image}.js`、`image-bytes.js`；注册导出见 `providers/index.js`。
- Worker real 装配：`AIIDE_API_KEY` + LLM 三项必填；存储必须七牛（参考素材要上游可访问）。
- 错误分类（与既有渠道同口径，`segment.js` 期望）：连接失败/429/素材库暂不可用 → retryable 抛出（明确未提交）；
  渠道 4xx 拒绝/素材审核不通过 → **返回** `{status:'failed'}`（该段失败退回，不冻结）；超时/5xx/受理后断连 → unknown（冻结待对账）。
- 冒烟：`server/scripts/aiide-smoke.js`（models / image / material / video / video-query，账本 `docs/m0/cost-ledger.json`，270 元硬停）。
  端到端：`server/scripts/e2e-real.js`（aiide 装配，2×5s 480p，预估 ≈7 元）。

## 4. 真实冒烟记录（2026-10-23，用户授权「按建议跑」；账本累计估算 27.55 元 / 停止线 270 元）

| 步骤 | 调用 | 结果 | 耗时 | 费用 |
|---|---|---|---|---|
| models | `GET /v1/models` | 45 个模型，`dreamina-seedance-2-5-hc` 与 `gpt-image-2` 均在售（快照 `aiide-catalog.json`） | — | 免费 |
| ① 文生图 | `POST /v1/images/generations` 1k 1:1 | ✅ 1024×1024 PNG 1.1MB，画面与提示词（动画风格 4 岁女孩黄裙半身像）完全一致 | 35 s | 估 21 分 |
| ② 参考图 | `POST /v1/images/edits` multipart（① 的图作参考，换姿势+场景） | ✅ **人物一致性极好**（同脸/辫子/发圈/裙），姿势场景按要求改变——即生产「照片→形象」路径 | 37 s | 估 21 分 |
| ③ 素材过审 | `POST /v1/assets/upload`（七牛签名链接 `.png`）→ 轮询 | ✅ 虚拟人脸图 **22 秒 ready**；asset id 形态 `asset-<时间>-<随机>`（非文档示例 `mat_`） | 22 s | 免费 |
| ④ 视频 | `POST /v1/video/generations` 5s 480p 9:16，参考图经素材库引用，提示词含一句台词 | ✅ 480×854 / 24fps / h264 + AAC 32k 立体声 / 5.06 s，有声（峰值 -9.9 dB），抽帧人物与参考图一致；**usage.total_tokens = 48,437** | 提交→完成约 7 分钟（含排队） | 后台实扣 $0.46 |
| ⑤ 30 秒整段 | 同上，`--seconds 30`，三段式小故事提示词 | ✅ **30 秒整段被接受**（提交不报错、成片 30.08 s / 480×854 双流），`usage.total_tokens = 288,625`（9,621 tok/s，与 5s 口径一致，单价无长片溢价） | 提交→完成约 8 分钟 | 折算 2002 分（$0.4665 口径） |
| ⑥ 真人照片链路（用户提供照片） | 照片 → gpt-image-2 edits 写实形象（33 s）→ 素材库过审（28 s）→ 5s 480p 视频 | ✅ 全链路通过：**写实人像过审无门槛建议、未触发人脸认证**；视频 `usage.total_tokens = 48,437`（与 ⑥ 前的 5s 完全一致，token 消耗确定性）；成片人物与照片高度一致 | 约 11 分钟 | 36 分 + 336 分 |

- **跨境下载实测（部署风险）**：成片在火山 TOS 新加坡（`ark-acg-ap-southeast-1.tos-...volces.com`）。本机（家庭网络）下载 16.35MB 实测 **~60KB/s，safeFetch 与 curl 直连一致**（≈4.5 分钟/30 秒片）——慢在跨境线路不在实现；用户在 aiide 后台预览流畅是走了 aiide 自己的链路。**生产部署必须在服务器上实测该下载速度**：Worker 下载超时当前写死 300 秒（`segment.js`），720p 30 秒片约 40MB，若服务器跨境带宽同样差需把超时配置化并放宽（失败会走队列重试，URL 已知不会重复计费）。
- 成片下载域：`safeFetch` 直连拉取成功（本机无需 DoH 绕行）；参考图过审在视频提交内自动完成，素材库免费。
- 本轮（④⑤）七牛测试对象已清理。

## 5. 未验证项

1. ~~720p 真实 token~~ **已实测（2026-10-24，M2-BE-03-e2e）**：5 秒段 108,900 tokens ×2 一致 → 151 分/秒（见上）。
2. **生产服务器的成片下载带宽**（见 §4 跨境下载实测；Worker 下载超时已配置化 `PROJECTS_VIDEO_DOWNLOAD_TIMEOUT_MS`）。
3. 多参考照片（edits 支持 1~4 张，`GENERATION_IMAGE_MAX_REFERENCES` 可开，未实测）。
4. 真人照片过审的**长期稳定性**：单次实测通过（28 s）不代表后续不触发平台人脸认证或人像审核收紧——上线后留意 `aiide_video_material_rejected` 日志。
