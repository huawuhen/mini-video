// FFmpeg/FFprobe process helpers for the render module. Binaries and timeouts are
// injected via createRender(); no process.env reads, no shell interpolation.
import { spawn } from 'node:child_process';

const STDOUT_LIMIT = 8 * 1024 * 1024;
const STDERR_LIMIT = 256 * 1024;

export class RenderError extends Error {
  constructor(code, message, detail = '') {
    super(message);
    this.name = 'RenderError';
    this.code = code;
    this.detail = String(detail).slice(0, 800); // 供日志排查，不展示给用户
  }
}

/** Run a binary with argv (no shell); resolve { stdout, stderr } on exit 0.
 * Verdict is read from the 'close' event: stdio can end before 'exit' fires,
 * so child.exitCode may still be null when the pipes are drained. */
export function runBin(bin, args, { timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const settle = (fn) => (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { if (stdout.length < STDOUT_LIMIT) stdout += chunk; });
    child.stderr.on('data', (chunk) => { if (stderr.length < STDERR_LIMIT) stderr += chunk; });
    child.on('error', settle((error) => {
      reject(new RenderError('RENDER_FFMPEG_MISSING', `未找到 ${bin}，请安装 FFmpeg 或注入可执行文件路径`, error.message));
    }));
    child.on('close', settle((code) => {
      if (timedOut) {
        reject(new RenderError('RENDER_TIMEOUT', `${bin} 处理超时（${timeoutMs} 毫秒）`, stderr.slice(-800)));
      } else if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new RenderError('RENDER_FFMPEG_FAILED', `${bin} 处理失败`, stderr.slice(-800)));
      }
    }));
  });
}

/** ffprobe -show_format -show_streams as JSON; a bad file rejects with RENDER_FFMPEG_FAILED. */
export async function probeStreams(ffprobePath, file, options) {
  const { stdout } = await runBin(ffprobePath,
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], options);
  try { return JSON.parse(stdout); }
  catch (error) { throw new RenderError('RENDER_FFMPEG_FAILED', 'FFprobe 输出无法解析', error.message); }
}

const even = (value) => Math.max(2, Math.round(value / 2) * 2);

/** Target pixel size for a ratio ('9:16') and quality tier ('480p'|'720p'|'1080p').
 * The short side equals the tier; both sides are even for yuv420p. */
export function dimensionsFor(ratio, resolution) {
  const match = /^(\d+):(\d+)$/.exec(String(ratio ?? ''));
  if (!match) throw new RenderError('RENDER_INPUT_INVALID', `画幅比例不合法：${ratio}`);
  const heights = { '480p': 480, '720p': 720, '1080p': 1080 };
  const short = heights[resolution];
  if (!short) throw new RenderError('RENDER_INPUT_INVALID', `分辨率档位不合法：${resolution}`);
  const a = Number(match[1]);
  const b = Number(match[2]);
  if (!a || !b) throw new RenderError('RENDER_INPUT_INVALID', `画幅比例不合法：${ratio}`);
  const long = even(short * Math.max(a, b) / Math.min(a, b));
  return a >= b ? { width: long, height: short } : { width: short, height: long };
}
