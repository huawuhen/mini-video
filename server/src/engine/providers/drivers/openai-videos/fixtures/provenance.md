# 夹具来源（provenance）

按喵呜渠道接入时（2026-10-22，M2-BE-01 分支）按官方文档构造并经真实渠道验证过的响应形态平移
（原 server/test/engine/miaowuai.test.js 的假上游样本）；链接与任务号为测试值，不含密钥。
该渠道自 2026-10-23 起为备用（用户决定保留），本轮未发起真实调用。

- `submit-accepted.json` / `submit-rejected.json`：POST /v1/videos 响应形态。
- `query-running.json` / `query-succeeded.json` / `query-failed.json`：GET /v1/videos/{id} 轮询形态
  （succeeded 含站内相对路径补全与第三方直链两种取值来源，见 driver.test.js）。
