// inspect: near-zero-cost technical acceptance of a generated segment (PRD §4.3).
// Decodable, has video/audio streams, duration within ±2 s, ratio/resolution close enough,
// not fully black, not frozen for long, not silent. No model calls, no smart QC.
import { dimensionsFor } from './ffmpeg.js';

const DURATION_TOLERANCE_SECONDS = 2;
const SILENT_MAX_DB = -60;
// 画幅比例 2% 相对误差；短边达到档位 90% 即算达标（上游模型常输出 16 的倍数，如 1088x1920），
// 高于档位不算问题。
const ASPECT_TOLERANCE = 0.02;
const MIN_SHORT_SIDE_RATIO = 0.9;

function seconds(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Sum of black / freeze intervals reported on stderr; an unclosed freeze runs to the end. */
export function detectEvents(stderr, duration) {
  let black = 0;
  for (const match of stderr.matchAll(/black_start:(\d+(?:\.\d+)?) black_end:(\d+(?:\.\d+)?)/g)) {
    black += Math.max(0, seconds(match[2]) - seconds(match[1]));
  }
  let frozen = 0;
  let start;
  for (const line of stderr.split('\n')) {
    const startMatch = /freeze_start:\s*(\d+(?:\.\d+)?)/.exec(line);
    if (startMatch) { start = seconds(startMatch[1]); continue; }
    const endMatch = /freeze_(?:end|duration):\s*(\d+(?:\.\d+)?)/.exec(line);
    if (start !== undefined) {
      frozen += Math.max(0, (endMatch ? seconds(endMatch[1]) : duration) - start);
      start = undefined;
    }
  }
  if (start !== undefined) frozen += Math.max(0, duration - start);
  return { black, frozen };
}

export function createInspector({ run, probe, blackRatio = 0.9, frozenRatio = 0.9 }) {
  return async function inspect(file, { durationSeconds, ratio, resolution, expectAudio = true } = {}) {
    let info;
    try {
      info = await probe(file);
    } catch {
      return { ok: false, issues: [{ code: 'UNDECODABLE', message: '视频文件无法解码' }] };
    }
    const issues = [];
    const streams = info.streams ?? [];
    const video = streams.find((stream) => stream.codec_type === 'video');
    const audio = streams.find((stream) => stream.codec_type === 'audio');
    if (!video) issues.push({ code: 'VIDEO_STREAM_MISSING', message: '缺少视频流' });
    if (expectAudio && !audio) issues.push({ code: 'AUDIO_STREAM_MISSING', message: '缺少音频流' });
    const duration = seconds(info.format?.duration);
    if (Number.isSafeInteger(durationSeconds) && durationSeconds > 0
      && Math.abs(duration - durationSeconds) > DURATION_TOLERANCE_SECONDS) {
      issues.push({ code: 'DURATION_MISMATCH',
        message: `片段时长 ${Math.round(duration * 10) / 10} 秒，与请求的 ${durationSeconds} 秒不符` });
    }
    if (ratio && resolution && video && video.width > 0 && video.height > 0) {
      const expected = dimensionsFor(ratio, resolution);
      const expectedShort = Math.min(expected.width, expected.height);
      const expectedAspect = Math.max(expected.width, expected.height) / expectedShort;
      const actualShort = Math.min(video.width, video.height);
      const actualAspect = Math.max(video.width, video.height) / actualShort;
      const aspectError = Math.abs(actualAspect - expectedAspect) / expectedAspect;
      // 比例在 2% 相对误差内、且短边不低于档位的 90%（高于档位不算问题）
      if (aspectError > ASPECT_TOLERANCE || actualShort < expectedShort * MIN_SHORT_SIDE_RATIO) {
        issues.push({ code: 'RESOLUTION_MISMATCH',
          message: `画面为 ${video.width}x${video.height}，预期 ${ratio}、分辨率不低于 ${expectedShort}，`
            + `约 ${expected.width}x${expected.height}` });
      }
    }
    if (video && duration > 0) {
      const { stderr } = await run(
        ['-an', '-i', file, '-vf', 'blackdetect=d=0.5:pix_th=0.10,freezedetect=n=-60dB:d=2', '-f', 'null', '-'],
        { timeoutMs: 120_000 });
      const { black, frozen } = detectEvents(stderr, duration);
      if (black >= duration * blackRatio) issues.push({ code: 'BLACK_VIDEO', message: '画面全黑' });
      if (frozen >= duration * frozenRatio) issues.push({ code: 'FROZEN_VIDEO', message: '画面长时间静止' });
    }
    if (audio) {
      const { stderr } = await run(['-vn', '-i', file, '-af', 'volumedetect', '-f', 'null', '-'],
        { timeoutMs: 120_000 });
      const max = /max_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/.exec(stderr);
      if (max && seconds(max[1]) < SILENT_MAX_DB) issues.push({ code: 'SILENT_AUDIO', message: '音频静音' });
    }
    return { ok: issues.length === 0, issues };
  };
}
