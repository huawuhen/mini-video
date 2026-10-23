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

## 2. 计费与成本口径（2026-10-23 真实冒烟已校准 token 公式；真实扣费金额以渠道后台为准）

- 视频按 **token** 计费：`$9.63/M`（输入=输出同价；Seedance 口径 token ≈ 宽×高×帧率 24×秒 ÷ 1024）。按 7.2 汇率折算：
  - **实测**：5 秒 480p 9:16 → `usage.total_tokens = 48,437`（≈ 9,687 tok/s；公式估 9,720，误差 0.3%，**公式成立**）→ ≈ 336 分 / 5 秒 = **67.2 分/秒**；SKU `cost_fen=68` 不用改。
  - 720p 9:16（704×1248）按像素比例 2.12× → ≈ 20,520 tok/s → **≈143 分/秒**（未实测，公式已验证可信）。
  - ⚠ 对照：喵呜 38/63 分、modelhub 39/47 分。现售价 80/150 分/秒在 aiide 成本口径下毛利约 15%/5%——**售价须用户重新决策**（迁移 007 注释同样标注）。
- 图片按 token 计费：输入 $3.5~4.5/M、输出 $21~27/M（`gpt-image-official` 分组 7 折 / `Official API Key` 9 折，控制台看 Key 分组）。响应不带 usage，1024×1024 中档 ≈1,056 输出 token → **≈16~21 分/张**（估算，核对后台扣费校准）。
- 校准方法：`aiide-smoke.js video` 完成后打印 `usage.total_tokens` 并写入账本 `usageTokens/tokenFen`；与渠道后台实际扣费对照后若有偏差，以新迁移更新 `skus.cost_fen`。
- `/v1/models` 无价格字段：price_audit 只做模型存在性校验（同喵呜口径），价格快照人工维护。

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
| ④ 视频 | `POST /v1/video/generations` 5s 480p 9:16，参考图经素材库引用，提示词含一句台词 | ✅ 480×854 / 24fps / h264 + AAC 32k 立体声 / 5.06 s，有声（峰值 -9.9 dB），抽帧人物与参考图一致；**usage.total_tokens = 48,437** | 提交→完成约 7 分钟（含排队） | 估 337 分 / token 折算 336 分 |

- 成片下载域：`ark-acg-ap-southeast-1.tos-ap-southeast-1.volces.com`（火山 TOS 新加坡），`safeFetch` 直接拉取成功；本机无需 DoH 绕行。
- 过审参考图在视频提交内再注册一次（新进程缓存为空）也只用了几秒；素材库免费，重复注册无成本。
- 本次 2 个七牛测试对象（`miv-test/m0/`）已清理。

## 5. 未验证项

1. `dreamina-seedance-2-5-hc` 是否真收 **30 秒整段**（SKU durations 沿用 {5,10,15,30}；不支持会 400 → 片段失败）。约 20 元一次，待用户单独授权。
2. **720p 真实 token**（公式已在 480p 验证，按像素比例推算 143 分/秒）。
3. 图片的真实扣费（响应无 usage，只能看后台）；`quality` 缺省未传，当前默认档位出图质量已足够好。
4. 素材过审对**真人照片**的表现（本次是 AI 虚拟人脸；真人照片可能触发平台人脸认证要求）；过审耗时在高峰期的分布。
5. 端到端 `e2e-real.js`（≈7 元）与多参考照片（edits 1~4 张，`GENERATION_IMAGE_MAX_REFERENCES`）。
