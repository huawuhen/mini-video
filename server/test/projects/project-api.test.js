// M1-BE-06：作品 HTTP API（API.md §6）+ SSE + 交付后替换 + 下载。
// 契约测试：响应字段与 apps/web/src/api/types.ts 声明逐一比对（字段存在且 JSON 类型一致）。
// 全部走 createApp 真实 HTTP 栈（会话/CSRF/同源），job 用注入的模拟上游在测试内驱动。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createTestDb } from '../helpers/db.js';
import { httpMemoryStorage } from './helpers/projects-http.js';
import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { createLogger } from '../../src/logger.js';
import { createProject, confirmCast, confirmStory } from '../../src/projects/service.js';
import { createBindPromptsHandler } from '../../src/projects/bind.js';
import { createGenPollHandler, createSegmentGenerateHandler } from '../../src/projects/segment.js';
import { createComposeHandler } from '../../src/projects/compose.js';
import { createUnderstandHandler } from '../../src/projects/understand.js';
import { createStoryAgent } from '../../src/engine/story/index.js';
import { createMockLlm } from '../../src/engine/llm/mock.js';
import { createQuote } from '../../src/wallet/pricing.js';
import { createLookGenerateHandler } from '../../src/characters/service.js';
import { createRender } from '../../src/render/index.js';

// ── 契约：从 types.ts 抽取 interface 声明，运行时校验字段名与 JSON 类型 ──
const TYPES_SHAPES = (() => {
  const source = readFileSync(new URL('../../../apps/web/src/api/types.ts', import.meta.url), 'utf8');
  const shapes = {};
  // 逐行解析：export interface X [extends Y] { ... }（支持单行与多行两种形态）
  let current = null;
  for (const line of source.split('\n')) {
    const startMatch = /export interface (\w+)(?:\s+extends \w+)? \{(.*)$/.exec(line);
    if (startMatch) current = { name: startMatch[1], fields: {}, inline: startMatch[2] };
    if (!current) continue;
    const body = current.inline ?? line;
    for (const piece of body.split(';')) {
      const m = /^(\w+)(\?)?:\s*(.+)$/.exec(piece.trim());
      if (m) current.fields[m[1]] = { type: m[3].trim(), optional: m[2] === '?' };
    }
    if (/^\}\s*$/.test(line) || (current.inline && /\}\s*$/.test(line))) {
      shapes[current.name] = current.fields;
      current = null;
    }
  }
  return shapes;
})();

function checkShape(shapeName, value, { requireAll = true } = {}) {
  const shape = TYPES_SHAPES[shapeName];
  assert.ok(shape, `types.ts 中缺少 interface ${shapeName}`);
  if (value === undefined || value === null) return;
  for (const [field, meta] of Object.entries(shape)) {
    const present = Object.prototype.hasOwnProperty.call(value, field);
    if (!present) {
      assert.ok(!requireAll || meta.optional,
        `${shapeName}.${field} 缺失（types.ts 声明了${meta.optional ? '可选' : '必填'}字段）`);
      continue;
    }
    const actual = value[field];
    if (actual === undefined || actual === null) {
      assert.ok(meta.optional, `${shapeName}.${field} 为空但类型未标可选`);
      continue;
    }
    const declared = meta.type;
    if (declared === 'string' || declared === 'number' || declared === 'boolean') {
      assert.equal(typeof actual, declared, `${shapeName}.${field} 应为 ${declared}`);
    } else if (/^'/.test(declared) || declared.includes(" | '")) {
      const options = declared.split('|').map((option) => option.trim().replaceAll("'", ''));
      assert.ok(options.includes(actual), `${shapeName}.${field}=${actual} 不在取值 ${declared}`);
    } else if (declared.endsWith('[]')) {
      assert.ok(Array.isArray(actual), `${shapeName}.${field} 应为数组`);
      const itemType = declared.slice(0, -2);
      if (TYPES_SHAPES[itemType]) for (const item of actual) checkShape(itemType, item, { requireAll: false });
      else if (itemType === 'string') assert.ok(actual.every((item) => typeof item === 'string'));
    } else if (TYPES_SHAPES[declared]) {
      checkShape(declared, actual, { requireAll: false });
    }
  }
}

const silent = createLogger({ level: 'silent' });

async function makeVideo(file, { duration = 30 } = {}) {
  await mkdir(tmpdir(), { recursive: true });
  await new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi',
      '-i', `testsrc2=size=720x1280:rate=30:duration=${duration}`,
      '-f', 'lavfi', '-i', `sine=frequency=440:duration=${duration}`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', file], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(stderr))));
    child.on('error', reject);
  });
  return file;
}

describe('projects API（M1-BE-06）', () => {
  let ctx;
  let server;
  let base;
  let sms;
  let cookie;
  let csrf;
  let otherCookie;
  let otherCsrf;
  let userId;
  let config;
  let sample;
  const storage = httpMemoryStorage();
  const PLAN = { title: '野餐', synopsis: 's',
    bible: { mood: 'warm', characters: [{ castIndex: 0, handle: 'the girl', brief: 'a girl' }],
      scenes: [{ id: 's1', nameZh: '公园', description: 'a park lawn in daylight' }], props: [] },
    cast: [{ name: '宝宝', description: '活泼', gender: 'female', ageGroup: 'child', characterId: 'chr_baby00000001' }],
    segments: [{ durationSeconds: 30, sceneId: 's1', propIds: [], endState: 'she sits', plot: '野餐。',
      cameraNotes: '', dialogue: [], ambience: '', transition: 'hard_cut', castIndexes: [0] }] };
  const timeline = JSON.stringify({ shots: [
    { start: 0, end: 7, size: 'Medium shot', transition: 'cut', action: 'Shot 1.', dialogue: [],
      reaction: '', environment: '', camera: 'static' },
    { start: 7, end: 14, size: 'Medium shot', transition: 'cut', action: 'Shot 2.', dialogue: [],
      reaction: '', environment: '', camera: 'static' },
    { start: 14, end: 21, size: 'Medium shot', transition: 'cut', action: 'Shot 3.', dialogue: [],
      reaction: '', environment: '', camera: 'static' },
    { start: 21, end: 30, size: 'Medium shot', transition: 'cut', action: 'Shot 4.', dialogue: [],
      reaction: '', environment: '', camera: 'static' }], avoid: [] });

  before(async () => {
    ctx = await createTestDb();
    sms = { sent: [], lastCode: null, id: 'test-capture',
      async send({ code }) { this.sent.push({ code }); this.lastCode = code; } };
    config = loadConfig({ NODE_ENV: 'test' });
    const app = createApp({ config, db: ctx.db, logger: silent, storage, smsProvider: sms,
      urlFor: (key) => `https://media.example/${key}` });
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}/api/v1`;

    // 用户 A（主测试用户）与用户 B（他人 404）
    for (const [phone, id] of [['15800000011', null], ['15800000012', 'usr_other_be006001']]) {
      await request('POST', '/auth/sms', { body: { phone } });
      const login = await request('POST', '/auth/login', {
        body: { phone, code: sms.lastCode, agreeTerms: true } });
      assert.equal(login.status, 200);
      const body = await login.json();
      const sid = (login.headers.getSetCookie().find((c) => c.startsWith('miv_sid=')) ?? '').split(';')[0];
      if (id) await ctx.db.query(`INSERT INTO users (id, phone, nickname) VALUES ($1, $2, '他人')
        ON CONFLICT DO NOTHING`, [id, phone]);
      if (phone === '15800000011') { cookie = sid; csrf = body.csrfToken; userId = body.user.id; }
      else { otherCookie = sid; otherCsrf = body.csrfToken; }
    }
    await ctx.db.query(
      `INSERT INTO wallets (user_id, available_fen) VALUES ($1, 100000)
       ON CONFLICT (user_id) DO UPDATE SET available_fen = 100000, frozen_fen = 0`, [userId]);
    await ctx.db.query(`INSERT INTO characters (id, user_id, name, description)
      VALUES ('chr_baby00000001', $1, '宝宝', '好奇活泼的宝宝')`, [userId]);
    // 宝宝在本作品风格（anime）下已有成功形象：确认 A 无形象缺口
    await ctx.db.query(
      `INSERT INTO character_looks (id, character_id, style_id) VALUES ('look_baby_be6', 'chr_baby00000001', 'anime')`);
    await ctx.db.query(
      `INSERT INTO look_versions (id, look_id, status, image_key)
       VALUES ('lkv_baby_be6', 'look_baby_be6', 'succeeded', 'users/u/looks/a.png')`);
    await ctx.db.query(
      `UPDATE character_looks SET selected_version_id = 'lkv_baby_be6' WHERE id = 'look_baby_be6'`);
    sample = await makeVideo(join(tmpdir(), 'be6-30s.mp4'));
  });
  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await ctx.drop();
  });

  function request(method, path, { body, cookie: c, csrf: token } = {}) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (c) headers.Cookie = c;
    if (token) { headers['X-CSRF-Token'] = token; headers.Origin = 'http://localhost:5173'; }
    return fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  }

  /** 走完 创建→understand→确认A→确认B→bind→串行链→compose，返回 projectId 与驱动器。 */
  async function createAtDelivered(idemKey) {
    const created = await createProject(ctx.db, { userId,
      input: { storyText: '宝宝在公园野餐，追逐树叶。', sourceType: 'text', styleId: 'anime',
        qualityTierId: 'standard', ratio: '9:16', characterIds: ['chr_baby00000001'], idempotencyKey: idemKey },
      config });
    const understand = createUnderstandHandler({ db: ctx.db, logger: silent,
      storyAgent: createStoryAgent({ llm: createMockLlm([JSON.stringify(PLAN)]), logger: silent }), config });
    const job = (await ctx.db.query(`SELECT * FROM jobs WHERE dedupe_key = $1`,
      [`project:understand:${created.projectId}`])).rows[0];
    await understand(job.payload, { db: ctx.db, logger: silent, job, enqueue: async () => {} });
    await confirmStory(ctx.db, { userId, projectId: created.projectId, idempotencyKey: `${idemKey}-cs`, config });
    const { quoteId } = await ctx.db.tx((t) => createQuote(t, { userId,
      request: { kind: 'project_render', projectId: created.projectId } }));
    await confirmCast(ctx.db, { userId, projectId: created.projectId, quoteId, idempotencyKey: `${idemKey}-cc`, config });
    const videoProvider = { id: 'fake-video', submissions: [],
      prepare(input) { return input; },
      async submit(prepared) { this.submissions.push(prepared);
        return { status: 'running', upstreamId: `up_${this.submissions.length}` }; },
      async query() { return { status: 'succeeded', outputs: [{ url: 'https://upstream.example/v.mp4', kind: 'video' }] }; },
      normalize(raw) { return raw; } };
    const bind = createBindPromptsHandler({ db: ctx.db, logger: silent,
      storyAgent: createStoryAgent({ llm: createMockLlm([timeline]), logger: silent }) });
    const render = createRender({ logger: silent });
    const generate = createSegmentGenerateHandler({ db: ctx.db, logger: silent, config, videoProvider, storage });
    const poll = createGenPollHandler({ db: ctx.db, logger: silent, config, videoProvider, storage, render,
      downloadToTempFile: async (_url, localPath) => { await copyFile(sample, localPath); return localPath; } });
    const compose = createComposeHandler({ db: ctx.db, logger: silent, config, storage, render,
      fetchLocal: async (_key, localPath) => { await copyFile(sample, localPath); return localPath; } });
    const ctxOf = () => ({ db: ctx.db, logger: silent, enqueue: async (spec) => {
      if (spec.type === 'segment.generate') return generate(spec.payload, ctxOf());
      if (spec.type === 'gen.poll') return poll(spec.payload, ctxOf());
      if (spec.type === 'project.compose') return compose(spec.payload, ctxOf());
    }, extendLease: async () => {} });
    await bind({ projectId: created.projectId }, ctxOf());
    return { projectId: created.projectId, videoProvider, generate, poll, compose, ctxOf };
  }

  test('创建/详情/列表：契约、CSRF/同源、他人 404、幂等重放', async () => {
    const body = { storyText: '宝宝在公园野餐，追逐树叶。', sourceType: 'text', styleId: 'anime',
      qualityTierId: 'standard', ratio: '9:16', characterIds: ['chr_baby00000001'],
      idempotencyKey: 'api-create-0001' };
    assert.equal((await request('POST', '/projects', { body })).status, 401, '未登录 401');
    assert.equal((await request('POST', '/projects', { body, cookie })).status, 403, '缺 CSRF 403');
    const badOrigin = await fetch(`${base}/projects`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie, 'X-CSRF-Token': csrf,
        Origin: 'https://evil.example' }, body: JSON.stringify(body) });
    assert.equal(badOrigin.status, 403, '坏 Origin 403');
    const created = await request('POST', '/projects', { body, cookie, csrf });
    assert.equal(created.status, 201);
    const detail = await created.json();
    checkShape('ProjectDetail', detail);
    checkShape('CastMember', detail.cast[0], { requireAll: false });
    checkShape('Segment', detail.segments[0], { requireAll: false });
    checkShape('Pricing', detail.pricing);
    assert.equal(detail.status, 'understanding');
    const replay = await request('POST', '/projects', { body, cookie, csrf });
    assert.equal(replay.status, 200);
    assert.equal((await replay.json()).id, detail.id);
    assert.equal((await request('GET', `/projects/${detail.id}`, { cookie })).status, 200);
    // 他人 404
    const otherRes = await request('GET', `/projects/${detail.id}`, { cookie: otherCookie, csrf: otherCsrf });
    assert.equal(otherRes.status, 404);
    // 列表契约
    const list = await request('GET', '/projects?group=active', { cookie });
    assert.equal(list.status, 200);
    const listBody = await list.json();
    checkShape('ProjectSummary', listBody.items[0]);
  });

  test('交付后：PATCH plot、re-take 新增候选、selection 切换重拼接、下载 attname', async () => {
    const flow = await createAtDelivered('api-flow-0001');
    const { projectId } = flow;
    const pause = await request('POST', `/projects/${projectId}/pause`, { cookie, csrf });
    assert.equal(pause.status, 409, 'delivered 不能暂停');
    const download = await fetch(`${base}/projects/${projectId}/download`,
      { redirect: 'manual', headers: { Cookie: cookie } });
    assert.equal(download.status, 302);
    const location = download.headers.get('location');
    assert.match(location, /attname=/, '下载链接带 attname 文件名');
    assert.match(location, /^https?:\/\//);
    const segmentId = (await ctx.db.query(`SELECT id FROM segments WHERE project_id = $1 ORDER BY idx`,
      [projectId])).rows[0].id;
    const patched = await request('PATCH', `/projects/${projectId}/segments/${segmentId}`,
      { body: { plot: '修改后的剧情。' }, cookie, csrf });
    assert.equal(patched.status, 200);
    checkShape('ProjectDetail', await patched.json());
    // re-take：新增候选
    const { quoteId } = await ctx.db.tx((t) => createQuote(t, { userId,
      request: { kind: 'segment_take', projectId, segmentId } }));
    // 先让首 take 成功（提交→轮询），作为「旧版本」
    await flow.generate({ projectId, idx: 0 }, flow.ctxOf());
    const ledgerRows = (await ctx.db.query(
      `SELECT kind, amount_fen, frozen_delta_fen, idempotency_key FROM ledger
        WHERE ref_type = 'project' AND ref_id = $1 ORDER BY created_at`, [projectId])).rows;
    console.log('DEBUG ledger:', JSON.stringify(ledgerRows));
    console.log('DEBUG wallet:', JSON.stringify((await ctx.db.query(
      `SELECT available_fen, frozen_fen FROM wallets WHERE user_id = $1`, [userId])).rows[0]));
    await flow.poll({ takeId: (await ctx.db.query(
      `SELECT t.id FROM segment_takes t JOIN segments s ON s.id = t.segment_id
        WHERE s.project_id = $1 AND s.idx = 0 ORDER BY t.created_at ASC, t.id ASC LIMIT 1`,
      [projectId])).rows[0].id }, flow.ctxOf());
    // 交付后 re-take：新增候选
    const retakeQuote = await ctx.db.tx((t) => createQuote(t, { userId,
      request: { kind: 'segment_take', projectId, segmentId } }));
    const takeRes = await request('POST', `/projects/${projectId}/segments/${segmentId}/takes`,
      { body: { quoteId: retakeQuote.quoteId, idempotencyKey: 'api-take-0001' }, cookie, csrf });
    assert.equal(takeRes.status, 200);
    // 驱动 re-take 的生成 job（新 take 上提交→轮询→成功；delivered 项目状态保持不变）
    const newTakeId = (await ctx.db.query(
      `SELECT t.id FROM segment_takes t JOIN segments s ON s.id = t.segment_id
        WHERE s.project_id = $1 AND s.idx = 0 ORDER BY t.created_at DESC, t.id DESC LIMIT 1`,
      [projectId])).rows[0].id;
    console.log('DEBUG wallet before retake poll:', JSON.stringify((await ctx.db.query(
      `SELECT available_fen, frozen_fen FROM wallets WHERE user_id = $1`, [userId])).rows[0]), 'newTakeId:', newTakeId);
    await flow.generate({ projectId, idx: 0, takeId: newTakeId, redelivery: true }, flow.ctxOf());
    await flow.poll({ takeId: newTakeId }, flow.ctxOf());
    const detail2 = await takeRes.json();
    const segment2 = detail2.segments.find((segment) => segment.id === segmentId);
    assert.equal(segment2.takes.length, 2, '新增候选，不覆盖旧版本');
    // 切换选中 → 重拼接（新 render 行）
    const rendersBefore = (await ctx.db.query(`SELECT count(*)::int AS n FROM renders WHERE project_id = $1`,
      [projectId])).rows[0].n;
    const newTake = segment2.takes.find((take) => take.id !== segment2.selectedTakeId);
    const selectRes = await request('PUT', `/projects/${projectId}/segments/${segmentId}/selection`,
      { body: { takeId: newTake.id }, cookie, csrf });
    assert.equal(selectRes.status, 200);
    // 驱动 selection 触发的重拼接 job（生产由 worker 领取）
    try {
      await flow.compose({ projectId }, flow.ctxOf());
    } catch (error) {
      console.log('DEBUG compose threw:', error.name, error.message);
    }
    console.log('DEBUG renders rows:', JSON.stringify((await ctx.db.query(
      `SELECT status, video_key IS NOT NULL AS has_video FROM renders WHERE project_id = $1 ORDER BY created_at`,
      [projectId])).rows));
    const rendersAfter = (await ctx.db.query(`SELECT count(*)::int AS n FROM renders WHERE project_id = $1`,
      [projectId])).rows[0].n;
    assert.ok(rendersAfter > rendersBefore, `重新拼接走新的 render 记录（${rendersBefore}→${rendersAfter}）`);
    assert.equal((await request('GET', `/projects/${projectId}`, { cookie })).status, 200);
  }, { timeout: 240_000 });

  test('SSE：鉴权、他人 404、快照与事件补发（Last-Event-ID）', async () => {
    const { projectId } = await createAtDelivered('api-sse-0001');
    const other = await fetch(`${base}/projects/${projectId}/events`,
      { headers: { Cookie: otherCookie } });
    assert.equal(other.status, 404, '他人访问 SSE 404');
    const events = await fetch(`${base}/projects/${projectId}/events`, { headers: { Cookie: cookie } });
    assert.equal(events.status, 200);
    assert.match(events.headers.get('content-type'), /text\/event-stream/);
    const reader = events.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !buffer.includes('event: project')) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
    }
    await reader.cancel();
    assert.match(buffer, /event: project/);
    assert.match(buffer, /"projectId"/);
    // 断线重连补发：插一条事件，Last-Event-ID 设为更早的 id
    await ctx.db.query(
      `INSERT INTO project_events (project_id, status, progress, changed)
       VALUES ($1, 'delivered', $2, '{render}')`,
      [projectId, JSON.stringify({ percent: 100, message: '重新拼接完成' })]);
    const maxId = (await ctx.db.query(`SELECT max(id)::int AS id FROM project_events WHERE project_id = $1`,
      [projectId])).rows[0].id;
    const replay = await fetch(`${base}/projects/${projectId}/events`,
      { headers: { Cookie: cookie, 'Last-Event-ID': String(maxId - 1) } });
    const replayReader = replay.body.getReader();
    let replayBuffer = '';
    const replayDeadline = Date.now() + 5000;
    while (Date.now() < replayDeadline && !replayBuffer.includes('重新拼接完成')) {
      const { value, done } = await replayReader.read();
      if (done) break;
      replayBuffer += decoder.decode(value, { stream: true });
    }
    await replayReader.cancel();
    assert.match(replayBuffer, /重新拼接完成/, '错过的事件应从 project_events 补发');
  }, { timeout: 60_000 });

  test('删除：软删除 + 立即删除视频文件 + 再次访问 404', async () => {
    const { projectId } = await createAtDelivered('api-delete-0001');
    const del = await request('DELETE', `/projects/${projectId}`, { cookie, csrf });
    assert.equal(del.status, 200);
    const { rows } = await ctx.db.query(`SELECT deleted_at FROM projects WHERE id = $1`, [projectId]);
    assert.ok(rows[0].deleted_at);
    assert.equal((await request('GET', `/projects/${projectId}`, { cookie })).status, 404);
    const { rows: keys } = await ctx.db.query(
      `SELECT video_key, cover_key FROM renders WHERE project_id = $1`, [projectId]);
    assert.ok(keys.every((row) => row.video_key === null && row.cover_key === null), 'key 已清空');
    assert.ok(storage.removed.some((key) => key.includes(projectId)), '视频对象已从存储删除');
  });

  test('进行中控制：casting 暂停/恢复到 cast_review；expired 接口 410', async () => {
    // expired 410：造一个 expired 项目
    const { projectId: expiredId } = await createAtDelivered('api-expire-0001');
    await ctx.db.query(`UPDATE projects SET status = 'expired' WHERE id = $1`, [expiredId]);
    const segmentId = (await ctx.db.query(`SELECT id FROM segments WHERE project_id = $1 ORDER BY idx`,
      [expiredId])).rows[0].id;
    assert.equal((await request('PATCH', `/projects/${expiredId}/segments/${segmentId}`,
      { body: { plot: 'x' }, cookie, csrf })).status, 410);
    assert.equal((await fetch(`${base}/projects/${expiredId}/download`,
      { redirect: 'manual', headers: { Cookie: cookie } })).status, 410);
    // casting 暂停（带形象缺口：妈妈需要新生成）→ 恢复（版本已绑定 → cast_review）
    const pausePlan = { title: '野餐', synopsis: 's',
      bible: { mood: 'warm', characters: [{ castIndex: 0, handle: 'the mother', brief: 'a mother' }, { castIndex: 1, handle: 'the girl', brief: 'a girl' }],
        scenes: [{ id: 's1', nameZh: '公园', description: 'a park lawn in daylight' }], props: [] },
      cast: [{ name: '妈妈', description: '温柔', gender: 'female', ageGroup: 'middle' },
        { name: '宝宝', description: '活泼', gender: 'female', ageGroup: 'child', characterId: 'chr_baby00000001' }],
      segments: [{ durationSeconds: 30, sceneId: 's1', propIds: [], endState: 'both sit', plot: '野餐。',
        cameraNotes: '', dialogue: [], ambience: '', transition: 'hard_cut', castIndexes: [0, 1] }] };
    const created = await createProject(ctx.db, { userId,
      input: { storyText: '妈妈说：「慢一点。」宝宝说：「好。」', sourceType: 'text', styleId: 'anime',
        qualityTierId: 'standard', ratio: '9:16', characterIds: ['chr_baby00000001'],
        idempotencyKey: 'api-pause-0001' }, config });
    const understand = createUnderstandHandler({ db: ctx.db, logger: silent,
      storyAgent: createStoryAgent({ llm: createMockLlm([JSON.stringify(pausePlan)]), logger: silent }), config });
    const job = (await ctx.db.query(`SELECT * FROM jobs WHERE dedupe_key = $1`,
      [`project:understand:${created.projectId}`])).rows[0];
    await understand(job.payload, { db: ctx.db, logger: silent, job, enqueue: async () => {} });
    const { quoteId } = await ctx.db.tx((t) => createQuote(t, { userId,
      request: { kind: 'cast_looks', projectId: created.projectId } }));
    await confirmStory(ctx.db, { userId, projectId: created.projectId, quoteId,
      idempotencyKey: 'api-pause-0001-cs', config });
    const statusNow = (await ctx.db.query(`SELECT status FROM projects WHERE id = $1`,
      [created.projectId])).rows[0].status;
    assert.equal(statusNow, 'casting');
    const paused = await request('POST', `/projects/${created.projectId}/pause`, { cookie, csrf });
    assert.equal(paused.status, 200);
    const pausedBody = await paused.json();
    checkShape('ProjectDetail', pausedBody);
    assert.equal(pausedBody.status, 'paused');
    assert.equal(pausedBody.pausedFrom, 'casting');
    const resumed = await request('POST', `/projects/${created.projectId}/resume`, { cookie, csrf });
    const resumedBody = await resumed.json();
    assert.equal(resumedBody.status, 'cast_review', 'resume 后版本已绑定即推进 cast_review');
  });
});