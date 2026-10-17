# Modelhub 响应夹具来源

这些 JSON 文件是测试输入，不是生产抓包，也不含真实用户数据或密钥。

- `modelhub-video-qa.json` 的 `submit`、`running`、`succeeded` 形状来自超搭云参考提交 `2926b42` 的 `test/helpers/qa-server.js` 本地假上游；`failed` 按同一仓库 `backend/task-routes.js` 接受的 `status/error.message` 结构构造。视频成功还可能使用 `result.url`，这是参考仓库 README 与宽容解析器记载的兼容形状，不代表供应商保证返回。公网 Modelhub quick-start 仅确认 `POST /v1/videos/generations` 和 `GET /v1/videos/tasks/{id}` 路径，没有完整响应 JSON 样本。
- `modelhub-video-url-candidates.json` 逐项构造自 `2926b42` 的 `backend/providers.js` `getVideoUrl()` 候选位置，是宽容解析的兼容夹具，**不代表每个位置均由 Modelhub 返回**。
- `modelhub-image-qa.json` 的成功形状 `data[].url` 来自 `2926b42` 的 `dimensio-image-generation.js` `resultFromResponse()` 与对应单测；失败形状是本地错误兼容测试构造。

真实 Modelhub 响应、Seedance 2.5 具体渠道差异及模型费用均未验证；M2 经用户授权后才能实测并固化。测试仅调用本机假 HTTP 服务。
