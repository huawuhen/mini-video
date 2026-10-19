# engine（Engine 角色）

从超搭云 `/root/chaodayun@2926b42` 迁移并适配，规则与来源清单见 `docs/ARCHITECTURE.md §6`。每个复制的文件头部写 `// Source: chaodayun@2926b42 <原路径>`。

对外接口以 `docs/ARCHITECTURE.md §5` 为准（改动走 `CODEX_HANDOFF.md` 变更申请）：

| 子目录 | 导出 | 说明 |
|---|---|---|
| `story/` | `createStoryAgent({ llm, logger })` → `{ understand, bindPrompts }` | 时长只取 `allowedDurations`，总时长 ≤ `maxSeconds`；宽容解析 + 严格校验 + 2 次修复 + 确定性兜底（`degraded: true`）；支持 `{ signal, timeoutMs }` |
| `llm/` | `createPiLlm({ model, streamFn })`、`createMockLlm(script)` | 最小接口 `complete({ system, messages, signal }) → { text, usage }`；测试用脚本化模拟 |
| `providers/` | `createRegistry([...adapters])`、Modelhub Wan 3.0 / Seedance 2.5 / 图片适配器、`createImageProvider` | `prepare / submit / query / normalize`；视频固定 `omni_reference`，`tailRef` 作为普通参考图排在最前，尽力而为，不保证首帧衔接；图片参考只取第一张 |
| `storage/` | `createStorage(config)` → `{ put, signedUrl, remove }`；`memory` 实现 | 七牛 Kodo 私有空间 + 签名链接 |
| `transfer/` | `transferFromUrl(...)` | 上游临时链接 → 七牛，经 `net` 校验 |
| `net/` | `safeFetch(url, { maxBytes, timeoutMs })` | SSRF / 大小 / 超时，可注入模拟网络 |
| `extract/` | `extractText(buffer, mime)` | txt / docx |

- 所有外部依赖（HTTP、时钟、存储）通过参数注入；单测不得访问外网、不产生真实费用。
- 不读取 `process.env`，配置从 `src/config.js` 传入（需要新变量时登记到 `config.js` 与 `.env.example`）。
- `scripts/story-smoke.js` 是 M0/M2 授权后的真实大模型冒烟脚本，默认不运行、不参与测试。

## story 输入输出字段对应（BE-05 依赖）

`understand` 输出：

```js
{ title, synopsis, compressed, notice?, degraded, totalSeconds, segmentCount, usage,
  cast: [{ name, description, gender, ageGroup, characterId?, voiceId? }],
  segments: [{ durationSeconds, plot, cameraNotes, dialogue: [{ castIndex, line }],
               ambience, transition: 'prev_tail'|'hard_cut', castIndexes }] }
```

`bindPrompts` 输入与上述输出的对应关系：

| bindPrompts 字段 | 来源 |
|---|---|
| `cast[].id` | BE-05 生成（如 `cast_` 前缀），顺序须与 `understand` 的 `cast` 一致 |
| `cast[].lookImageKey` | 确认点 B 锁定的形象版本图片 key（数字资产库） |
| `cast[].refAudioKey` | 确认点 B 锁定音色的参考音频 key；`voicesEnabled=false` 时不传 |
| `segments[].castIds` | 每段出场角色，可用 `understand` 的 `castIndexes` 映射为 `cast[].id` |
| `segments[].dialogue[].castId` | 说话人；缺省时回退 `cast[line.castIndex].id` |
| `segments[].transition` | 原样来自 `understand`；`bindPrompts` 只映射 `usePrevTail` |

`bindPrompts` 输出：`[{ segmentIndex, prompt, imageRefs, audioRefs, usePrevTail, droppedRefs }, …]`（数组上另挂 `usage` 汇总）。`usePrevTail=true` 时内部已为尾帧预留 1 个参考图位置。
