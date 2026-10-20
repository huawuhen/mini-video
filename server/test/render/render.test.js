// M1-RND-01: compose / extractLastFrame / inspect, tested with FFmpeg-generated
// normal and broken sample videos (all-black, silent, frozen, missing audio track,
// duration mismatch, corrupt file). No real model calls.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, copyFile, mkdir, stat, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createRender, dimensionsFor, drawtextFilter, escapeDrawtext, probeStreams, RenderError } from '../../src/render/index.js';

const SAMPLE_DIR = join(tmpdir(), 'miv-render-samples');
// 统一 9:16 720p（M1 默认档位）；3 秒让 freezedetect 的 2 秒阈值能触发。
const RATIO = '9:16';
const RESOLUTION = '720p';
const SIZE = '720x1280';
const DURATION = 3;

function ffmpeg(args, { timeoutMs = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ['-v', 'error', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    let stderr = '';
    child.stderr.on('data', (chunk) => { if (stderr.length < 64_000) stderr += chunk; });
    child.on('close', (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(stderr.slice(-500))); });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
  });
}

/** Generate a tiny synthetic sample clip with/without defects (lavfi sources only). */
async function makeVideo(name, { video = `testsrc2=size=${SIZE}:rate=30`, audio = 'sine=frequency=440',
  duration = DURATION, noAudio = false } = {}) {
  await mkdir(SAMPLE_DIR, { recursive: true });
  const file = join(SAMPLE_DIR, name);
  const args = ['-y', '-f', 'lavfi', '-i', video];
  if (!noAudio) args.push('-f', 'lavfi', '-i', audio);
  args.push('-t', String(duration), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28',
    '-pix_fmt', 'yuv420p');
  if (!noAudio) args.push('-c:a', 'aac');
  args.push(file);
  await ffmpeg(args);
  return file;
}

/** Mean luma of (optionally cropped) seek frame via signalstats metadata print. */
function frameYavg(file, { crop, seek = 0 } = {}) {
  const vf = `${crop ? `crop=${crop},` : ''}signalstats,metadata=print:file=-`;
  const args = seek > 0 ? ['-ss', String(seek)] : [];
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ['-v', 'info', ...args, '-i', file, '-vf', vf, '-f', 'null', '-'],
      { stdio: ['ignore', 'pipe', 'ignore'] });
    let text = '';
    child.stdout.on('data', (chunk) => { text += chunk; });
    child.on('close', () => {
      const match = /lavfi\.signalstats\.YAVG=([\d.]+)/.exec(text);
      match ? resolve(Number(match[1])) : reject(new Error('signalstats 未输出 YAVG'));
    });
    child.on('error', reject);
  });
}

describe('render（M1-RND-01）', () => {
  let render;
  let normal;
  let black;
  let frozen;
  let silent;
  let noAudio;
  before(async () => {
    render = createRender();
    normal = await makeVideo('normal.mp4');
    black = await makeVideo('black.mp4', { video: `color=c=black:size=${SIZE}:rate=30` });
    frozen = await makeVideo('frozen.mp4', { video: `color=c=red:size=${SIZE}:rate=30` });
    silent = await makeVideo('silent.mp4', { audio: 'anullsrc=r=48000:cl=stereo' });
    noAudio = await makeVideo('noaudio.mp4', { noAudio: true });
  });
  after(async () => { /* 样片留在系统临时目录，由系统回收 */ });

  test('dimensionsFor：短边等于档位、两边取偶、横竖屏与正方形', () => {
    assert.deepEqual(dimensionsFor('9:16', '720p'), { width: 720, height: 1280 });
    assert.deepEqual(dimensionsFor('16:9', '1080p'), { width: 1920, height: 1080 });
    assert.deepEqual(dimensionsFor('1:1', '480p'), { width: 480, height: 480 });
    assert.deepEqual(dimensionsFor('4:3', '480p'), { width: 640, height: 480 });
    assert.throws(() => dimensionsFor('fill', '720p'), RenderError);
    assert.throws(() => dimensionsFor('9:16', '2k'), RenderError);
  });

  test('inspect：正常样片全部通过', async () => {
    const result = await render.inspect(normal, { durationSeconds: DURATION, ratio: RATIO, resolution: RESOLUTION });
    assert.deepEqual(result, { ok: true, issues: [] });
  });

  test('inspect：全黑、静帧、静音各自报告对应问题', async () => {
    const blackResult = await render.inspect(black, { ratio: RATIO, resolution: RESOLUTION });
    assert.ok(blackResult.issues.some((issue) => issue.code === 'BLACK_VIDEO'), JSON.stringify(blackResult));
    assert.ok(!blackResult.issues.some((issue) => issue.code === 'SILENT_AUDIO'), '全黑样片音频正常');
    const frozenResult = await render.inspect(frozen, { ratio: RATIO, resolution: RESOLUTION });
    assert.ok(frozenResult.issues.some((issue) => issue.code === 'FROZEN_VIDEO'), JSON.stringify(frozenResult));
    assert.ok(!frozenResult.issues.some((issue) => issue.code === 'BLACK_VIDEO'), '红色静帧不算全黑');
    const silentResult = await render.inspect(silent, { ratio: RATIO, resolution: RESOLUTION });
    assert.ok(silentResult.issues.some((issue) => issue.code === 'SILENT_AUDIO'), JSON.stringify(silentResult));
    assert.ok(!silentResult.issues.some((issue) => issue.code === 'BLACK_VIDEO'));
  });

  test('inspect：缺音轨按 expectAudio 报告；时长与分辨率不符、文件损坏', async () => {
    const missing = await render.inspect(noAudio, { ratio: RATIO, resolution: RESOLUTION });
    assert.ok(missing.issues.some((issue) => issue.code === 'AUDIO_STREAM_MISSING'));
    const allowed = await render.inspect(noAudio, { ratio: RATIO, resolution: RESOLUTION, expectAudio: false });
    assert.ok(!allowed.issues.some((issue) => issue.code === 'AUDIO_STREAM_MISSING'));

    const durationResult = await render.inspect(normal, { durationSeconds: DURATION + 3 });
    assert.ok(durationResult.issues.some((issue) => issue.code === 'DURATION_MISMATCH'));
    const withinTolerance = await render.inspect(normal, { durationSeconds: DURATION + 1 });
    assert.ok(!withinTolerance.issues.some((issue) => issue.code === 'DURATION_MISMATCH'), '±2 秒内算相符');
    // 分辨率判定的四种情形见下一个用例（放宽后 9:16 文件对 16:9 请求不再判不符：比例族相同）

    const corrupt = join(SAMPLE_DIR, 'corrupt.mp4');
    await copyFile(normal, corrupt);
    await truncate(corrupt, Math.floor((await stat(corrupt)).size * 0.3));
    const corruptResult = await render.inspect(corrupt, { ratio: RATIO, resolution: RESOLUTION });
    assert.equal(corruptResult.ok, false);
    assert.deepEqual(corruptResult.issues.map((issue) => issue.code), ['UNDECODABLE']);
  });

  test('extractLastFrame：取到真正的最后一帧（红3秒→绿0.5→蓝0.5，尾帧必须是蓝）', async () => {
    await mkdir(SAMPLE_DIR, { recursive: true });
    const rgb = join(SAMPLE_DIR, 'rgb.mp4');
    await ffmpeg(['-y',
      '-f', 'lavfi', '-i', 'color=c=red:size=320x480:rate=30:duration=3',
      '-f', 'lavfi', '-i', 'color=c=green:size=320x480:rate=30:duration=0.5',
      '-f', 'lavfi', '-i', 'color=c=blue:size=320x480:rate=30:duration=0.5',
      '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0',
      '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', rgb]);
    const imagePath = await render.extractLastFrame(rgb);
    await access(imagePath);
    const last = await frameYavg(imagePath);
    const first = await frameYavg(rgb);
    assert.ok(last < 50, `尾帧应为蓝色（YAVG=${last}，绿约 150、红约 76）——旧实现取到倒数第 1 秒处的帧会挂在这里`);
    assert.ok(first > 60, `首帧应为红色（YAVG=${first}）作对照`);
    // 极短（<0.3 秒，-sseof 会越过头）：仍能产出一帧
    const tiny = await makeVideo('tiny.mp4', { duration: 0.2 });
    const tinyPath = await render.extractLastFrame(tiny);
    await access(tinyPath);
    const tinyYavg = await frameYavg(tinyPath);
    assert.ok(tinyYavg > 0, `极短样片也能提取（YAVG=${tinyYavg}）`);
  });

  test('inspect：分辨率放宽——720x1280 与 1088x1920 通过，360x640 与比例错判不符', async () => {
    const atTier = await render.inspect(normal, { ratio: RATIO, resolution: RESOLUTION });
    assert.ok(!atTier.issues.some((issue) => issue.code === 'RESOLUTION_MISMATCH'));
    // 上游模型常输出 16 的倍数规格：1088x1920 短边高于档位、比例误差 <2%，应通过
    const above = await makeVideo('r1088.mp4', { video: 'testsrc2=size=1088x1920:rate=30' });
    const aboveResult = await render.inspect(above, { ratio: RATIO, resolution: RESOLUTION });
    assert.ok(!aboveResult.issues.some((issue) => issue.code === 'RESOLUTION_MISMATCH'),
      JSON.stringify(aboveResult));
    // 短边 360 低于档位 90%（648）：不符
    const below = await makeVideo('r360.mp4', { video: 'testsrc2=size=360x640:rate=30' });
    const belowResult = await render.inspect(below, { ratio: RATIO, resolution: RESOLUTION });
    assert.ok(belowResult.issues.some((issue) => issue.code === 'RESOLUTION_MISMATCH'));
    // 比例错（1:1）：不符
    const square = await makeVideo('square.mp4', { video: 'testsrc2=size=720x720:rate=30' });
    const squareResult = await render.inspect(square, { ratio: RATIO, resolution: RESOLUTION });
    assert.ok(squareResult.issues.some((issue) => issue.code === 'RESOLUTION_MISMATCH'));
  });

  test('inspect：全黑/静止阈值可调（frozenRatio 调低后 80% 静止被检出）', async () => {
    await mkdir(SAMPLE_DIR, { recursive: true });
    const mixed = join(SAMPLE_DIR, 'mixed-freeze.mp4');
    await ffmpeg(['-y',
      '-f', 'lavfi', '-i', 'testsrc2=size=720x1280:rate=30:duration=1',
      '-f', 'lavfi', '-i', 'color=c=red:size=720x1280:rate=30:duration=4',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=5',
      '-filter_complex', '[2:a]asplit=2[a1][a2];[0:v][a1][1:v][a2]concat=n=2:v=1:a=1[v][a]',
      '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28',
      '-pix_fmt', 'yuv420p', '-c:a', 'aac', mixed]);
    const lenient = await render.inspect(mixed, { ratio: RATIO, resolution: RESOLUTION });
    assert.ok(!lenient.issues.some((issue) => issue.code === 'FROZEN_VIDEO'),
      `80% 静止在缺省 0.9 阈值下通过：${JSON.stringify(lenient)}`);
    const strict = createRender({ frozenRatio: 0.5 });
    const strictResult = await strict.inspect(mixed, { ratio: RATIO, resolution: RESOLUTION });
    assert.ok(strictResult.issues.some((issue) => issue.code === 'FROZEN_VIDEO'),
      `frozenRatio=0.5 时应检出：${JSON.stringify(strictResult)}`);
  });

  test('compose：两段硬切拼接、规格与元数据标识、封面、显式标识叠加', async () => {
    const { outputPath, coverPath, durationSeconds } = await render.compose({
      inputs: [{ localPath: normal, transition: 'hard_cut' },
        { localPath: await makeVideo('seg2.mp4'), transition: 'prev_tail' }],
      ratio: RATIO, resolution: RESOLUTION });
    assert.ok(Math.abs(durationSeconds - DURATION * 2) < 0.6, `拼接时长应为 ${DURATION * 2} 秒左右，实际 ${durationSeconds}`);
    const info = await probeStreams('ffprobe', outputPath, { timeoutMs: 60_000 });
    const video = info.streams.find((stream) => stream.codec_type === 'video');
    const audio = info.streams.find((stream) => stream.codec_type === 'audio');
    assert.equal(video.codec_name, 'h264');
    assert.equal(audio.codec_name, 'aac');
    assert.equal(`${video.width}x${video.height}`, SIZE);
    assert.match(String(info.format.tags?.comment ?? ''), /AI生成|AI 生成/, '元数据隐式标识');
    await access(coverPath);
    // 显式标识：同一输入有/无水印时，左下角水印区域亮度必须不同
    const plain = await render.compose({ inputs: [{ localPath: normal }], ratio: RATIO, resolution: RESOLUTION,
      watermarkText: '' });
    const band = { crop: `300:110:30:${1280 - 140}`, seek: 0.5 };
    const markedYavg = await frameYavg(outputPath, band);
    const plainYavg = await frameYavg(plain.outputPath, band);
    assert.ok(Math.abs(markedYavg - plainYavg) > 2, `水印区域亮度应不同（${markedYavg} vs ${plainYavg}）`);
  });

  test('compose：输入校验（缺音频流、坏比例、文件不存在）', async () => {
    await assert.rejects(() => render.compose({ inputs: [{ localPath: noAudio }] }), /缺少音频流/);
    await assert.rejects(() => render.compose({ inputs: [{ localPath: normal }], ratio: 'fill' }), /画幅比例不合法/);
    await assert.rejects(() => render.compose({ inputs: [{ localPath: join(SAMPLE_DIR, 'missing.mp4') }] }), /不存在/);
    await assert.rejects(() => render.compose({ inputs: [] }), /拼接输入不合法/);
  });

  test('escapeDrawtext：drawtext 文案转义冒号、引号与百分号', () => {
    assert.equal(escapeDrawtext("AI: '生成' 50%"), "AI\\: \\'生成\\' 50\\%");
  });

  test('drawtextFilter：必须注入字体文件，y 用 text_h（drawtext 没有 overlay_h 变量）', () => {
    assert.throws(() => drawtextFilter(1280, 'AI 生成内容'), /需要注入中文字体/,
      '无字体文件的 drawtext 会把中文画成方框（本机 ffmpeg-full 实测）');
    const filter = drawtextFilter(1280, 'AI 生成内容', '/System/Library/Fonts/STHeiti Medium.ttc');
    assert.ok(filter.includes('y=main_h-text_h-36'), filter);
    assert.ok(!filter.includes('overlay_h'), 'drawtext 表达式不能引用 overlay 滤镜的变量');
    assert.ok(filter.includes("text='AI 生成内容'"));
    assert.ok(filter.includes("fontfile='/System/Library/Fonts/STHeiti Medium.ttc'"));
    assert.ok(filter.includes('fontsize=58'), '字号按高度 1/22 计算');
  });
});
