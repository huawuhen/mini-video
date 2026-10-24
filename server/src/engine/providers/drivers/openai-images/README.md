# openai-images 驱动（OpenAI Images 同步图片协议）

- **能力**：`image`（gpt-image-2；1k/2k/4k → OpenAI size；参考照片 ≤4，产品缺省 1）
- **协议文档**：https://aiide.apifox.cn/chinese/464722004e0（generations）、464722005e0（edits）
- **来源**：M2-BE-01 的 `aiide-image.js` 平移（真实冒烟与端到端已验证，`docs/m0/channel-aiide.md`）

## 协议要点

1. 无参考照片 `POST /v1/images/generations`（JSON）；有参考照片 `POST /v1/images/edits`（multipart，
   参考照片经注入的 `loadReference(key)` 签名下载后以文件字节上传）。
2. 同步返回（实测 20~110 秒），`response_format: 'b64_json'`；渠道改返回 `url` 时经 `downloadImage` 受控下载。
3. **网关超时重试（Lead 2026-10-24 裁决②）**：该同步接口在 Cloudflare 后面，约 100 秒被网关掐断
   （HTTP 524/504）。响应状态 524/504 时驱动内部自动重试，**最多 2 次**（硬上限）；重试成本平台承担，
   用户只按一次计费；逐次记入尝试记录（返回 `attempts`，处理器写入 `gen_tasks.result`）。
   非 524/504 的 5xx 与本端超时**不重试**（受理结果不确定，按 unknown 冻结待对账，绝不自动重提）。
4. 分辨率档映射：`1k/2k/4k`（兼容 `1080p` 等别名）× 画幅 → OpenAI `size`；不支持的组合判
   `PROVIDER_INPUT_INVALID`（返回 failed）。

## 错误分类

| 情形 | 行为 |
|---|---|
| 上游 4xx / 输入不合法 | 返回 `{ status: 'failed', error: 中文提示, attempts }` |
| 连接失败 / 429 / 参考照片读取失败 | 抛 retryable（`submitted:false`，交队列重试，上游零调用） |
| 提交超时 / 5xx / 524/504 重试耗尽 | 返回 `{ status: 'unknown', attempts }`（同步生成可能已计费，冻结待对账） |

## 渠道参数

- `model_map`：`{ "image": "gpt-image-2" }`；`params`：`resolution`(1k)、`ratio`(1:1)、`quality`(不传)、
  `maxReferences`(1)、`requestTimeoutMs`(180000)、`gatewayRetryMax`(2，硬上限 2)
- `cost_fen`：`{ "image.look": 36 }`（分/张；实扣 $0.05/张 × 7.2 汇率，迁移 008 注释）

## 测试

`driver.test.js` = 共用契约套件 + 524/504 重试、edits/generations 分支、参考照片裁剪与读取失败、
URL 结果下载重试、sizeFor 映射。夹具来源见 `fixtures/provenance.md`。

## 未验证（诚实声明）

- 契约测试全部为样本回放；本轮未发起真实渠道调用（真实结论沿用 M2-BE-01：524 重试一次成功的真实
  端到端案例见 handoff §7 2026-10-23 端到端记录）。
