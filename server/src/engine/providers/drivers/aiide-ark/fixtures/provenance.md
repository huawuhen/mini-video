# 夹具来源（provenance）

按 M2-BE-01 真实冒烟与端到端（2026-10-23/24，docs/m0/channel-aiide.md §4）录制的响应形态构造；
链接、任务号、asset id 已替换为测试值，不含密钥与真实上游临时链接。未经真实渠道回放校验的部分
在 README「未验证」一节注明。

- `submit-accepted.json`：真实提交响应形态（`id`/`task_id` 同值，object=video）。
- `submit-rejected.json`：真实 4xx 拒绝形态（error.message 中文文案按渠道后台实测样例构造）。
- `query-running.json` / `query-succeeded.json` / `query-failed.json`：真实轮询双层状态形态
  （外层 SUCCESS/FAILURE，内层 succeeded/failed；成功含 content.video_url 与 usage.total_tokens——
  5s 480p 实测 48,437 tokens，此处取测试值）。
- `models.json`：`GET /v1/models` 目录形态（真实冒烟 45 个模型在售，此处取样例）。
