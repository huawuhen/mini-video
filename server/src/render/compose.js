// compose: concat segments with hard cuts, EBU R128 loudness normalization, explicit
// AI mark + metadata mark, MP4 (H.264 + AAC) and a cover image. No BGM, no subtitles.
// 「接上段尾帧」只影响生成阶段的参考图；拼接一律硬切（PRD §4.4）。
import { access } from 'node:fs/promises';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RenderError, dimensionsFor } from './ffmpeg.js';

const MAX_INPUTS = 60;
const TRANSITIONS = ['hard_cut', 'prev_tail'];
const RESOLUTIONS = ['480p', '720p', '1080p'];
const R128 = 'loudnorm=I=-16:TP=-1.5:LRA=11,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo';

/** Escape a literal for use inside a quoted drawtext filter value. */
export function escapeDrawtext(text) {
  return String(text).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/:/g, '\\:')
    .replace(/%/g, '\\%');
}

export function createCompositor({ run, probe, watermarkPath, metadataMark,
  timeoutMs, logger }) {
  // 显式标识优先用 drawtext（构建带 freetype 时），否则叠加预渲染的 PNG 资产（overlay 为核心滤镜）。
  // drawtext 是否可用在首次 compose 时探测一次并缓存。
  let drawtextProbe;
  const detectDrawtext = () => (drawtextProbe ??= run(['-hide_banner', '-filters'],
    { timeoutMs: 15_000 }).then(({ stdout }) => stdout.includes(' drawtext ')).catch(() => false));

  return async function compose({ inputs, ratio = '9:16', resolution = '720p', watermarkText, workDir } = {}) {
    if (!Array.isArray(inputs) || !inputs.length || inputs.length > MAX_INPUTS
      || inputs.some((item) => !item || typeof item.localPath !== 'string' || !item.localPath.trim()
        || (item.transition !== undefined && !TRANSITIONS.includes(item.transition)))) {
      throw new RenderError('RENDER_INPUT_INVALID', '拼接输入不合法：需要 1~60 个片段文件');
    }
    const { width, height } = dimensionsFor(ratio, resolution);
    if (!RESOLUTIONS.includes(resolution)) throw new RenderError('RENDER_INPUT_INVALID', `分辨率档位不合法：${resolution}`);
    for (const item of inputs) {
      await access(item.localPath).catch(() => {
        throw new RenderError('RENDER_INPUT_INVALID', `片段文件不存在：${item.localPath}`);
      });
      const info = await probe(item.localPath);
      if (!info.streams?.some((stream) => stream.codec_type === 'audio')) {
        throw new RenderError('RENDER_INPUT_INVALID', '片段缺少音频流，无法拼接');
      }
    }

    // workDir 由调用方传入（BE-05 控制磁盘与并发清理）；缺省用系统临时目录。
    const baseDir = typeof workDir === 'string' && workDir.trim() ? workDir
      : await mkdtemp(join(tmpdir(), 'miv-compose-'));
    await mkdir(baseDir, { recursive: true });
    const unique = randomUUID();
    const outputPath = join(baseDir, `output-${unique}.mp4`);
    const parts = [];
    for (const [index] of inputs.entries()) {
      parts.push(`[${index}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,`
        + `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=30,format=yuv420p[v${index}]`);
      parts.push(`[${index}:a]${R128}[a${index}]`);
    }
    parts.push(inputs.flatMap((_, index) => [`[v${index}]`, `[a${index}]`]).join('')
      + `concat=n=${inputs.length}:v=1:a=1[vcat][acat]`);
    // watermarkText 缺省为标准文案（显式标识默认开启）；空字符串显式关闭（仅测试/内部使用）。
    const wantMark = watermarkText !== '';
    const markText = watermarkText ?? 'AI 生成内容';
    let markInput;
    if (wantMark && await detectDrawtext()) {
      parts.push(`[vcat]drawtext=text='${escapeDrawtext(markText)}':fontcolor=white@0.85`
        + `:fontsize=${Math.round(height / 22)}:x=36:y=main_h-overlay_h-36`
        + ':box=1:boxcolor=black@0.45:boxborderw=18[vout]');
    } else if (wantMark && watermarkPath) {
      await access(watermarkPath).catch(() => {
        throw new RenderError('RENDER_INPUT_INVALID', `AI 标识图片不存在：${watermarkPath}`);
      });
      markInput = inputs.length;
      parts.push(`[${markInput}:v]scale=-2:${Math.max(2, Math.round(height / 12))}[wm]`);
      parts.push('[vcat][wm]overlay=x=36:y=main_h-overlay_h-36[vout]');
    } else {
      parts.push('[vcat]null[vout]');
      if (wantMark) logger?.warn?.('render_mark_skipped', { hasDrawtext: await detectDrawtext(),
        hasAsset: Boolean(watermarkPath) });
    }
    const args = ['-y'];
    for (const item of inputs) args.push('-i', item.localPath);
    if (markInput !== undefined) args.push('-i', watermarkPath);
    args.push('-filter_complex', parts.join(';'), '-map', '[vout]', '-map', '[acat]',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
      '-c:a', 'aac', '-b:a', '160k', '-ar', '48000',
      '-movflags', '+faststart', '-metadata', `comment=${metadataMark}`, outputPath);
    await run(args, { timeoutMs });

    const info = await probe(outputPath);
    const duration = Number(info.format?.duration ?? 0);
    const coverPath = join(baseDir, `cover-${unique}.jpg`);
    const seek = Math.min(1, Math.max(0, duration / 2));
    await run(['-y', '-ss', String(seek), '-i', outputPath, '-frames:v', '1', '-q:v', '3', coverPath],
      { timeoutMs: Math.min(timeoutMs, 60_000) });
    return { outputPath, coverPath, durationSeconds: Math.round(duration * 100) / 100 };
  };
}
