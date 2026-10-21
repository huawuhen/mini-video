# engine（Engine 角色）

从超搭云 `/root/chaodayun@2926b42` 迁移并适配，规则与来源清单见 `docs/ARCHITECTURE.md §6`。每个复制的文件头部写 `// Source: chaodayun@2926b42 <原路径>`。

对外接口以 `docs/ARCHITECTURE.md §5` 为准（改动走 `CODEX_HANDOFF.md` 变更申请）：

| 子目录 | 导出 | 说明 |
|---|---|---|
| `story/` | `createStoryAgent({ llm, logger, skills })` → `{ expandIdea, understand, bindPrompts }`；`classifyInput` | 时长只取 `allowedDurations`，总时长 ≤ `maxSeconds`；宽容解析 + 严格校验 + 2 次修复 + 确定性兜底（`degraded: true`）；支持 `{ signal, timeoutMs }`（默认每次调用 90 秒） |
| `skills/` | `createSkillRegistry([...])` → `get(skillId)` / `forModel(model)`；`wan30Skill`、`genericSkill`、`defineSkill` | 每个视频模型一个 Skill（提示词、模板、校验、默认值）；未知模型回退 `generic`；M0 假设全部在 `limits` 里可配置 |
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

### 第 1 步：判定与扩写（`project.understand` job 内、LLM 之前）

```js
import { classifyInput } from '…/engine/story/index.js';   // 或 engine/story/expand.js
classifyInput(text, { ideaCharThreshold })  // → 'idea' | 'script'；确定性；阈值默认 60 字，从 config 传入
// 'idea'  → agent.expandIdea({ idea, style, maxSeconds, allowedDurations, characters, skillId, signal, timeoutMs })
//          → { title, script, usage, degraded }；script 写入 projects.story.script，原想法保留在 projects.story_text
// 'script' → 直接 understand；用户在确认点 A 编辑后的文字一律按 'script' 处理
```

一次整理（判定 + 可能的扩写 + understand）合计 1 次免费次数；`expandIdea` 返回的 `degraded` 表示扩写失败、已用想法原文兜底。

### 第 2 步：`understand` 输出

```js
{ title, synopsis, compressed, notice?, degraded, totalSeconds, segmentCount, usage,
  script, inputKind: 'idea'|'script', expanded: boolean,
  bible: { mood,                                                     // 英文 ≤8 词
           characters: [{ castIndex, handle, brief }],               // 英文唯一简称 + ≤25 词外观
           scenes: [{ id, nameZh, description }],                    // 英文 ≤50 词，一经写出只读
           props: [{ id, nameZh, description }] },                   // 可为空数组
  cast: [{ name, description, gender, ageGroup, characterId?, voiceId? }],
  segments: [{ durationSeconds, plot, cameraNotes, dialogue: [{ castIndex, line }],
               ambience, transition: 'prev_tail'|'hard_cut', castIndexes,
               sceneId, propIds, endState, takeMode: 'multi_shot'|'single_take' }] }
```

- `bible` 写入 `projects.story.bible`（jsonb），之后**只读**：重拍片段直接复用，不重新生成。
- `script` = 本次处理的剧本全文（剧本模式即用户输入；想法模式为扩写结果），写入 `projects.story.script`。
- `endState` 为英文（≤50 词，归一化已截断）；`takeMode` 缺省 `multi_shot`。

### 第 3 步：`bindPrompts`（每段一次镜头时间线调用）

```js
bindPrompts({ style, ratio, segments, cast, bible, voicesEnabled, skillId, maxImageRefs, signal, timeoutMs })
  → [{ segmentIndex, prompt, imageRefs, audioRefs, usePrevTail, droppedRefs,
       startState, endState, shots, skillId, skillVersion, degraded }, …]   // 数组上另挂 usage
```

| bindPrompts 字段 | 来源 |
|---|---|
| `skillId` | 调用方按视频 SKU 的 `model` 用 `skills.forModel(model).id` 取得；缺省 `wan-3.0` |
| `cast[].id` | BE-05 生成（如 `cast_` 前缀），顺序须与 `understand` 的 `cast` 一致（`bible.characters[].castIndex` 按同一顺序对应） |
| `cast[].lookImageKey` | 确认点 B 锁定的形象版本图片 key（数字资产库） |
| `cast[].refAudioKey` | 确认点 B 锁定音色的参考音频 key；`voicesEnabled=false` 或只有 1 段时不传 |
| `segments[]` | `understand` 输出原样（`durationSeconds` 必填；对白可用 `castId` 或 `castIndex` 指明说话人） |
| `bible` | `projects.story.bible` 原样；缺失时用确定性回退（handle 变 `character N`，仍为英文） |
| `maxImageRefs` | 缺省取 Skill 的 `limits.maxImageRefs`（Wan 3.0 为 9） |

行为约定：

- 最终提示词 `prompt` 由 Skill 的 `assemble` **逐字拼装**（风格、场景、道具、人物外观、连贯性、写实与避坑模板不经过 LLM 改写）；对白由代码嵌入（`某 handle says in Mandarin Chinese, {delivery}: 「原句」`），镜头里出现才加 `Lip sync.`，全段无对白写 `No dialogue.`。
- **图片编号与提交顺序一致**：视频适配器的提交顺序是 `[tailRef, ...imageRefs]`（`modelhub-video` 尾帧排最前），所以 `usePrevTail=true` 时提示词 `图1` 写「上一段的最后一帧」、人物形象图从 `图2` 开始，调用方把尾帧图片作为第 1 张参考图提交（`omni_reference` 普通参考，尽力而为，不保证首帧衔接）；无尾帧时人物从 `图1` 开始。`usePrevTail=true` 时形象图预算已减 1（`droppedRefs` 计入裁剪数）。跨模块一致性有专门测试：`server/test/engine/skill-provider-numbering.test.js`。
- `音色参考音频M` 编号 = `audioRefs` 顺序（按说话次数排序）。
- `startState` = 上一段 `endState`（仅 `transition: 'prev_tail'`），已写入返回与 `final_prompt`。
- `ratio` 参数保留但**不进提示词正文**（画幅由生成请求的 ratio 字段表达）。
- 剧本忠实模式有确定性兜底检查：`inputKind: 'script'` 或 `expanded: true` 时，`understand` 逐句比对每条对白（去空白与标点后）必须出现在 `storyText` 原文中，否则判校验失败进修复重试；`inputKind: 'idea'`（未扩写）跳过。
- `degraded: true` 表示该段镜头时间线 LLM 修复 2 次仍不合法，已用单镜头兜底（剧情直述 + 对白照嵌），日志有 `shot_timeline_fallback`。
- 保存：`segments.final_prompt`（jsonb）= `{ prompt, imageRefs, audioRefs, usePrevTail, startState, endState, shots, skillId, skillVersion, degraded }`，无需新增数据库列。
- 重拍单个片段：用保存的 `bible` 与上一段 `endState` 再次调用 `bindPrompts` 只传该段即可（`usePrevTail` 由该段 `transition` 决定）。

### Skill 的 limits（全部可配置，M0 验证后调整）

`minShotSeconds/maxShotSeconds=3/8`（对白镜头可到 `maxDialogueShotSeconds=10`）、镜头数按段长查表（30 秒 4~8、15 秒 2~4、≤10 秒 1~2；`single_take` 为 1 镜且不受逐镜头时长上限约束）、`preferredSegmentSeconds=30`、`dialogueCharsPerSecond=3.5`、`maxChars=2500`、`maxImageRefs=9`、`promptLanguage=en`（英文主体 + 中文对白原句）。

## 七牛 Kodo 真实桶联调结论（M2-OPS-02，2026-10-21）

环境：桶 `redith`（区域 `z0` 华东-浙江，官方 `GET api.qiniu.com/v4/query?ak=…&bucket=…` 免费查询），CDN 下载域名 `cdn.redith.cn`（HTTPS 证书有效），key 前缀 `miv-test/`，联调后已清理测试对象。脚本 `scripts/qiniu-smoke.js`（手动运行，账本 `server/.data/qiniu-cost-ledger.json`，估算累计 **8 分**，停止线 1600 分）。

| 清单项 | 结果 | 结论 |
|---|---|---|
| 表单上传（小对象） | ✅ | ≤8MB 走表单上传，`Content-Type` 原样保存（`text/plain; charset=utf-8`），`stat.fsize` 一致 |
| 分片上传 v2（10MiB） | ✅ | 引擎自动切 3×4MB 分片，范围读（`Range`）字节与总长一致 |
| 分片失败 → abort | ✅ | 注入第 2 片 500：抛 `StorageError`、自动 `DELETE` abort、对象不落桶（`stat` 612） |
| 签名下载（含中文与空格的 key） | ✅ | `encodeKey` 的逐段百分号编码 + 签名与七牛真实验签一致（此前 ENG-03 遗留疑问，确认无需修改 `signedUrl`） |
| `attname` 文件名 | ✅ | 响应含 `Content-Disposition: attachment` 且文件名正确（key 含空格/中文均可） |
| 删除（含对象不存在） | ✅ | 存在对象删除成功；612 视为已删不报错 |
| 过期签名 401 / 无 token 拒绝 | ⛔ 未验证 | **桶 `redith` 是公开空间（`private: 0`）**：token 被完全忽略，过期/无 token 一律 200。该项只在私有桶上可验证 |
| 上传凭证真实验签 | ✅ | 上传在任何桶上都强制 UpToken，S1~S5 即真实验签通过 |

要点与遗留：

1. **上传域名**：引擎拼 `up-z0.qiniup.com`，实测可用（官方查询返回的规范名是 `upload.qiniup.com`，两者等价）。区域务必配置正确：`QINIU_REGION=z0`（`config.js` 缺省 `''` 会导致拼出非法域名 `up-.qiniup.com`，生产部署必须显式设置）。
2. **待用户决策（handoff §4）**：产品要求私有空间（签名下载才有意义），`redith` 需改为私有（会影响桶内既有对象的公开直链——桶里已有其他实验项目的 `generated/video/*` 对象），或为本项目新建独立私有桶。桶转私前后一天内，本脚本 S6/S7 两项应重跑补验证（下载 token 的真实验签目前未在真实桶上确认过；签名算法本身有已知答案向量单测覆盖）。
3. **CDN 缓存提醒**（桶转私有后需在七牛控制台确认）：若 CDN 域名的缓存 key 配置为「忽略参数」，带过期 token 的请求可能命中此前缓存的有效响应；私有内容建议缓存 key 含完整参数或对私有路径配置不缓存。
4. **生产桶建议与 `redith` 隔离**：该桶已被其他项目使用，产品对象（形象图、作品视频）应使用独立桶或至少独立前缀，避免清理/权限互相影响。
5. 管理接口（`stat`/`list`，QBox 旧版签名）在真实桶可用（脚本对账与清理已使用）；产品代码仍只依赖 `put / signedUrl / remove`。
