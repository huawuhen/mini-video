# 夹具来源（provenance）

智谱 OpenAI Compatible 接口的响应形态，按 M2-BE-01 真实调用（2026-10-23，glm-4.6 故事理解
9 次全部成功，handoff §7 记录）的返回结构构造；文本与 token 数为测试值，不含密钥。

- `complete-accepted.json`：chat/completions 非流式成功响应（choices[0].message.content + usage）。
- `models.json`：GET {base}/models 目录形态。
