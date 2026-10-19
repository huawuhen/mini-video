// M1-RND-01: compose / extractLastFrame / inspect, tested with FFmpeg-generated
// normal and broken sample videos (all-black, silent, frozen, missing audio track,
// duration mismatch, corrupt file). No real model calls.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, copyFile, mkdir, stat, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createRender, dimensionsFor, escapeDrawtext, probeStreams, RenderError } from '../../src/render/index.js';

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

/** Mean luma of (optionally cropped) first/seek frame via signalstats metadata print. */
function frameYavg(file, { crop, seek = 0 } = {}) {
  const vf = `${crop ? `crop=${crop},` : ''}signalstats,metadata=print:file=-`;
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ['-v', 'info', '-ss', String(seek), '-i', file, '-vf', vf, '-f', 'null', '-'],
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

    const resolutionResult = await render.inspect(normal, { ratio: '16:9', resolution: RESOLUTION });
    assert.ok(resolutionResult.issues.some((issue) => issue.code === 'RESOLUTION_MISMATCH'));

    const corrupt = join(SAMPLE_DIR, 'corrupt.mp4');
    await copyFile(normal, corrupt);
    await truncate(corrupt, Math.floor((await stat(corrupt)).size * 0.3));
    const corruptResult = await render.inspect(corrupt, { ratio: RATIO, resolution: RESOLUTION });
    assert.equal(corruptResult.ok, false);
    assert.deepEqual(corruptResult.issues.map((issue) => issue.code), ['UNDECODABLE']);
  });

  test('extractLastFrame：取到最后一帧（红→蓝视频的尾帧是蓝）', async () => {
    await mkdir(SAMPLE_DIR, { recursive: true });
    const rb = join(SAMPLE_DIR, 'rb.mp4');
    await ffmpeg(['-y', '-f', 'lavfi', '-i', 'color=c=red:size=320x480:rate=30:duration=1',
      '-f', 'lavfi', '-i', 'color=c=blue:size=320x480:rate=30:duration=1',
      '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0', '-c:v', 'libx264', '-preset', 'veryfast',
      '-pix_fmt', 'yuv420p', rb]);
    const imagePath = await render.extractLastFrame(rb);
    await access(imagePath);
    const last = await frameYavg(imagePath);
    const first = await frameYavg(rb);
    assert.ok(last < 50, `尾帧应为蓝色（YAVG=${last}，红色约为 76）`);
    assert.ok(first > 60, `首帧应为红色（YAVG=${first}）作对照`);
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
});
