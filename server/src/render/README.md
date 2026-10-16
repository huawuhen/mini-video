# render（Render 角色）

FFmpeg 成片合成，只在 Worker 进程运行。接口以 `docs/ARCHITECTURE.md §5` 为准：

```js
compose({ inputs: [{ localPath, transition: 'prev_tail' | 'hard_cut' }], ratio, resolution, watermarkText, workDir })
  → { outputPath, coverPath, durationSeconds }
extractLastFrame(videoPath, { workDir }) → imagePath
```

- 拼接后统一响度（EBU R128，`loudnorm`），H.264 + AAC MP4，`+faststart`。
- 显式 AI 生成标识（画面角标，文案由调用方传入）+ 隐式标识（MP4 元数据 `comment`/`description`）。
- **不加 BGM、不加字幕**（PRD §4.4）。
- 用 `ffmpeg -f lavfi` 生成的测试视频做单测，不依赖真实模型产出；FFmpeg 路径可注入（`ffmpegPath`）。
- 限制同时合成数量（由调用方控制并发），临时文件在 `workDir` 内，结束后清理。
