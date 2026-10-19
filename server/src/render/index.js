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
export { escapeDrawtext } from './compose.js';
export { detectEvents } from './inspect.js';

const DEFAULT_WATERMARK_PATH = fileURLToPath(new URL('./assets/ai-mark.png', import.meta.url));

/**
 * createRender({ ffmpegPath, ffprobePath, timeoutMs, watermarkPath, metadataMark, logger })
 *   → { compose, extractLastFrame, inspect }
 * compose({ inputs: [{ localPath, transition }], ratio, resolution, watermarkText })
 *   → { outputPath, coverPath, durationSeconds }   // 段间一律硬切；watermarkText 缺省为标准文案，'' 关闭
 * extractLastFrame(videoPath) → imagePath          // 尾帧给下一段做普通参考图（尽力而为）
 * inspect(videoPath, { durationSeconds, ratio, resolution, expectAudio })
 *   → { ok, issues: [{ code, message }] }
 */
export function createRender({ ffmpegPath = 'ffmpeg', ffprobePath = 'ffprobe', timeoutMs = 300_000,
  watermarkPath = DEFAULT_WATERMARK_PATH, metadataMark = 'AI生成内容', logger } = {}) {
  const run = (args, options) => runBin(ffmpegPath, args, options);
  const probe = (file) => probeStreams(ffprobePath, file, { timeoutMs: 60_000 });
  return {
    compose: createCompositor({ run, probe, watermarkPath, metadataMark, timeoutMs, logger }),
    extractLastFrame: createLastFrameExtractor({ run, probe, timeoutMs }),
    inspect: createInspector({ run, probe }),
  };
}

function createLastFrameExtractor({ run, probe, timeoutMs }) {
  return async function extractLastFrame(videoPath, { workDir } = {}) {
    let duration = 0;
    try {
      duration = Number((await probe(videoPath)).format?.duration ?? 0);
    } catch {
      duration = 0; // 无法探测时从头取第一帧，让调用方拿到可检查的产物
    }
    const seek = Math.max(0, (Number.isFinite(duration) ? duration : 0) - 1);
    const baseDir = typeof workDir === 'string' && workDir.trim() ? workDir
      : await mkdtemp(join(tmpdir(), 'miv-frame-'));
    await mkdir(baseDir, { recursive: true });
    const imagePath = join(baseDir, `last-${randomUUID()}.jpg`);
    await run(['-y', '-ss', String(Math.max(0, seek)), '-i', videoPath,
      '-frames:v', '1', '-update', '1', '-q:v', '3', imagePath], { timeoutMs: Math.min(timeoutMs, 60_000) });
    return imagePath;
  };
}
