// 渠道路由与业务链路集成（M2-BE-03 验收项）：look.generate 经路由并绑定 channel_id、
// 切换只影响新提交（在途回原渠道）、停用渠道仍可轮询、视频 unknown 不重提、
// 用户侧门禁 NO_ACTIVE_CHANNEL 503、image attempts 记录（524 重试）。
// 用进程内假驱动注册进 driver registry（通过测试目录 _test-fake-driver/ 由扫描装载）。
import assert from 'node:assert/strict';
import { before, after, describe, test } from 'node:test';
import { createTestDb } from '../helpers/db.js';
import { createLogger } from '../../src/logger.js';
import { createDriverRegistry } from '../../src/engine/providers/registry.js';
import { createChannelService } from '../../src/channels/service.js';
import { createChannelRouter } from '../../src/channels/router.js';
import { encryptCredential } from '../../src/channels/crypto.js';
import { createLookGenerateHandler } from '../../src/characters/service.js';
import { createGenPollHandler, createSegmentGenerateHandler } from '../../src/projects/segment.js';
import { newId } from '../../src/db/ids.js';

const silent = createLogger({ level: 'silent' });
const SECRET = 'r'.repeat(40);

/** 测试假驱动：kinds ['video','image','llm']；submit/query 行为脚本化（submissions/queries 数组），并记录调用。 */
function fakeDriverModule() {
  const state = {
    submissions: { video: [], image: [], llm: [] },  // 按 kind 的脚本（'accepted' | 'failed' | 'unknown' | 'throw-retryable' | 'gateway-retry-ok' | 'ok'）
    queries: [],       // 'running' | 'succeeded' | 'failed' | 'throw'
    submitCalls: [], queryCalls: [],
  };
  const driver = {
    id: 'fake-router-test',
    kinds: ['video', 'image', 'llm'],
    configSchema: { baseUrl: 'url', credential: 'secret', params: {} },
    create(channel) {
      const model = channel.modelMap?.[channel.kind] ?? 'fake-model';
      const sink = state;
      if (channel.kind === 'video') {
        return {
          id: `fake/${model}`,
          capabilities: () => ({ model, durations: [5, 30], resolutions: ['480p', '720p'], ratios: ['9:16', '16:9'], refImages: 5, refAudio: 1, withAudio: true }),
          prepare: (input) => ({ model, prompt: input.prompt, seconds: input.durationSeconds }),
          async submit(prepared) {
            sink.submitCalls.push({ kind: 'video', channel: channel.name, prepared });
            const outcome = sink.submissions.video.shift() ?? 'accepted';
            if (outcome === 'throw-retryable') {
              const error = new Error('连接失败'); error.retryable = true; error.submitted = false; throw error;
            }
            if (outcome === 'unknown') return { status: 'unknown' };
            if (outcome === 'failed') return { status: 'failed', error: '明确拒绝' };
            return { status: 'running', upstreamId: `fake-${sink.submitCalls.length}` };
          },
          async query(upstreamId) {
            sink.queryCalls.push({ channel: channel.name, upstreamId });
            const outcome = sink.queries.shift() ?? 'succeeded';
            if (outcome === 'throw') throw new Error('查询网络失败');
            if (outcome === 'running') return { status: 'running' };
            if (outcome === 'failed') return { status: 'failed', error: '上游业务失败' };
            return { status: 'succeeded', outputs: [{ kind: 'video', url: 'https://cdn.example.test/v.mp4' }] };
          },
          normalize: (raw) => raw,
        };
      }
      if (channel.kind === 'image') {
        return {
          id: `fake/${model}`,
          capabilities: () => ({ model, resolutions: ['1k'], ratios: ['1:1'], refImages: 1, withAudio: false }),
          async generate(input) {
            sink.submitCalls.push({ kind: 'image', channel: channel.name, input });
            const outcome = sink.submissions.image.shift() ?? 'ok';
            if (outcome === 'unknown') return { status: 'unknown', attempts: 1 };
            if (outcome === 'gateway-retry-ok') return { status: 'succeeded', attempts: 2,
              buffer: Buffer.from('fake-png'), contentType: 'image/png' };
            return { status: 'succeeded', buffer: Buffer.from('fake-png'), contentType: 'image/png', attempts: 1 };
          },
        };
      }
      return {
        id: `fake/${model}`,
        capabilities: () => ({ model }),
        async complete() { return { text: 'ok', usage: { inputTokens: 1, outputTokens: 1 } }; },
      };
    },
  };
  return { driver, state };
}

describe('渠道路由 × 业务链路（M2-BE-03 验收）', () => {
  let testDb;
  let db;
  let registry;
  let service;
  let router;
  let fake;
  let userId;

  before(async () => {
    testDb = await createTestDb();
    db = testDb.db;
    fake = fakeDriverModule();
    registry = createDriverRegistry(new Map([['fake-router-test', fake.driver]]));
    service = createChannelService({ db, secretKey: SECRET, registry, logger: silent });
    router = createChannelRouter({ db, service, registry, logger: silent, deps: {} });
    userId = 'usr_routerflow001';
    await db.query(`INSERT INTO users (id, phone, nickname) VALUES ($1, '15999000101', '路由流测试') ON CONFLICT (id) DO NOTHING`, [userId]);
    await db.query(`INSERT INTO wallets (user_id, available_fen, frozen_fen) VALUES ($1, 100000, 0) ON CONFLICT (user_id) DO NOTHING`, [userId]);
  });
  after(async () => { await testDb.drop(); });

  async function addChannel(kind, name) {
    const { rows: [row] } = await db.query(
      `INSERT INTO provider_channels (id, kind, name, driver, base_url, credential_enc, model_map)
       VALUES ($1, $2, $3, 'fake-router-test', 'https://fake.example.test', $4, $5) RETURNING *`,
      [newId('pch'), kind, name, encryptCredential(SECRET, `sk-${name}`),
        JSON.stringify({ [kind]: 'fake-model' })]);
    return row;
  }
  const noAudit = async () => {};

  test('无生效渠道：门禁 503 NO_ACTIVE_CHANNEL（中文文案，不暴露渠道名）', async () => {
    await assert.rejects(router.pick('video'), (error) => {
      assert.equal(error.status, 503);
      assert.equal(error.code, 'NO_ACTIVE_CHANNEL');
      assert.ok(/暂时不可用/.test(error.message));
      assert.ok(!/渠道|driver|fake/.test(error.message), '用户文案不出现渠道/厂商字样');
      return true;
    });
  });

  test('look.generate 经路由：channel_id 写入 gen_tasks；attempts 记入 result（524 重试口径）', async () => {
    const channel = await addChannel('image', 'img-a');
    await service.setRoutes('image', '*', [channel.id], noAudit);
    const { rows: [character] } = await db.query(
      `INSERT INTO characters (id, user_id, name) VALUES ($1, $2, '路由流角色') RETURNING *`,
      [newId('chr'), userId]);
    const { rows: [look] } = await db.query(
      `INSERT INTO character_looks (id, character_id, style_id) VALUES ($1, $2, 'realistic') RETURNING *`,
      [newId('look'), character.id]);
    void look;
    const genTaskId = 'gt_' + 'routerflow01';
    const versionId = newId('lkv');
    await db.tx(async (t) => {
      await t.query(
        `INSERT INTO gen_tasks (id, user_id, kind, provider, status, request, idempotency_key)
         VALUES ($1, $2, 'image', 'pending', 'created', $3, $4)`,
        [genTaskId, userId, JSON.stringify({ versionId, characterId: character.id, styleId: 'realistic',
          storageKey: `users/${userId}/looks/${versionId}`, amountFen: 0, promptHint: 'p', description: 'd',
          referenceKeys: [] }), 'idem-routerflow-1']);
      await t.query(
        `INSERT INTO look_versions (id, look_id, gen_task_id, status)
         VALUES ($1, $2, $3, 'pending')`,
        [versionId, look.id, genTaskId]);
    });
    fake.state.submissions.image = ['gateway-retry-ok']; // 524 重试一次后成功
    const memoryStorage = { put: async () => {} };
    const handler = createLookGenerateHandler({ db, logger: silent, storage: memoryStorage,
      imageProvider: { id: 'unused' }, channelRouter: router });
    const ctx = { db, logger: silent, job: { attempts: 0 }, enqueue: async () => {}, extendLease: async () => {} };
    await handler({ versionId }, ctx);
    const { rows: [task] } = await db.query(`SELECT channel_id, status, result FROM gen_tasks WHERE id = $1`, [genTaskId]);
    assert.equal(task.status, 'succeeded');
    assert.equal(task.channel_id, channel.id, '提交时绑定了渠道');
    assert.equal(task.result.attempts, 2, '网关重试的 attempts 记入尝试记录（平台承担重试成本）');
    assert.equal(fake.state.submitCalls.filter((call) => call.kind === 'image')[0].channel, 'img-a');
    // 真实请求统计落了 channel_events
    const { rows: [event] } = await db.query(
      `SELECT outcome FROM channel_events WHERE channel_id = $1 ORDER BY id DESC LIMIT 1`, [channel.id]);
    assert.equal(event.outcome, 'succeeded');
  });

  test('切换只影响新提交：旧渠道任务轮询回原渠道；旧渠道停用后仍可轮询', async () => {
    const a = await addChannel('video', 'vid-a');
    const b = await addChannel('video', 'vid-b');
    await service.setRoutes('video', '*', [a.id], noAudit);
    // 在 a 上建一个 video 任务（模拟已提交 running）
    const projectId = newId('prj');
    const segmentId = newId('seg');
    const takeId = newId('take');
    const genTaskA = newId('gt');
    await db.tx(async (t) => {
      await t.query(`UPDATE wallets SET available_fen = available_fen - 500, frozen_fen = frozen_fen + 500
        WHERE user_id = $1`, [userId]);
      await t.query(`INSERT INTO projects (id, user_id, story_text, source_type, style_id, quality_tier_id, tier_mapping_id, ratio, status)
        VALUES ($1, $2, '故事', 'text', 'realistic', 'standard', 'tm_standard00000001', '9:16', 'rendering')`, [projectId, userId]);
      await t.query(`INSERT INTO segments (id, project_id, idx, duration_seconds, plot, transition, final_prompt)
        VALUES ($1, $2, 0, 5, '剧情', 'hard_cut', $3)`,
        [segmentId, projectId, JSON.stringify({ prompt: 'A girl waves.', imageRefs: [], usePrevTail: false })]);
      await t.query(`INSERT INTO gen_tasks (id, user_id, kind, provider, status, request, idempotency_key, channel_id, upstream_id, next_poll_at)
        VALUES ($1, $2, 'video', 'fake', 'running', $3, $4, $5, 'fake-legacy', now() - interval '1 second')`,
        [genTaskA, userId, JSON.stringify({ projectId, amountFen: 500, durationSeconds: 5, ratio: '9:16',
          resolution: '480p', prompt: 'p', imageRefs: [], audioRefs: [],
          videoKey: `users/${userId}/projects/${projectId}/takes/${takeId}.mp4`,
          lastFrameKey: `users/${userId}/projects/${projectId}/takes/${takeId}.last.jpg` }),
          `idem-${genTaskA}`, a.id]);
      await t.query(`INSERT INTO segment_takes (id, segment_id, gen_task_id, status)
        VALUES ($1, $2, $3, 'running')`, [takeId, segmentId, genTaskA]);
    });
    // 切换到 b + 停用 a（切换与停用都不影响在途）
    await service.setRoutes('video', '*', [b.id], noAudit);
    await service.setChannelStatus(a.id, 'disabled', noAudit);
    fake.state.queries = ['succeeded'];
    const { writeFile, mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const fakeDir = await mkdtemp(join(tmpdir(), 'miv-routerflow-'));
    const lastFrameFile = join(fakeDir, 'x.jpg');
    const poll = createGenPollHandler({ db, logger: silent, config: { projects: { genPollTimeoutSeconds: 7200, genPollIntervalSeconds: 5 } },
      videoProvider: { id: 'unused' }, storage: { put: async () => {} },
      render: { inspect: async () => ({ ok: true }), extractLastFrame: async () => { await writeFile(lastFrameFile, 'x'); return lastFrameFile; } },
      downloadToTempFile: async (url, target) => writeFile(target, 'fake-mp4'), channelRouter: router });
    const ctx = { db, logger: silent, job: { attempts: 0 }, enqueue: async () => {}, extendLease: async () => {} };
    await poll({ takeId }, ctx);
    assert.equal(fake.state.queryCalls[0].channel, 'vid-a', '轮询回到任务绑定的原渠道（已停用仍可轮询）');
    const { rows: [task] } = await db.query(`SELECT status FROM gen_tasks WHERE id = $1`, [genTaskA]);
    assert.equal(task.status, 'succeeded', '在途任务正常收割');
    // 新提交用 b
    const picked = await router.pick('video');
    assert.equal(picked.channelId, b.id);
  });

  test('视频提交结果 unknown：任务 unknown 冻结，绝不重提（上游只收到一次提交）', async () => {
    const b = (await service.getChannelByName('video', 'vid-b'));
    const projectId = newId('prj');
    const segmentId = newId('seg');
    const takeId = newId('take');
    const genTaskId = newId('gt');
    await db.tx(async (t) => {
      await t.query(`INSERT INTO projects (id, user_id, story_text, source_type, style_id, quality_tier_id, tier_mapping_id, ratio, status)
        VALUES ($1, $2, '故事2', 'text', 'realistic', 'standard', 'tm_standard00000001', '9:16', 'rendering')`, [projectId, userId]);
      await t.query(`INSERT INTO segments (id, project_id, idx, duration_seconds, plot, transition, final_prompt)
        VALUES ($1, $2, 0, 5, '剧情', 'hard_cut', $3)`,
        [segmentId, projectId, JSON.stringify({ prompt: 'A girl waves.', imageRefs: [], usePrevTail: false })]);
      await t.query(`INSERT INTO gen_tasks (id, user_id, kind, provider, status, request, idempotency_key)
        VALUES ($1, $2, 'video', 'fake', 'created', $3, $4)`,
        [genTaskId, userId, JSON.stringify({ projectId, amountFen: 500, durationSeconds: 5, ratio: '9:16',
          resolution: '480p', prompt: 'p', imageRefs: [], audioRefs: [],
          videoKey: `users/${userId}/projects/${projectId}/takes/${takeId}.mp4`,
          lastFrameKey: `users/${userId}/projects/${projectId}/takes/${takeId}.last.jpg` }),
          `idem-${genTaskId}`]);
      await t.query(`INSERT INTO segment_takes (id, segment_id, gen_task_id, status)
        VALUES ($1, $2, $3, 'pending')`, [takeId, segmentId, genTaskId]);
    });
    void b;
    fake.state.submissions.video = ['unknown'];
    const generate = createSegmentGenerateHandler({ db, logger: silent,
      config: { projects: { refUrlTtlSeconds: 100, genPollTimeoutSeconds: 7200, genPollIntervalSeconds: 5 } },
      videoProvider: { id: 'unused' }, storage: { signedUrl: async (key) => `https://cdn.example.test/${key}` },
      channelRouter: router });
    const ctx = { db, logger: silent, job: { attempts: 0 }, enqueue: async () => {}, extendLease: async () => {} };
    await generate({ projectId, idx: 0, takeId }, ctx);
    const { rows: [task] } = await db.query(`SELECT status, channel_id FROM gen_tasks WHERE id = $1`, [genTaskId]);
    assert.equal(task.status, 'unknown', 'unknown 冻结待对账');
    assert.equal(task.channel_id, (await service.getChannelByName('video', 'vid-b')).id);
    assert.equal(fake.state.submitCalls.filter((call) => call.kind === 'video').length, 1, '上游只收到一次提交');
    const { rows: [project] } = await db.query(`SELECT status, error FROM projects WHERE id = $1`, [projectId]);
    assert.equal(project.status, 'failed');
    assert.equal(project.error.code, 'TAKE_UNKNOWN');
    // 再跑一遍（模拟误重放）：不重提
    await generate({ projectId, idx: 0, takeId }, ctx);
    assert.equal(fake.state.submitCalls.filter((call) => call.kind === 'video').length, 1, '重复执行不再提交');
  });

  test('提交明确失败（failed）：该段失败、预占退回、可重试；事件统计记 failed', async () => {
    const projectId = newId('prj');
    const segmentId = newId('seg');
    const takeId = newId('take');
    const genTaskId = newId('gt');
    await db.tx(async (t) => {
      await t.query(`INSERT INTO projects (id, user_id, story_text, source_type, style_id, quality_tier_id, tier_mapping_id, ratio, status)
        VALUES ($1, $2, '故事3', 'text', 'realistic', 'standard', 'tm_standard00000001', '9:16', 'rendering')`, [projectId, userId]);
      await t.query(`INSERT INTO segments (id, project_id, idx, duration_seconds, plot, transition, final_prompt)
        VALUES ($1, $2, 0, 5, '剧情', 'hard_cut', $3)`,
        [segmentId, projectId, JSON.stringify({ prompt: 'A girl waves.', imageRefs: [], usePrevTail: false })]);
      await t.query(`INSERT INTO gen_tasks (id, user_id, kind, provider, status, request, idempotency_key)
        VALUES ($1, $2, 'video', 'fake', 'created', $3, $4)`,
        [genTaskId, userId, JSON.stringify({ projectId, amountFen: 500, durationSeconds: 5, ratio: '9:16',
          resolution: '480p', prompt: 'p', imageRefs: [], audioRefs: [],
          videoKey: `users/${userId}/projects/${projectId}/takes/${takeId}.mp4`,
          lastFrameKey: `users/${userId}/projects/${projectId}/takes/${takeId}.last.jpg` }),
          `idem-${genTaskId}`]);
      await t.query(`INSERT INTO segment_takes (id, segment_id, gen_task_id, status)
        VALUES ($1, $2, $3, 'pending')`, [takeId, segmentId, genTaskId]);
    });
    fake.state.submissions.video = ['failed'];
    const generate = createSegmentGenerateHandler({ db, logger: silent,
      config: { projects: { refUrlTtlSeconds: 100 } },
      videoProvider: { id: 'unused' }, storage: { signedUrl: async (key) => `https://cdn.example.test/${key}` },
      channelRouter: router });
    const ctx = { db, logger: silent, job: { attempts: 0 }, enqueue: async () => {}, extendLease: async () => {} };
    await generate({ projectId, idx: 0, takeId }, ctx);
    const { rows: [task] } = await db.query(`SELECT status FROM gen_tasks WHERE id = $1`, [genTaskId]);
    assert.equal(task.status, 'failed', '明确拒绝 → failed（不冻结）');
    const { rows: [project] } = await db.query(`SELECT status, error FROM projects WHERE id = $1`, [projectId]);
    assert.equal(project.status, 'failed');
  });
});
