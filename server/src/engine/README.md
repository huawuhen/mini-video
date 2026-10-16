# engine（Engine 角色）

从超搭云 `/root/chaodayun@2926b42` 迁移并适配，规则与来源清单见 `docs/ARCHITECTURE.md §6`。每个复制的文件头部写 `// Source: chaodayun@2926b42 <原路径>`。

对外接口以 `docs/ARCHITECTURE.md §5` 为准（改动走 `CODEX_HANDOFF.md` 变更申请）：

| 子目录 | 导出 | 说明 |
|---|---|---|
| `story/` | `createStoryAgent({ llm })` → `{ understand, bindPrompts }` | pi agent；时长只取 `allowedDurations`，总时长 ≤ `maxSeconds`；单片段不出音频参考 |
| `llm/` | `createLlm(config)`、`createMockLlm(script)` | LLM 调用；测试用模拟 |
| `providers/` | `createRegistry([...adapters])`、`mock` 适配器 | `prepare / submit / query / normalize`；图片 + 音频参考、首帧 |
| `storage/` | `createStorage(config)` → `{ put, signedUrl, remove }`；`memory` 实现 | 七牛 Kodo 私有空间 + 签名链接 |
| `transfer/` | `transferFromUrl(...)` | 上游临时链接 → 七牛，经 `net` 校验 |
| `net/` | `safeFetch(url, { maxBytes, timeoutMs })` | SSRF / 大小 / 超时，可注入模拟网络 |
| `extract/` | `extractText(buffer, mime)` | txt / docx |

- 所有外部依赖（HTTP、时钟、存储）通过参数注入；单测不得访问外网、不产生真实费用。
- 不读取 `process.env`，配置从 `src/config.js` 传入（需要新变量时登记到 `config.js` 与 `.env.example`）。
