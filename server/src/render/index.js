// render (Render 角色): segment acceptance and final composition, per docs/ARCHITECTURE.md §5.
// All external dependencies (ffmpeg/ffprobe binaries, work dir) are injected or defaulted
// here; no process.env reads, no real model costs.
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runBin, probeStreams } from './ffmpeg.js';
import { createCompositor } from './compose.js';
import { createInspector } from './inspect.js';

export { RenderError, dimensionsFor, probeStreams } from './ffmpeg.js';
export { escapeDrawtext, drawtextFilter } from './compose.js';
export { detectEvents } from './inspect.js';

const DEFAULT_WATERMARK_PATH = fileURLToPath(new URL('./assets/ai-mark.png', import.meta.url));

/**
 * createRender({ ffmpegPath, ffprobePath, timeoutMs, watermarkPath, metadataMark, drawtextFontFile, logger })
 *   → { compose, extractLastFrame, extractPosterFrame, inspect }
 * compose({ inputs: [{ localPath, transition }], ratio, resolution, watermarkText })
 *   → { outputPath, coverPath, durationSeconds }   // 段间一律硬切；watermarkText 缺省为标准文案，'' 关闭
 * extractLastFrame(videoPath, { workDir }) → imagePath // 尾帧给下一段做普通参考图（尽力而为）
 * extractPosterFrame(videoPath, { workDir, atSeconds }) → imagePath // 片段列表缩略图（M2-OPS-03 复审必改 3）
 * inspect(videoPath, { durationSeconds, ratio, resolution, expectAudio })
 *   → { ok, issues: [{ code, message }] }
 * 显式标识缺省叠加 PNG 资产；仅当注入 drawtextFontFile（中文字体文件）时改走 drawtext。
 */
export function createRender({ ffmpegPath = 'ffmpeg', ffprobePath = 'ffprobe', timeoutMs = 300_000,
  watermarkPath = DEFAULT_WATERMARK_PATH, metadataMark = 'AI生成内容', drawtextFontFile,
  blackRatio = 0.9, frozenRatio = 0.9, logger } = {}) {
  const run = (args, options) => runBin(ffmpegPath, args, options);
  const probe = (file) => probeStreams(ffprobePath, file, { timeoutMs: 60_000 });
  return {
    compose: createCompositor({ run, probe, watermarkPath, metadataMark, drawtextFontFile, timeoutMs, logger }),
    extractLastFrame: createLastFrameExtractor({ run, timeoutMs }),
    extractPosterFrame: createPosterFrameExtractor({ run, timeoutMs }),
    inspect: createInspector({ run, probe, blackRatio, frozenRatio }),
  };
}

// -sseof -0.3 从片尾倒数 0.3 秒起顺序解码，不加帧数限制，配合 `-update 1` 让 image2 muxer
// 逐帧覆盖同一文件，进程结束时留下的就是真正的最后一帧（-frames:v 1 会停在倒数 0.3 秒处）。
function createLastFrameExtractor({ run, timeoutMs }) {
  const extract = (runArgs, videoPath, imagePath, timeoutMsMs) => run(
    ['-y', ...runArgs, '-i', videoPath, '-update', '1', '-q:v', '3', imagePath],
    { timeoutMs: Math.min(timeoutMsMs, 60_000) });
  return async function extractLastFrame(videoPath, { workDir } = {}) {
    const baseDir = typeof workDir === 'string' && workDir.trim() ? workDir
      : await mkdtemp(join(tmpdir(), 'miv-frame-'));
    await mkdir(baseDir, { recursive: true });
    const imagePath = join(baseDir, `last-${randomUUID()}.jpg`);
    try {
      await extract(['-sseof', '-0.3'], videoPath, imagePath, timeoutMs);
    } catch {
      // 个别容器寻址索引异常时退回顺序解码，至少产出一帧
      await extract([], videoPath, imagePath, timeoutMs);
    }
    return imagePath;
  };
}

// 海报帧（M2-OPS-03 复审必改 3）：片段卡缩略图。默认取 1 秒处（避开起帧黑场，画面通常已展开）；
// 片长不足或容器寻址失败回退第 0 帧。poster 只是展示增强——调用方（gen.poll）对失败按
// 尽力而为处理，不阻塞 take 成功。
function createPosterFrameExtractor({ run, timeoutMs }) {
  const grab = (runArgs, videoPath, imagePath) => run(
    ['-y', ...runArgs, '-i', videoPath, '-frames:v', '1', '-q:v', '3', imagePath],
    { timeoutMs: Math.min(timeoutMs, 60_000) });
  return async function extractPosterFrame(videoPath, { workDir, atSeconds = 1 } = {}) {
    const baseDir = typeof workDir === 'string' && workDir.trim() ? workDir
      : await mkdtemp(join(tmpdir(), 'miv-frame-'));
    await mkdir(baseDir, { recursive: true });
    const imagePath = join(baseDir, `poster-${randomUUID()}.jpg`);
    try {
      await grab(['-ss', String(atSeconds)], videoPath, imagePath);
    } catch {
      await grab([], videoPath, imagePath); // 片长不足 atSeconds 等：回退首帧
    }
    return imagePath;
  };
}
