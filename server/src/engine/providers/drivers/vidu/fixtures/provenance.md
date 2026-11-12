# 夹具来源（provenance）

按 Vidu 开放平台官方文档（platform.vidu.cn/docs，2026-11-12 核对）各接口示例响应形态构造；
任务号、链接、积分值已替换为测试值，不含密钥与真实上游临时链接。未经真实渠道回放校验的部分
在 README「未验证」一节注明。

- `submit-accepted.json`：`POST /ent/v2/reference2video` 200 响应形态（task_id + state=created + credits）。
- `submit-rejected.json`：4xx 拒绝形态（`{ code, message }`，错误码取自官方错误码清单）。
- `query-running.json` / `query-succeeded.json` / `query-failed.json`：`GET /ent/v2/tasks/{id}/creations`
  轮询形态（state=processing / success+creations[].url+credits / failed+err_code）。
- `credits.json`：`GET /ent/v2/credits` 余额形态（remains[].credit_remain/concurrency_limit + packages）。
