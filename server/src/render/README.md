# render（Render 角色）

FFmpeg 成片合成与片段技术验收，只在 Worker 进程运行。接口以 `docs/ARCHITECTURE.md §5` 为准，
行为见 PRD §4.3、§4.4。所有外部依赖（ffmpeg/ffprobe 可执行文件、水印资产）通过参数注入或缺省值
提供，**不读 `process.env`**；不调用任何模型，不产生真实费用。

```js
import { createRender } from '…/src/render/index.js';

const render = createRender({
  ffmpegPath: 'ffmpeg',          // 可注入绝对路径
  ffprobePath: 'ffprobe',
  timeoutMs: 300_000,            // compose 单次上限；inspect 每趟 120 秒、封面/尾帧 60 秒
  watermarkPath: '…/render/assets/ai-mark.png',  // 显式标识 PNG（缺省内置资产）
  metadataMark: 'AI生成内容',      // 元数据隐式标识（写入 MP4 comment）
  drawtextFontFile,               // 可选：注入中文字体文件后，显式标识改走 drawtext（可自定义文案）
  logger,
});

await render.compose({
  inputs: [{ localPath, transition: 'hard_cut' | 'prev_tail' }],  // transition 仅登记；拼接一律硬切
  ratio: '9:16', resolution: '720p',   // 尺寸 = dimensionsFor(ratio, resolution)：短边=档位、两边取偶
  watermarkText,                        // 缺省 'AI 生成内容'（显式标识默认开启）；传 '' 显式关闭
  workDir,                              // 可选；临时文件写这里（调用方控制磁盘与清理），缺省系统临时目录
}) → { outputPath, coverPath, durationSeconds }      // 文件名含 UUID 防并发碰撞，转存后由调用方清理

await render.extractLastFrame(videoPath, { workDir }) → imagePath  // 尾帧，给下一段做普通参考图（尽力而为）

await render.inspect(videoPath, { durationSeconds, ratio, resolution, expectAudio = true })
  → { ok, issues: [{ code, message }] }
```

- 限制同时合成数量由调用方控制并发；临时文件在 `workDir`（或缺省临时目录）内，结束后清理。

## compose 行为（PRD §4.4）

- 每段先归一：`scale+pad` 到目标画幅（不变形、黑边补齐）、`setsar=1`、`fps=30`、`yuv420p`；音频 `loudnorm=I=-16:TP=-1.5:LRA=11`（EBU R128）→ 48k 立体声 AAC 160k。
- 段间一律硬切（`concat` 滤镜）；**不加 BGM、不加字幕**（PRD §4.4）。
- 显式标识（画面角标）：**缺省叠加 PNG 资产**（`overlay` 是核心滤镜，任何构建可用，中文渲染跨平台一致）。注入 `drawtextFontFile`（中文字体文件路径）后才改走 drawtext（文案可用 `watermarkText` 自定义）。不注入字体就用 drawtext 会把中文画成方框（fontconfig 缺 CJK 字形，本机实测），构成合规风险，故代码上禁止。两者都不可用且 `watermarkText !== ''` 时记 `render_mark_skipped`，不静默丢失。
- 隐式标识：`-metadata comment=<metadataMark>`（MP4 元数据）。
- 封面：成片 1 秒处（不足 1 秒取中点）抽帧 JPEG。
- 输出规格：MP4（H.264 + AAC），`+faststart`。

## inspect 检查项与 issue codes（PRD §4.3，全部 FFprobe/FFmpeg，零模型调用）

| code | 检查 | 判定 |
|---|---|---|
| `UNDECODABLE` | 可解码 | ffprobe 失败（含文件损坏/不存在），不再做后续检查 |
| `VIDEO_STREAM_MISSING` | 有视频流 | — |
| `AUDIO_STREAM_MISSING` | 有音频流 | 仅 `expectAudio: true` 时检查 |
| `DURATION_MISMATCH` | 时长偏差 ≤ ±2 秒 | 传入 `durationSeconds` 才检查 |
| `RESOLUTION_MISMATCH` | 画幅分辨率 | 传入 `ratio`+`resolution` 才检查，按 `dimensionsFor` 精确比对 |
| `BLACK_VIDEO` | 非全黑 | `blackdetect`：黑色区间累计 ≥ 90% 时长 |
| `FROZEN_VIDEO` | 非长时间卡住 | `freezedetect`（n=-60dB, d=2s）：冻结区间累计 ≥ 90% 时长 |
| `SILENT_AUDIO` | 非静音 | `volumedetect`：max_volume < -60 dB |

`issues[].message` 为中文文案，`code` 供程序分支（BE-05：inspect 不通过 → 片段失败、退回该片段预占）。

## 错误（RenderError）

`RENDER_INPUT_INVALID`（参数/输入不合法）、`RENDER_FFMPEG_MISSING`（未找到可执行文件）、
`RENDER_FFMPEG_FAILED`（处理失败，`detail` 为 stderr 尾部、只进日志）、`RENDER_TIMEOUT`。
用户界面只展示 `message` 中文文案。

## 生产注意事项

- 本模块需要系统装有 FFmpeg/FFprobe（M2-OPS 镜像要装，含 `libx264`/`aac`，Homebrew 与 Debian 默认均满足）。
- **显式标识缺省走 PNG 资产**（`assets/ai-mark.png`，由 Swift CoreText 预渲染「AI 生成内容」半透明黑底白字，
  本项目自制素材）。注意：Homebrew 的 `ffmpeg` 配方已精简、**没有 drawtext 滤镜**（与版本无关，
  9.0.2 实测同样没有；需要全功能构建用 `brew install ffmpeg-full`，keg-only 不影响系统命令）；
  Linux 发行版的 ffmpeg 通常带 drawtext，但**中文渲染依赖运行环境的 CJK 字体**（Debian 需装
  `fonts-noto-cjk` 之类），所以在服务器上启用 drawtext 时必须同时注入 `drawtextFontFile` 并人工
  核对渲染结果（M2 验收项），否则合规标识可能显示为方框。
- 显式标识合规（PRD §11）上线前须复核可见性与文案。
