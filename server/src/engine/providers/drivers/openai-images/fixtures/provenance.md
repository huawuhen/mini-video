# 夹具来源（provenance）

按 M2-BE-01 真实冒烟（2026-10-23/24，docs/m0/channel-aiide.md §4：文生图 35s、参考图 edits 37s、
人物一致性极好）录制的 OpenAI Images 响应形态构造；b64_json 载荷替换为 1x1 测试 PNG，
链接与任务字段为测试值，不含密钥。

- `generate-accepted.json`：generations/edits 同步成功响应（data[0].b64_json）。
- `generate-rejected.json`：4xx 明确拒绝形态（error.code/message 按渠道后台实测样例构造）。
- `generate-gateway-timeout.json`：Cloudflare 网关 524 掐断形态（HTML 文本体；真实端到端
  第二个形象实测 125 秒 524 一次、重试后成功——handoff §7 2026-10-23 端到端记录）。
- `models.json`：`GET /v1/models` 目录形态（与 aiide-ark 网关同目录，真实冒烟 45 个模型在售）。
