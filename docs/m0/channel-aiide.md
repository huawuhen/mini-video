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

## 2. 计费与成本口径（估算，待真实 usage 校准）

- 视频按 **token** 计费：`$9.63/M`（输入=输出同价；Seedance 口径 token ≈ 宽×高×帧率 24×秒 ÷ 1024）。按 7.2 汇率折算：
  - 480p 9:16（480×864）≈ 9,720 tok/s → **≈68 分/秒**；720p 9:16（704×1248）≈ 20,592 tok/s → **≈143 分/秒**。
  - ⚠ 对照：喵呜 38/63 分、modelhub 39/47 分。现售价 80/150 分/秒在 aiide 成本口径下几乎没有毛利——**售价须用户重新决策**（迁移 007 注释同样标注）。
- 图片按 token 计费：输入 $3.5~4.5/M、输出 $21~27/M（`gpt-image-official` 分组 7 折 / `Official API Key` 9 折，控制台看 Key 分组）。1024×1024 中档 ≈1,056 输出 token → **≈16~21 分/张**。
- 校准方法：`aiide-smoke.js video` 完成后打印 `usage.total_tokens`，与渠道后台实际扣费对照，再以新迁移更新 `skus.cost_fen`。
- `/v1/models` 无价格字段：price_audit 只做模型存在性校验（同喵呜口径），价格快照人工维护。

## 3. 适配器与装配

- `server/src/engine/providers/aiide-{materials,video,image}.js`、`image-bytes.js`；注册导出见 `providers/index.js`。
- Worker real 装配：`AIIDE_API_KEY` + LLM 三项必填；存储必须七牛（参考素材要上游可访问）。
- 错误分类（与既有渠道同口径，`segment.js` 期望）：连接失败/429/素材库暂不可用 → retryable 抛出（明确未提交）；
  渠道 4xx 拒绝/素材审核不通过 → **返回** `{status:'failed'}`（该段失败退回，不冻结）；超时/5xx/受理后断连 → unknown（冻结待对账）。
- 冒烟：`server/scripts/aiide-smoke.js`（models / image / material / video / video-query，账本 `docs/m0/cost-ledger.json`，270 元硬停）。
  端到端：`server/scripts/e2e-real.js`（aiide 装配，2×5s 480p，预估 ≈7 元）。

## 4. 未验证项（真实冒烟后补）

1. `dreamina-seedance-2-5-hc` 是否真收 30 秒整段（SKU durations 沿用 {5,10,15,30}；不支持会 400 → 片段失败）。
2. usage.total_tokens 与后台扣费的实际关系（校准 cost_fen）。
3. 素材库过审耗时分布（轮询上限 180 秒，超时按未提交可重试）；过审失败率（真人照片可能触发人脸认证要求，见超搭云报错文案）。
4. gpt-image-2 的 `quality` 缺省是否可用（当前不传；冒烟可试 `auto/standard/hd`）。
5. `/v1/models` 是否需要鉴权（price_audit 带了 Bearer）。
6. 多参考照片（edits 支持 1~4）——用户 2026-10-17 决定先用 1 张，`GENERATION_IMAGE_MAX_REFERENCES` 可开。
