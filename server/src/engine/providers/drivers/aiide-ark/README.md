# aiide-ark 驱动（火山方舟视频协议 + 素材库过审，经 aiide 网关）

- **能力**：`video`（dreamina-seedance-2-5-hc；480p/720p/1080p；5/10/15/30 秒；原生音频；参考图 ≤30、参考音频 ≤10）
- **协议文档**：https://aiide.apifox.cn/chinese/464722026e0（提交）、464722027e0（轮询）、492968369e0 / 492968371e0（素材库）
- **来源**：M2-BE-01 的 `aiide-video.js` / `aiide-materials.js` 平移（真实冒烟与端到端已验证，`docs/m0/channel-aiide.md`）

## 协议要点

1. 提交 `POST /v1/video/generations`，参考素材放在 `metadata.content[]`（`image_url`/`video_url`/`audio_url` + `role`）。
2. **人脸/虚拟人参考图必须先经素材库过审**（`POST /v1/assets/upload` → 轮询 `GET /v1/assets/{id}` 到 `ready`），
   以 `asset://mat_xxx` 引用，否则视频生成失败。素材 URL 必须公网可达且扩展名与类型匹配。
3. 轮询 `GET /v1/video/generations/{task_id}`：状态双层（外层 `SUCCESS/FAILURE/...`，内层 `succeeded/failed/...`）；
   成功态的 `fail_reason` 字段偶发错放成片链接（渠道侧字段错位），驱动已兜底。
4. 按 token 计费（$9.63/M，2026-10-23 定价页核对）：`usage.total_tokens` 透传给上层记账
   （5s 480p 实测 48,437 tokens ≈ 67.2 分，`provider_channels.cost_fen` 按 68 分/秒登记）。
5. `GET /v1/models` 免费目录，供 `channel:test` 与存在性对账。

## 错误分类（业务层约定）

| 情形 | 行为 |
|---|---|
| 上游 4xx / 素材审核不通过 | 返回 `{ status: 'failed', error: 中文提示 }`（该段失败退回，不冻结） |
| 连接失败 / 429 / 素材库 5xx、等待超时 | 抛 `ProviderError`（`submitted:false, retryable:true`，交队列重试） |
| 提交超时 / 5xx / 受理后断连 | 抛 `ProviderError`（`submitted:true`）→ 任务 unknown，冻结待对账，**不自动重提** |
| 查询网络失败 | 抛 retryable（任务仍在渠道侧，`gen.poll` 继续轮询，绝不因查询失败冻结） |

## 渠道参数（`provider_channels`）

- `base_url`：网关地址（如 `https://www.aiide.com`）
- `credential`：API Key（Bearer）
- `model_map`：`{ "video": "dreamina-seedance-2-5-hc" }`
- `params`（均可省略）：`generateAudio`(true)、`watermark`(false)、`requestTimeoutMs`(180000)、
  `materialsPollIntervalMs`(2000)、`materialsPollTimeoutMs`(180000)、`materialsPurpose`
- `cost_fen`：`{ "video.480p": 68, "video.720p": 143 }`（分/秒；实扣口径见迁移 008 注释）

## 测试

`driver.test.js` = 共用契约套件（`../../contract-test.js`，夹具回放零费用）+ 素材过审/usage/兜底特有场景。
夹具来源见 `fixtures/provenance.md`。

## 未验证（诚实声明）

- 契约测试全部为样本回放；本轮未发起真实渠道调用（真实冒烟结论沿用 M2-BE-01 记录）。
- 720p 真实 token 未实测（成本按像素公式推算，公式已三次验证——handoff §3 2026-10-24 裁决①）。
