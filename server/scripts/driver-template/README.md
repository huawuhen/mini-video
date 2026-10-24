# __PROTOCOL__ 驱动（<协议名>）

- **能力**：`video`（TODO：模型/时长/分辨率/参考上限）
- **协议文档**：TODO（官方链接）
- **来源**：`npm run driver:new -- __PROTOCOL__` 生成

## 协议要点

TODO：鉴权方式、提交/轮询路径与字段、错误码语义、计费口径。

## 错误分类（业务层约定）

| 情形 | 行为 |
|---|---|
| 上游 4xx / 内容拒绝 | 返回 `{ status: 'failed', error: 中文提示 }` |
| 连接失败 / 429 | 抛 retryable（`submitted:false`，交队列重试） |
| 超时 / 5xx / 受理后断连 | 「结果不确定」→ unknown 冻结待对账，绝不自动重提 |

## 渠道参数

TODO。

## 测试

`driver.test.js` 共用契约套件 + 特有场景；夹具来源见 `fixtures/provenance.md`。
