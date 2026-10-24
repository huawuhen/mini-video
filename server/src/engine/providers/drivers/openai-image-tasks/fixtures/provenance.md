# 夹具来源（provenance）

按喵呜渠道接入时（2026-10-22，M2-BE-01 分支）按官方文档构造并真实验证过的响应形态平移
（原 server/test/engine/miaowuai.test.js 假上游样本）；链接与任务号为测试值，不含密钥。
该渠道自 2026-10-23 起为备用（用户决定保留），本轮未发起真实调用。

- `generate-accepted-pending.json` → `generate-accepted-ready.json`：提交 + 轮询到 ready 的两步序列
  （驱动测试按顺序回放；内容地址为站内相对路径 `/v1/images/{id}/content`，需 Bearer 下载）。
- `generate-rejected.json`：4xx 明确拒绝形态。
