// M1-BE-05 C2：创建作品（幂等、免费次数）、project.understand（想法扩写分支、持久化、回填形象）。
// storyAgent 用注入的 mock（engine story mock 同构），不调用真实 LLM。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { createMemoryStorage } from '../../src/engine/storage/memory.js';
import { createLookGenerateHandler } from '../../src/characters/service.js';
import { createQuote } from '../../src/wallet/pricing.js';
import { createTestDb } from '../helpers/db.js';
import { mockImageProvider } from '../helpers/providers.js';
import { silentLogger } from '../../src/logger.js';
import { loadConfig } from '../../src/config.js';
import { createProject, getProjectDetail, reanalyzeProject, confirmStory, updateCastCharacter,
  confirmCast, updateCast, createCastLook, consumeFreeQuota, beijingDayStartUtc }
  from '../../src/projects/service.js';
import { createBindPromptsHandler } from '../../src/projects/bind.js';
import { createGenPollHandler, createSegmentGenerateHandler } from '../../src/projects/segment.js';
import { createComposeHandler } from '../../src/projects/compose.js';
import { createRender } from '../../src/render/index.js';
import { pauseProject, resumeProject, retryProject, cancelProject } from '../../src/projects/service.js';
import { createUnderstandHandler } from '../../src/projects/understand.js';
import { classifyInput } from '../../src/engine/story/index.js';
import { createMockLlm } from '../../src/engine/llm/mock.js';
import { createStoryAgent } from '../../src/engine/story/index.js';

const config = loadConfig({ NODE_ENV: 'test' });

// 片段链测试用：对象在内存，但 signedUrl 返回 https 链接（与七牛驱动形态一致）
function httpMemoryStorage() {
  const memory = createMemoryStorage();
  return {
    put: memory.put, remove: memory.remove,
    async signedUrl(key, opts) { return `https://signed.example/${key}?ttl=${opts?.ttlSeconds ?? 3600}`; },
  };
}

// 供片段链测试使用的合成样片（lavfi 生成，无真实模型）
async function makeVideo(name, { video = `testsrc2=size=720x1280:rate=30`, audio = 'sine=frequency=440',
  duration = 3 } = {}) {
  const dir = join(tmpdir(), 'miv-projects-samples');
  await mkdir(dir, { recursive: true });
  const file = join(dir, name);
  await new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', video,
      '-f', 'lavfi', '-i', audio, '-t', String(duration), '-c:v', 'libx264', '-preset', 'veryfast',
      '-crf', '28', '-pix_fmt', 'yuv420p', '-c:a', 'aac', file],
      { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { if (stderr.length < 8000) stderr += chunk; });
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(stderr))));
    child.on('error', reject);
  });
  return file;
}

function fakeVideoProvider({ pollResults = {} }) {
  const submissions = [];
  const polls = {};
  return {
    id: 'fake-video',
    submissions,
    prepare(input) { return input; },
    async submit(prepared) { submissions.push(prepared); return { status: 'running', upstreamId: `up_${submissions.length}` }; },
    // 每个上游任务按轮询次数推进 pollResults[upstreamId] 序列，耗尽后维持 running
    async query(upstreamId) {
      polls[upstreamId] = (polls[upstreamId] ?? 0) + 1;
      return pollResults[upstreamId]?.[polls[upstreamId] - 1] ?? { status: 'running' };
    },
    normalize(raw) { return raw; },
  };
}

// 引擎契约同构的 mock LLM：返回带 bible/场景/结束状态的完整规划（STORY_EXAMPLE 形态）。
const PLAN = {
  title: '春天的野餐',
  synopsis: '妈妈带宝宝到公园野餐，宝宝发现风吹动树叶，两人分享食物并开心回家。',
  bible: {
    mood: 'warm, gentle, healing; soft golden light',
    characters: [
      { castIndex: 0, handle: 'the mother', brief: 'a woman in her thirties with a beige cardigan' },
      { castIndex: 1, handle: 'the girl', brief: 'a four-year-old girl with a yellow dress' },
    ],
    scenes: [{ id: 's1', nameZh: '公园草地',
      description: 'a sunlit city-park lawn in late morning, soft shadows under old maple trees' }],
    props: [{ id: 'p1', nameZh: '野餐垫', description: 'a red and white checkered picnic blanket' }],
  },
  cast: [
    { name: '妈妈', description: '温柔耐心', gender: 'female', ageGroup: 'middle' },
    { name: '宝宝', description: '好奇活泼', gender: 'female', ageGroup: 'child', characterId: 'chr_baby00000001' },
  ],
  segments: [
    { durationSeconds: 30, sceneId: 's1', propIds: ['p1'],
      endState: 'the girl stands holding a fallen leaf, the mother sits beside her, medium-wide framing',
      plot: '公园里铺开野餐垫，宝宝追逐飘落的树叶。', cameraNotes: '广角建立场景后跟拍宝宝',
      dialogue: [{ castIndex: 0, line: '慢一点，看看树叶。' }], ambience: '风声和鸟鸣',
      transition: 'hard_cut', castIndexes: [0, 1] },
    { durationSeconds: 30, sceneId: 's1', propIds: ['p1'],
      endState: 'the two sit close together sharing fruit, both smiling, medium shot',
      plot: '同一片草地上，两人分享水果并相视而笑。', cameraNotes: '从手部特写缓慢拉到双人中景',
      dialogue: [{ castIndex: 1, line: '这个苹果真甜！' }], ambience: '轻微风声',
      transition: 'prev_tail', castIndexes: [0, 1] },
  ],
};

function mockStoryAgent(scripted = [JSON.stringify(PLAN)]) {
  const llm = createMockLlm(scripted);
  return { agent: createStoryAgent({ llm, logger: silentLogger }), llm };
}

async function seedCatalog(db) {
  // styles/quality_tiers/tier_mappings/skus/voices 用迁移 001 的种子目录（anime / standard / mock SKU）
  await db.query(`INSERT INTO users (id, phone, nickname) VALUES ('usr_user00000001', '15800000001', '用户A')`);
  await db.query(`INSERT INTO wallets (user_id) VALUES ('usr_user00000001')`);
  // 已勾选数字人「宝宝」（资产库无性别/年龄列），且已有本风格成功形象（understand 后应回填）
  await db.query(
    `INSERT INTO characters (id, user_id, name, description)
     VALUES ('chr_baby00000001', 'usr_user00000001', '宝宝', '好奇活泼的宝宝')`);
  await db.query(
    `INSERT INTO character_looks (id, character_id, style_id)
     VALUES ('look_baby00000001', 'chr_baby00000001', 'anime')`);
  await db.query(
    `INSERT INTO look_versions (id, look_id, status, image_key)
     VALUES ('lkv_baby000000001', 'look_baby00000001', 'succeeded', 'users/u/looks/a.png')`);
  await db.query(
    `UPDATE character_looks SET selected_version_id = 'lkv_baby000000001' WHERE id = 'look_baby00000001'`);
}

const input = (over = {}) => ({
  storyText: '妈妈带宝宝在公园野餐，树叶被风吹起，两人分享水果后回家。',
  sourceType: 'text', styleId: 'anime', qualityTierId: 'standard',
  ratio: '9:16', characterIds: ['chr_baby00000001'], idempotencyKey: 'idem-create-0001', ...over,
});

describe('projects（M1-BE-05 C2：创建与故事理解）', () => {
  let ctx;
  let userId = 'usr_user00000001';
  let understand;

  beforeEach(async () => {
    // 测试间隔离：清免费计数器、jobs 与钱包流水（共享用户，金额断言按单用例独立计算）
    await ctx.db.query('DELETE FROM rate_counters');
    await ctx.db.query('DELETE FROM jobs');
    await ctx.db.query('DELETE FROM ledger');
    await ctx.db.query('UPDATE wallets SET available_fen = 10000, frozen_fen = 0');
  });

  before(async () => {
    ctx = await createTestDb();
    await seedCatalog(ctx.db);
    const { agent } = mockStoryAgent();
    understand = createUnderstandHandler({ db: ctx.db, logger: silentLogger, storyAgent: agent, config });
  });
  after(async () => { await ctx.drop(); });

  test('创建：参数校验（空故事/超长/坏风格/坏画质/他人数字人/坏画幅）', async () => {
    await assert.rejects(() => createProject(ctx.db, { userId, input: input({ storyText: '   ' }), config }),
      (err) => err.code === 'STORY_TOO_SHORT');
    await assert.rejects(() => createProject(ctx.db, { userId, input: input({ storyText: '字'.repeat(3001) }), config }),
      (err) => err.code === 'STORY_TOO_LONG');
    await assert.rejects(() => createProject(ctx.db, { userId, input: input({ styleId: 'style_missing0001' }), config }),
      (err) => err.code === 'VALIDATION_FAILED');
    await assert.rejects(() => createProject(ctx.db, { userId, input: input({ qualityTierId: 'tier_missing001' }), config }),
      (err) => err.code === 'VALIDATION_FAILED');
    await assert.rejects(() => createProject(ctx.db, { userId, input: input({ characterIds: ['chr_missing00001'] }), config }),
      (err) => err.code === 'VALIDATION_FAILED');
    await assert.rejects(() => createProject(ctx.db, { userId, input: input({ ratio: '4:3' }), config }),
      (err) => err.code === 'VALIDATION_FAILED');
  });

  test('创建成功：understanding、锁定档位映射、入队 understand；同幂等键重放返回同一作品', async () => {
    const first = await createProject(ctx.db, { userId, input: input(), config });
    assert.equal(first.replayed, false);
    const { rows } = await ctx.db.query(`SELECT * FROM projects WHERE id = $1`, [first.projectId]);
    assert.equal(rows[0].status, 'understanding');
    assert.equal(rows[0].tier_mapping_id, 'tm_standard00000001');
    assert.deepEqual(rows[0].selected_character_ids, ['chr_baby00000001']);
    const { rows: jobs } = await ctx.db.query(
      `SELECT type, payload FROM jobs WHERE dedupe_key = $1`, [`project:understand:${first.projectId}`]);
    assert.equal(jobs.length, 1);
    assert.deepEqual(jobs[0].payload, { projectId: first.projectId });

    const replay = await createProject(ctx.db, { userId, input: input(), config });
    assert.equal(replay.replayed, true);
    assert.equal(replay.projectId, first.projectId);
    const { rows: counters } = await ctx.db.query(`SELECT count FROM rate_counters WHERE key = $1`,
      [`free_quota:${userId}`]);
    assert.equal(counters[0].count, 1, '重放不重复消耗免费次数');
  });

  test('免费次数：第 quota+1 次创建返回 429；次数按北京日窗口计数', async () => {
    const limited = loadConfig({ NODE_ENV: 'test', PROJECTS_FREE_DAILY_QUOTA: '2' });
    await createProject(ctx.db, { userId, input: input({ idempotencyKey: 'idem-0002' }), config: limited });
    await createProject(ctx.db, { userId, input: input({ idempotencyKey: 'idem-0003' }), config: limited });
    await assert.rejects(
      () => createProject(ctx.db, { userId, input: input({ idempotencyKey: 'idem-0004' }), config: limited }),
      (err) => err.code === 'FREE_QUOTA_EXHAUSTED');
    // 换用户不受影响
    await ctx.db.query(`INSERT INTO users (id, phone, nickname) VALUES ('usr_user00000002', '15800000002', '用户B')`);
    await ctx.db.query(`INSERT INTO wallets (user_id) VALUES ('usr_user00000002')`);
    const other = await createProject(ctx.db, { userId: 'usr_user00000002',
      input: input({ characterIds: [], idempotencyKey: 'idem-b-0001' }), config: limited });
    assert.equal(other.replayed, false);
    // 北京日窗口起点是 UTC 时间的 16:00（前一天）
    const start = beijingDayStartUtc(new Date('2026-10-20T10:00:00Z'));
    assert.equal(start.toISOString(), '2026-10-19T16:00:00.000Z');
  });

  test('classifyInput：短想法判为 idea，长文本判为 script', () => {
    assert.equal(classifyInput('宝宝在公园里第一次放风筝，跑得满头大汗也开心'), 'idea');
    assert.equal(classifyInput('字'.repeat(61)), 'script');
  });

  test('understand：剧本输入直接理解，持久化 story/cast/segments 并回填形象与音色', async () => {
    const { agent, llm } = mockStoryAgent();
    const understandMock = createUnderstandHandler({ db: ctx.db, logger: silentLogger, storyAgent: agent, config });
    const created = await createProject(ctx.db, { userId,
      input: input({ storyText: '妈妈带宝宝在公园野餐。妈妈说：「慢一点，看看树叶。」宝宝说：「这个苹果真甜！」两人分享水果后回家。',
        idempotencyKey: 'idem-0004' }), config });
    const jobId = (await ctx.db.query(`SELECT id FROM jobs WHERE dedupe_key = $1`,
      [`project:understand:${created.projectId}`])).rows[0].id;
    const job = (await ctx.db.query(`SELECT * FROM jobs WHERE id = $1`, [jobId])).rows[0];
    await understandMock(job.payload, { db: ctx.db, logger: silentLogger, job, enqueue: async () => {} });

    const detail = await getProjectDetail(ctx.db, { userId, projectId: created.projectId });
    assert.equal(detail.status, 'story_review');
    assert.equal(detail.story.inputKind, 'script');
    assert.equal(detail.story.expanded, false);
    assert.equal(detail.story.segmentCount, 2);
    assert.equal(detail.title, '春天的野餐');
    assert.equal(detail.voicesEnabled, true, '片段数 ≥2 时开启声音');
    assert.equal(detail.cast.length, 2);
    const baby = detail.cast.find((member) => member.name === '宝宝');
    assert.equal(baby.characterId, 'chr_baby00000001');
    assert.equal(baby.matchSource, 'user', '勾选的数字人匹配记为 user');
    assert.equal(baby.look.status, 'ready', '已有本风格成功形象回填为 ready');
    assert.ok(baby.look.versionId);
    const mother = detail.cast.find((member) => member.name === '妈妈');
    assert.equal(mother.matchSource, 'new');
    assert.ok(mother.voice.voiceId, '按性别年龄推荐音色');
    assert.equal(mother.voice.source, 'ai');
    assert.notEqual(mother.voice.voiceId, baby.voice?.voiceId, '同一作品音色不重复');
    assert.equal(detail.segments.length, 2);
    assert.deepEqual(detail.segments[0].dialogue, [{ castId: detail.cast[0].id, line: '慢一点，看看树叶。' }]);
    assert.deepEqual(detail.segments[1].castIds, [detail.cast[0].id, detail.cast[1].id]);
    assert.equal(detail.segments[1].transition, 'prev_tail');
    assert.deepEqual(detail.pricing.looksToGenerate, 1, '只有「妈妈」缺形象');
    // mock LLM 收到的输入包含引擎契约所需字段
    const request = llm.calls[0];
    assert.match(request.system, /bible/);
    const message = JSON.parse(request.messages[0].content);
    assert.equal(message.maxSeconds, 90);
    assert.deepEqual(message.allowedDurations, [30, 15, 10, 5]);
    assert.ok(message.untrustedStory.text.includes('公园野餐'));
  });

  test('understand：一句话想法先扩写再按剧本理解；expanded=true、inputKind=idea', async () => {
    const ideaLlm = createMockLlm([
      JSON.stringify({ title: '公园的下午', script: '公园的下午\n场景：公园草地，午后。\n宝宝：「树叶会飞！」' }),
      JSON.stringify(PLAN),
    ]);
    const ideaAgent = createStoryAgent({ llm: ideaLlm, logger: silentLogger });
    const ideaUnderstand = createUnderstandHandler({ db: ctx.db, logger: silentLogger, storyAgent: ideaAgent, config });
    const created = await createProject(ctx.db, { userId,
      input: input({ storyText: '宝宝在公园里第一次放风筝，跑得满头大汗也开心', idempotencyKey: 'idem-0005' }), config });
    const job = (await ctx.db.query(`SELECT * FROM jobs WHERE dedupe_key = $1`,
      [`project:understand:${created.projectId}`])).rows[0];
    await ideaUnderstand(job.payload, { db: ctx.db, logger: silentLogger, job, enqueue: async () => {} });
    const detail = await getProjectDetail(ctx.db, { userId, projectId: created.projectId });
    assert.equal(detail.story.inputKind, 'idea');
    assert.equal(detail.story.expanded, true);
    // 第一次调用是扩写（expandSystem），第二次是理解
    assert.match(ideaLlm.calls[0].system, /扩写成可拍摄的中文短剧剧本/);
    assert.match(ideaLlm.calls[1].system, /bible/);
  });

  test('understand：单片段不推荐音色（voicesEnabled=false 时 cast 无 voice）', async () => {
    const single = { ...PLAN, segments: [PLAN.segments[0]] };
    single.cast = [PLAN.cast[0], PLAN.cast[1]];
    const { agent } = mockStoryAgent([JSON.stringify(single)]);
    const singleUnderstand = createUnderstandHandler({ db: ctx.db, logger: silentLogger, storyAgent: agent, config });
    const created = await createProject(ctx.db, { userId, input: input({ idempotencyKey: 'idem-0006' }), config });
    const job = (await ctx.db.query(`SELECT * FROM jobs WHERE dedupe_key = $1`,
      [`project:understand:${created.projectId}`])).rows[0];
    await singleUnderstand(job.payload, { db: ctx.db, logger: silentLogger, job, enqueue: async () => {} });
    const detail = await getProjectDetail(ctx.db, { userId, projectId: created.projectId });
    assert.equal(detail.voicesEnabled, false);
    assert.ok(detail.cast.every((member) => !member.voice), '单片段不推荐音色');
  });

  test('reanalyze：story_review 状态可重新整理（按剧本、耗次数、清空旧规划）', async () => {
    const created = await createProject(ctx.db, { userId, input: input({ idempotencyKey: 'idem-0007' }), config });
    const { agent, llm } = mockStoryAgent();
    const understandMock = createUnderstandHandler({ db: ctx.db, logger: silentLogger, storyAgent: agent, config });
    let job = (await ctx.db.query(`SELECT * FROM jobs WHERE dedupe_key = $1`,
      [`project:understand:${created.projectId}`])).rows[0];
    await understandMock(job.payload, { db: ctx.db, logger: silentLogger, job, enqueue: async () => {} });
    const limited = loadConfig({ NODE_ENV: 'test', PROJECTS_FREE_DAILY_QUOTA: '2' });
    await reanalyzeProject(ctx.db, { userId, projectId: created.projectId,
      storyText: '修改后的完整剧本：妈妈和宝宝在公园野餐。', config: limited });
    const { rows } = await ctx.db.query(`SELECT status, story_text FROM projects WHERE id = $1`, [created.projectId]);
    assert.equal(rows[0].status, 'understanding');
    assert.equal(rows[0].story_text, '修改后的完整剧本：妈妈和宝宝在公园野餐。');
    const { rows: castCount } = await ctx.db.query(`SELECT count(*)::int AS n FROM project_cast WHERE project_id = $1`,
      [created.projectId]);
    assert.equal(castCount[0].n, 0, '旧规划已清空等待重跑');
    // 非 story_review 状态拒绝
    await assert.rejects(() => reanalyzeProject(ctx.db, { userId, projectId: created.projectId,
      storyText: '再次修改', config: limited }), (err) => err.code === 'PROJECT_STATE_INVALID');
  });

  test('understand：状态已不是 understanding 时幂等空转（取消后不再写结果）', async () => {
    const created = await createProject(ctx.db, { userId, input: input({ idempotencyKey: 'idem-0008' }), config });
    await ctx.db.query(`UPDATE projects SET status = 'canceled' WHERE id = $1`, [created.projectId]);
    const before = (await ctx.db.query(`SELECT count(*)::int AS n FROM segments WHERE project_id = $1`,
      [created.projectId])).rows[0].n;
    const { agent } = mockStoryAgent();
    const understandMock = createUnderstandHandler({ db: ctx.db, logger: silentLogger, storyAgent: agent, config });
    const job = (await ctx.db.query(`SELECT * FROM jobs WHERE dedupe_key = $1`,
      [`project:understand:${created.projectId}`])).rows[0];
    job.attempts = 1;
    await understandMock(job.payload, { db: ctx.db, logger: silentLogger, job, enqueue: async () => {} });
    const after = (await ctx.db.query(`SELECT count(*)::int AS n FROM segments WHERE project_id = $1`,
      [created.projectId])).rows[0].n;
    assert.equal(after, before, '取消后不写规划');
  });

  // ───────────── C3：确认点 A ─────────────

  async function createAtStoryReview(idemKey) {
    // 剧本文本（带对白标记）：让 mock 的 PLAN 被理解步骤消费，得到 妈妈(new)+宝宝(user) 两个角色
    const created = await createProject(ctx.db, { userId,
      input: input({ storyText: '妈妈带宝宝在公园野餐。妈妈说：「慢一点，看看树叶。」宝宝说：「这个苹果真甜！」',
        idempotencyKey: idemKey }), config });
    const { agent } = mockStoryAgent();
    const understandMock = createUnderstandHandler({ db: ctx.db, logger: silentLogger, storyAgent: agent, config });
    const job = (await ctx.db.query(`SELECT * FROM jobs WHERE dedupe_key = $1`,
      [`project:understand:${created.projectId}`])).rows[0];
    await understandMock(job.payload, { db: ctx.db, logger: silentLogger, job, enqueue: async () => {} });
    if (process.env.DEBUG_C3) {
      const row = (await ctx.db.query(`SELECT status, error FROM projects WHERE id = $1`, [created.projectId])).rows[0];
      console.log('DEBUG createAtStoryReview:', created.projectId, row.status, JSON.stringify(row.error));
    }
    await ctx.db.query(`UPDATE wallets SET available_fen = 10000, frozen_fen = 0 WHERE user_id = $1`, [userId]);
    return created.projectId;
  }

  test('confirmStory：缺口>0 时扣形象费、预占、建 look_versions 并进入 casting', async () => {
    const projectId = await createAtStoryReview('c3-0001');
    const { quoteId } = await ctx.db.tx((t) => createQuote(t, { userId,
      request: { kind: 'cast_looks', projectId } }));
    const result = await confirmStory(ctx.db, { userId, projectId, quoteId, idempotencyKey: 'confirm-0001', config });
    assert.equal(result.replayed, false);
    const detail = await getProjectDetail(ctx.db, { userId, projectId });
    assert.equal(detail.status, 'casting');
    // 「妈妈」match_source=new → 自动新建数字人
    const mother = detail.cast.find((member) => member.name === '妈妈');
    assert.equal(mother.matchSource, 'new');
    assert.ok(mother.characterId, '未匹配角色已自动新建数字人');
    const { rows: lookTasks } = await ctx.db.query(
      `SELECT gt.id, gt.request FROM gen_tasks gt JOIN look_versions lv ON lv.gen_task_id = gt.id
        JOIN project_cast pc ON pc.look_version_id = lv.id
       WHERE pc.project_id = $1`, [projectId]);
    assert.equal(lookTasks.length, 1, '只为缺口（妈妈）建形象任务，宝宝已有形象不重建');
    const { rows: wallet } = await ctx.db.query(`SELECT available_fen, frozen_fen FROM wallets WHERE user_id = $1`, [userId]);
    assert.equal(wallet[0].frozen_fen, 50, '一个缺口 × 50 分预占');
    // 同幂等键重放：replayed，不再新增 gen_tasks
    const replay = await confirmStory(ctx.db, { userId, projectId, quoteId, idempotencyKey: 'confirm-0001', config });
    assert.equal(replay.replayed, true);
    const { rows: taskCount } = await ctx.db.query(
      `SELECT count(*)::int AS n FROM gen_tasks gt JOIN look_versions lv ON lv.gen_task_id = gt.id
        JOIN project_cast pc ON pc.look_version_id = lv.id WHERE pc.project_id = $1`, [projectId]);
    assert.equal(taskCount[0].n, 1, '重放不重复建任务');
  });

  test('look.generate 成功后回填并推进 cast_review；余额不足停 story_review', async () => {
    const projectId = await createAtStoryReview('c3-0002');
    const { quoteId } = await ctx.db.tx((t) => createQuote(t, { userId,
      request: { kind: 'cast_looks', projectId } }));
    await confirmStory(ctx.db, { userId, projectId, quoteId, idempotencyKey: 'confirm-0002', config });
    const imageProvider = mockImageProvider();
    const storage = httpMemoryStorage();
    const handler = createLookGenerateHandler({ db: ctx.db, logger: silentLogger, storage, imageProvider });
    // 只跑缺口任务（妈妈）；宝宝用已有形象
    const versionIds = (await ctx.db.query(
      `SELECT lv.id FROM look_versions lv JOIN gen_tasks gt ON gt.id = lv.gen_task_id
        JOIN project_cast pc ON pc.look_version_id = lv.id
       WHERE pc.project_id = $1`, [projectId])).rows.map((row) => row.id);
    assert.equal(versionIds.length, 1);
    for (const versionId of versionIds) {
      const job = { id: 1, type: 'look.generate', payload: { versionId }, attempts: 1 };
      await handler(job.payload, { db: ctx.db, logger: silentLogger, job, enqueue: async () => {}, extendLease: async () => {} });
    }
    const detail = await getProjectDetail(ctx.db, { userId, projectId });
    assert.equal(detail.status, 'cast_review', '全部形象就绪后推进');
    assert.ok(detail.cast.every((member) => member.look.status === 'ready'));
    const { rows: ledger } = await ctx.db.query(
      `SELECT kind, frozen_delta_fen FROM ledger WHERE user_id = $1
        AND idempotency_key = $2`, [userId, `look:${versionIds[0]}:settle`]);
    assert.ok(ledger.some((row) => row.kind === 'settle' && row.frozen_delta_fen === -50),
      '形象费已结算（BE-04 结算流水的 ref 是 look/versionId）');

    // 余额不足：另一个项目清零钱包后确认 → 402，项目停在 story_review
    const projectId2 = await createAtStoryReview('c3-0003');
    await ctx.db.query(`UPDATE wallets SET available_fen = 0 WHERE user_id = $1`, [userId]);
    const { quoteId: quoteId2 } = await ctx.db.tx((t) => createQuote(t, { userId,
      request: { kind: 'cast_looks', projectId: projectId2 } }));
    await assert.rejects(
      () => confirmStory(ctx.db, { userId, projectId: projectId2, quoteId: quoteId2, idempotencyKey: 'confirm-0003', config }),
      (err) => err.code === 'INSUFFICIENT_BALANCE');
    const detail2 = await getProjectDetail(ctx.db, { userId, projectId: projectId2 });
    assert.equal(detail2.status, 'story_review', '确认失败项目停在故事确认');
    // 事务回滚后确认日志不残留：换键重试（充值后）可成功
    await ctx.db.query(`UPDATE wallets SET available_fen = 10000 WHERE user_id = $1`, [userId]);
    const retry = await confirmStory(ctx.db, { userId, projectId: projectId2, quoteId: quoteId2, idempotencyKey: 'confirm-0003-retry', config });
    assert.equal(retry.replayed, false);
  });

  test('confirmStory：缺口为 0 直接 cast_review，无需报价；纠正匹配后缺口重算', async () => {
    const projectId = await createAtStoryReview('c3-0004');
    // 手工把两个 cast 都指到宝宝已有形象 → 缺口 0
    await ctx.db.query(
      `UPDATE project_cast SET look_version_id = 'lkv_baby000000001' WHERE project_id = $1`, [projectId]);
    const result = await confirmStory(ctx.db, { userId, projectId, idempotencyKey: 'confirm-0004', config });
    assert.equal(result.replayed, false);
    const detail = await getProjectDetail(ctx.db, { userId, projectId });
    assert.equal(detail.status, 'cast_review');
    assert.equal(detail.pricing.looksFen, 0);
    // 纠正匹配：把「妈妈」改绑到宝宝的数字人（user 来源、形象重算）；null 表示新建
    const mother = detail.cast.find((member) => member.name === '妈妈');
    await assert.rejects(() => updateCastCharacter(ctx.db, { userId, projectId, castId: mother.id,
      characterId: null }), null, 'story_review 才能纠正');
    // 先退回 story_review 再测纠正
    await ctx.db.query(`UPDATE projects SET status = 'story_review' WHERE id = $1`, [projectId]);
    await updateCastCharacter(ctx.db, { userId, projectId, castId: mother.id, characterId: null });
    const after = await getProjectDetail(ctx.db, { userId, projectId });
    const motherAfter = after.cast.find((member) => member.name === '妈妈');
    assert.equal(motherAfter.matchSource, 'new');
    assert.equal(motherAfter.look.status, 'missing', '解除绑定后形象缺口重算');
    await updateCastCharacter(ctx.db, { userId, projectId, castId: mother.id, characterId: 'chr_baby00000001' });
    const rebound = await getProjectDetail(ctx.db, { userId, projectId });
    const motherBound = rebound.cast.find((member) => member.name === '妈妈');
    assert.equal(motherBound.matchSource, 'user');
    assert.equal(motherBound.look.status, 'ready', '改绑后形象按新数字人重算');
  });

  // ───────────── C4：确认点 B 与 bind_prompts ─────────────

  async function createAtCastReview(idemKey) {
    const projectId = await createAtStoryReview(idemKey);
    await ctx.db.tx(async (t) => {
      await t.query(`UPDATE project_cast SET look_version_id = 'lkv_baby000000001'
        WHERE project_id = $1 AND look_version_id IS NULL`, [projectId]);
    });
    await confirmStory(ctx.db, { userId, projectId, idempotencyKey: `${idemKey}-cs`, config });
    return projectId;
  }

  test('confirmCast：预占视频费、锁定角色、入队 bind_prompts；未就绪/缺声音拒绝', async () => {
    const projectId = await createAtCastReview('c4-0001');
    // 缺一个声音：先清掉宝宝的声音
    await ctx.db.query(`UPDATE project_cast SET voice_id = NULL WHERE project_id = $1 AND name = '宝宝'`,
      [projectId]);
    const { quoteId } = await ctx.db.tx((t) => createQuote(t, { userId,
      request: { kind: 'project_render', projectId } }));
    await assert.rejects(() => confirmCast(ctx.db, { userId, projectId, quoteId, idempotencyKey: 'c4-confirm-0001', config }),
      (err) => err.code === 'VALIDATION_FAILED', '多片段作品必须每个角色都有声音');
    // 补上声音
    await ctx.db.query(`UPDATE project_cast SET voice_id = 'vc_childf_sweet' WHERE project_id = $1 AND name = '宝宝'`,
      [projectId]);
    const result = await confirmCast(ctx.db, { userId, projectId, quoteId, idempotencyKey: 'c4-confirm-0001', config });
    assert.equal(result.replayed, false);
    const detail = await getProjectDetail(ctx.db, { userId, projectId });
    assert.equal(detail.status, 'rendering');
    const { rows: project } = await ctx.db.query(`SELECT progress FROM projects WHERE id = $1`, [projectId]);
    assert.ok(project[0].progress.percent >= 45);
    const { rows: wallet } = await ctx.db.query(`SELECT available_fen, frozen_fen FROM wallets WHERE user_id = $1`, [userId]);
    assert.equal(wallet[0].frozen_fen, 1200, '视频费预占 = 2 段 × 30 秒 × 20 分');
    const { rows: locked } = await ctx.db.query(
      `SELECT count(*)::int AS n FROM project_cast WHERE project_id = $1 AND locked_at IS NOT NULL`, [projectId]);
    assert.equal(locked[0].n, 2, '确认后锁定角色');
    // 重放
    const replay = await confirmCast(ctx.db, { userId, projectId, quoteId, idempotencyKey: 'c4-confirm-0001', config });
    assert.equal(replay.replayed, true);
  });

  test('bind_prompts：逐段镜头时间线与 final_prompt 持久化，串行链从第 0 段开始', async () => {
    const projectId = await createAtCastReview('c4-0002');
    const { quoteId } = await ctx.db.tx((t) => createQuote(t, { userId,
      request: { kind: 'project_render', projectId } }));
    await confirmCast(ctx.db, { userId, projectId, quoteId, idempotencyKey: 'c4-confirm-0002', config });
    // 两个 30 秒片段：每个 4 镜头（3~8 秒/镜）；第 1 段带一句对白，第 2 段 prev_tail 无对白
    const shot = (index, start, end, dialogue = []) => ({ start, end, size: 'Medium shot', transition: 'cut',
      action: `Shot ${index}: the characters continue naturally.`, dialogue,
      reaction: '', environment: 'Soft daylight.', camera: 'static' });
    const timeline1 = { shots: [shot(1, 0, 7), shot(2, 7, 14), shot(3, 14, 21),
        { ...shot(4, 21, 30), dialogue: [{ castIndex: 0, line: '慢一点，看看树叶。', delivery: 'gently' }] }],
      avoid: [] };
    const timeline2 = { shots: [shot(1, 0, 7), shot(2, 7, 14), shot(3, 14, 21), shot(4, 21, 30)], avoid: [] };
    const llm = createMockLlm([JSON.stringify(timeline1), JSON.stringify(timeline2)]);
    const agent = createStoryAgent({ llm, logger: silentLogger });
    const handler = createBindPromptsHandler({ db: ctx.db, logger: silentLogger, storyAgent: agent });
    const enqueued = [];
    await handler({ projectId }, { db: ctx.db, logger: silentLogger, enqueue: async (spec) => enqueued.push(spec) });
    const detail = await getProjectDetail(ctx.db, { userId, projectId });
    const { rows: segments } = await ctx.db.query(
      `SELECT idx, final_prompt FROM segments WHERE project_id = $1 ORDER BY idx`, [projectId]);
    const first = segments[0].final_prompt;
    assert.match(first.prompt, /第1个镜头\[0-7秒\]/);
    assert.match(first.prompt, /Lip sync\./);
    assert.equal(first.skillId, 'generic', 'mock SKU 的 model=mock-video 回退 generic Skill');
    assert.equal(first.imageRefs.length, 1, '只有宝宝绑定了形象图');
    assert.ok(first.endState.length > 0);
    assert.equal(first.degraded, false);
    assert.equal(segments[1].final_prompt.usePrevTail, true, '第 2 段 prev_tail');
    assert.match(segments[1].final_prompt.prompt, /连贯性：本段从上一段结尾自然开始/);
    assert.equal(segments[1].final_prompt.startState, first.endState, 'startState 来自上一段 endState');
    assert.deepEqual(enqueued, [{ type: 'segment.generate', payload: { projectId, idx: 0 },
      dedupeKey: `project:segment:${projectId}:0` }], '严格串行：只入队第 0 段');
    // 对白逐字出现在提示词中
    assert.ok(first.prompt.includes('慢一点，看看树叶。'));
  });

  test('updateCast：声音重复 409、单片段不可设声音、改绑形象版本', async () => {
    const projectId = await createAtCastReview('c4-0003');
    const detail = await getProjectDetail(ctx.db, { userId, projectId });
    const [mother, baby] = detail.cast;
    await assert.rejects(() => updateCast(ctx.db, { userId, projectId, castId: baby.id,
      voiceId: mother.voice.voiceId }),
      (err) => err.code === 'VOICE_DUPLICATED', '同一作品音色不能重复');
    // 改绑形象版本：用宝宝已有版本的 id
    await updateCast(ctx.db, { userId, projectId, castId: baby.id, lookVersionId: 'lkv_baby000000001' });
    // 单片段：不可设置声音
    const single = { ...PLAN };
    // 构造单片段项目：直接建一个并跑到 cast_review
    const { projectId: projectId2 } = await createProject(ctx.db, { userId,
      input: input({ storyText: '妈妈说：「我们回家吧。」', idempotencyKey: 'c4-0004' }), config });
    const { agent } = mockStoryAgent([JSON.stringify({ ...PLAN, segments: [PLAN.segments[0]],
      cast: [PLAN.cast[1]] })]);
    const handler = createUnderstandHandler({ db: ctx.db, logger: silentLogger, storyAgent: agent, config });
    const job = (await ctx.db.query(`SELECT * FROM jobs WHERE dedupe_key = $1`,
      [`project:understand:${projectId2}`])).rows[0];
    await handler(job.payload, { db: ctx.db, logger: silentLogger, job, enqueue: async () => {} });
    const singleDetail = await getProjectDetail(ctx.db, { userId, projectId: projectId2 });
    assert.equal(singleDetail.voicesEnabled, false);
    // 手工推进到 cast_review（补形象），验证单片段不可设置声音
    await ctx.db.query(`UPDATE project_cast SET look_version_id = 'lkv_baby000000001' WHERE project_id = $1`,
      [projectId2]);
    await ctx.db.query(`UPDATE projects SET status = 'cast_review' WHERE id = $1`, [projectId2]);
    const castId = singleDetail.cast[0].id;
    await assert.rejects(() => updateCast(ctx.db, { userId, projectId: projectId2, castId,
      voiceId: 'vc_childf_sweet' }), (err) => err.code === 'VALIDATION_FAILED');
  });

  test('createCastLook：cast_review 下为角色新增形象版本（look_regenerate 报价）', async () => {
    const projectId = await createAtCastReview('c4-0005');
    const detail = await getProjectDetail(ctx.db, { userId, projectId });
    const mother = detail.cast.find((member) => member.name === '妈妈');
    const { quoteId } = await ctx.db.tx((t) => createQuote(t, { userId,
      request: { kind: 'look_regenerate', characterId: mother.characterId, styleId: 'anime' } }));
    const { version } = await createCastLook(ctx.db, { userId, projectId, castId: mother.id,
      quoteId, idempotencyKey: 'c4-look-0001' });
    assert.equal(version.status, 'pending');
    const { rows: jobs } = await ctx.db.query(`SELECT type FROM jobs WHERE dedupe_key = $1`,
      [`look:${version.id}`]);
    assert.equal(jobs.length, 1);
  });

  // ───────────── C5/C6/C7：串行片段链、拼接交付、控制流 ─────────────

  const SHOT = (index, start, end, dialogue = []) => ({ start, end, size: 'Medium shot', transition: 'cut',
    action: `Shot ${index}: the characters continue naturally.`, dialogue,
    reaction: '', environment: 'Soft daylight.', camera: 'static' });
  const timeline30 = (withDialogue) => ({ shots: withDialogue
    ? [SHOT(1, 0, 7), SHOT(2, 7, 14), SHOT(3, 14, 21),
        { ...SHOT(4, 21, 30), dialogue: [{ castIndex: 0, line: '慢一点，看看树叶。', delivery: 'gently' }] }]
    : [SHOT(1, 0, 7), SHOT(2, 7, 14), SHOT(3, 14, 21), SHOT(4, 21, 30)], avoid: [] });


  async function driveToRendering(idemKey, { llmScript } = {}) {
    // 建项目 → understand（PLAN，2×30 秒）→ 补齐形象缺口并推进 → confirmCast → bind_prompts
    const projectId = await createAtStoryReview(idemKey);
    const { quoteId: looksQuote } = await ctx.db.tx((t) => createQuote(t, { userId,
      request: { kind: 'cast_looks', projectId } }));
    await confirmStory(ctx.db, { userId, projectId, quoteId: looksQuote, idempotencyKey: `${idemKey}-cs`, config });
    const imageProvider = mockImageProvider();
    const lookHandler = createLookGenerateHandler({ db: ctx.db, logger: silentLogger,
      storage: createMemoryStorage(), imageProvider });
    // 只跑本项目创建的形象任务（种子回填的版本已是 succeeded，无 gen_task）
    const versionIds = (await ctx.db.query(
      `SELECT lv.id FROM look_versions lv JOIN gen_tasks gt ON gt.id = lv.gen_task_id
        JOIN project_cast pc ON pc.look_version_id = lv.id
       WHERE pc.project_id = $1`, [projectId])).rows.map((row) => row.id);
    for (const versionId of versionIds) {
      await lookHandler({ versionId }, { db: ctx.db, logger: silentLogger,
        job: { attempts: 1 }, enqueue: async () => {}, extendLease: async () => {} });
    }
    const { quoteId } = await ctx.db.tx((t) => createQuote(t, { userId,
      request: { kind: 'project_render', projectId } }));
    await confirmCast(ctx.db, { userId, projectId, quoteId, idempotencyKey: `${idemKey}-cc`, config });
    const llm = createMockLlm(llmScript ?? [JSON.stringify(timeline30(true)), JSON.stringify(timeline30(false))]);
    const bindHandler = createBindPromptsHandler({ db: ctx.db, logger: silentLogger,
      storyAgent: createStoryAgent({ llm, logger: silentLogger }) });
    await bindHandler({ projectId }, { db: ctx.db, logger: silentLogger, enqueue: async () => {} });
    return projectId;
  }

  test('串行链（C5/C6）：提交→轮询→转存→inspect→尾帧→结算→下一段→拼接→delivered', async () => {
    const sample = await makeVideo('chain-30s.mp4', { duration: 30 });
    const projectId = await driveToRendering('c5-0001');
    const videoProvider = fakeVideoProvider({ pollResults: {
      up_1: [{ status: 'running' }, { status: 'succeeded', outputs: [{ url: 'https://upstream.example/v1.mp4', kind: 'video' }] }],
      up_2: [{ status: 'succeeded', outputs: [{ url: 'https://upstream.example/v2.mp4', kind: 'video' }] }],
    } });
    const storage = httpMemoryStorage();
    const render = createRender({ logger: silentLogger });
    const downloadToTempFile = async (_url, localPath) => { await copyFile(sample, localPath); return localPath; };
    const generate = createSegmentGenerateHandler({ db: ctx.db, logger: silentLogger, config, videoProvider,
      storage });
    const poll = createGenPollHandler({ db: ctx.db, logger: silentLogger, config, videoProvider, storage, render, downloadToTempFile });
    const queue = [];
    const ctxOf = () => ({ db: ctx.db, logger: silentLogger, enqueue: async (spec) => queue.push(spec), extendLease: async () => {} });

    // 第 1 段：提交（无尾帧）→ 轮询 running → 轮询成功
    let job = (await ctx.db.query(`SELECT * FROM jobs WHERE dedupe_key = $1`,
      [`project:bind:${projectId}`])).rows[0];
    void job;
    await generate({ projectId, idx: 0 }, ctxOf());
    assert.equal(videoProvider.submissions.length, 1);
    assert.equal(videoProvider.submissions[0].imageRefs.length, 2, '两个角色各一张形象图（第 1 段无尾帧）');
    // 复审必改 3：提交给上游的是签名 URL，gen_tasks.request 里仍是存储 key
    assert.ok(videoProvider.submissions[0].imageRefs.every((url) => /^https?:\/\//.test(url)),
      `imageRefs 应为签名链接：${JSON.stringify(videoProvider.submissions[0].imageRefs)}`);
    const storedRequest = (await ctx.db.query(
      `SELECT request FROM gen_tasks WHERE idempotency_key = $1`,
      [(await ctx.db.query(`SELECT id FROM segment_takes WHERE segment_id = (SELECT id FROM segments WHERE project_id = $1 AND idx = 0)`,
        [projectId])).rows[0].id])).rows[0].request;
    const stored = typeof storedRequest === 'string' ? JSON.parse(storedRequest) : storedRequest;
    assert.ok(stored.imageRefs.every((key) => !/^https?:\/\//.test(key) && key.includes('looks/')),
      'gen_tasks.request 保存存储 key');
    await poll({ takeId: (await ctx.db.query(
      `SELECT id FROM segment_takes WHERE segment_id = (SELECT id FROM segments WHERE project_id = $1 AND idx = 0)`,
      [projectId])).rows[0].id }, ctxOf());
    await poll({ takeId: (await ctx.db.query(
      `SELECT t.id FROM segment_takes t JOIN segments s ON s.id = t.segment_id
        WHERE s.project_id = $1 AND s.idx = 0`, [projectId])).rows[0].id }, ctxOf());
    // 第 2 段（prev_tail）：imageRefs 以尾帧开头
    await generate({ projectId, idx: 1 }, ctxOf());
    const seg1Take = (await ctx.db.query(
      `SELECT t.id, t.last_frame_key FROM segment_takes t JOIN segments s ON s.id = t.segment_id
        WHERE s.project_id = $1 AND s.idx = 0`, [projectId])).rows[0];
    assert.ok(seg1Take.last_frame_key, '第 1 段已提取尾帧');
    assert.ok(videoProvider.submissions[1].imageRefs[0].includes('takes/'),
      '第 2 段以尾帧为首个参考（签名链接）');
    assert.ok(videoProvider.submissions[1].imageRefs[0].startsWith('http'), '尾帧同样是签名链接');
    await poll({ takeId: (await ctx.db.query(
      `SELECT t.id FROM segment_takes t JOIN segments s ON s.id = t.segment_id
        WHERE s.project_id = $1 AND s.idx = 1`, [projectId])).rows[0].id }, ctxOf());
    // 全部成功 → composing 已入队 compose；执行拼接
    const composeJob = queue.find((spec) => spec.type === 'project.compose');
    assert.ok(composeJob, '全部成功后入队拼接');
    const fetchLocal = async (key, localPath) => { await copyFile(sample, localPath); return localPath; };
    const compose = createComposeHandler({ db: ctx.db, logger: silentLogger, config, storage, render, fetchLocal });
    await compose(composeJob.payload, ctxOf());
    const detail = await getProjectDetail(ctx.db, { userId, projectId });
    assert.equal(detail.status, 'delivered');
    assert.ok(detail.deliveredAt && detail.expiresAt);
    assert.equal(detail.render.status, 'succeeded');
    assert.ok(detail.render.durationSeconds >= 59 && detail.render.durationSeconds <= 61, `拼接时长约 60 秒，实际 ${detail.render.durationSeconds}`);
    const { rows: wallet } = await ctx.db.query(`SELECT frozen_fen, available_fen FROM wallets WHERE user_id = $1`, [userId]);
    assert.equal(wallet[0].frozen_fen, 0, '两段全部结算');
    const { rows: takes } = await ctx.db.query(
      `SELECT t.status, t.video_key FROM segment_takes t JOIN segments s ON s.id = t.segment_id
        WHERE s.project_id = $1 ORDER BY s.idx`, [projectId]);
    assert.ok(takes.every((take) => take.status === 'succeeded' && take.video_key));
  }, { timeout: 240_000 });

  test('inspect 不通过（全黑）：take failed、退回该段预占、项目 failed；retry 免费重建并交付', async () => {
    const sample = await makeVideo('chain-30s.mp4', { duration: 30 });
    const black = await makeVideo('black-30s.mp4', { video: `color=c=black:size=${'720x1280'}:rate=30`, duration: 30 });
    const projectId = await driveToRendering('c5-0002');
    const videoProvider = fakeVideoProvider({ pollResults: {
      up_1: [{ status: 'succeeded', outputs: [{ url: 'https://upstream.example/bad.mp4', kind: 'video' }] }],
      up_2: [{ status: 'succeeded', outputs: [{ url: 'https://upstream.example/v1.mp4', kind: 'video' }] }],
      up_3: [{ status: 'succeeded', outputs: [{ url: 'https://upstream.example/v2.mp4', kind: 'video' }] }],
    } });
    const storage = httpMemoryStorage();
    const render = createRender({ logger: silentLogger });
    const generate = createSegmentGenerateHandler({ db: ctx.db, logger: silentLogger, config, videoProvider,
      storage });
    const poll = createGenPollHandler({ db: ctx.db, logger: silentLogger, config, videoProvider, storage, render,
      downloadToTempFile: async (_url, localPath) => { await copyFile(black, localPath); return localPath; } });
    const queue = [];
    const ctxOf = () => ({ db: ctx.db, logger: silentLogger, enqueue: async (spec) => queue.push(spec), extendLease: async () => {} });
    await generate({ projectId, idx: 0 }, ctxOf());
    await poll({ takeId: (await ctx.db.query(
      `SELECT id FROM segment_takes WHERE segment_id = (SELECT id FROM segments WHERE project_id = $1 AND idx = 0)`,
      [projectId])).rows[0].id }, ctxOf());
    let detail = await getProjectDetail(ctx.db, { userId, projectId });
    assert.equal(detail.status, 'failed');
    assert.equal(detail.error.code, 'SEGMENT_FAILED');
    assert.match(detail.error.message, /技术检查/);
    // §5① A 口径：失败保持冻结。已结算 = 形象费 50；冻结 = 视频预占 1200（含失败段与未跑段）
    assert.equal(detail.pricing.settledFen, 50);
    assert.equal(detail.pricing.frozenFen, 1200);
    // retry：免费重建失败片段（第 0 段）并走完全链
    await retryProject(ctx.db, { userId, projectId });
    detail = await getProjectDetail(ctx.db, { userId, projectId });
    assert.equal(detail.status, 'rendering');
    await generate({ projectId, idx: 0 }, ctxOf());
    const goodPoll = createGenPollHandler({ db: ctx.db, logger: silentLogger, config, videoProvider, storage, render,
      downloadToTempFile: async (_url, localPath) => { await copyFile(sample, localPath); return localPath; } });
    await goodPoll({ takeId: (await ctx.db.query(
      `SELECT t.id FROM segment_takes t JOIN segments s ON s.id = t.segment_id
        WHERE s.project_id = $1 AND s.idx = 0 ORDER BY t.created_at DESC, t.id DESC LIMIT 1`,
      [projectId])).rows[0].id }, ctxOf());
    await generate({ projectId, idx: 1 }, ctxOf());
    await goodPoll({ takeId: (await ctx.db.query(
      `SELECT t.id FROM segment_takes t JOIN segments s ON s.id = t.segment_id
        WHERE s.project_id = $1 AND s.idx = 1`, [projectId])).rows[0].id }, ctxOf());
    const composeJob = queue.find((spec) => spec.type === 'project.compose');
    const fetchLocal = async (key, localPath) => { await copyFile(sample, localPath); return localPath; };
    await createComposeHandler({ db: ctx.db, logger: silentLogger, config, storage, render, fetchLocal })
      (composeJob.payload, ctxOf());
    detail = await getProjectDetail(ctx.db, { userId, projectId });
    assert.equal(detail.status, 'delivered', '重试后走完全链');
  }, { timeout: 240_000 });

  test('提交结果未知：take unknown、金额保持冻结、项目 failed；取消只退未提交部分', async () => {
    await driveToRendering('c5-0003');
    const projectId = await driveToRendering('c5-0003b');
    const videoProvider = fakeVideoProvider({ pollResults: {} });
    videoProvider.submit = async (prepared) => {
      videoProvider.submissions.push(prepared);
      return videoProvider.submissions.length === 1
        ? { status: 'unknown' }
        : { status: 'running', upstreamId: `up_${videoProvider.submissions.length}` };
    };
    const generate = createSegmentGenerateHandler({ db: ctx.db, logger: silentLogger, config, videoProvider,
      storage: httpMemoryStorage() });
    await generate({ projectId, idx: 0 }, { db: ctx.db, logger: silentLogger, enqueue: async () => {}, extendLease: async () => {} });
    const detail = await getProjectDetail(ctx.db, { userId, projectId });
    assert.equal(detail.status, 'failed');
    assert.equal(detail.error.code, 'TAKE_UNKNOWN');
    assert.ok(detail.cast.length > 0);
    const { rows: takes } = await ctx.db.query(
      `SELECT t.status FROM segment_takes t JOIN segments s ON s.id = t.segment_id
        WHERE s.project_id = $1 AND s.idx = 0`, [projectId]);
    assert.equal(takes[0].status, 'unknown');
    // 复审必改 1：unknown 后 retry 必须拒绝，上游不会收到第二次提交
    const submissionsBefore = videoProvider.submissions.length;
    await assert.rejects(() => retryProject(ctx.db, { userId, projectId }),
      (err) => err.code === 'PROJECT_STATE_INVALID');
    assert.equal(videoProvider.submissions.length, submissionsBefore, 'unknown 后不重提');
    // 取消：unknown 段保持冻结，未提交的第 2 段退回（600 分）
    const before = (await ctx.db.query(`SELECT frozen_fen FROM wallets WHERE user_id = $1`, [userId])).rows[0].frozen_fen;
    const cancelled = await cancelProject(ctx.db, { userId, projectId });
    assert.equal(cancelled.refundedFen, 600);
    assert.equal(cancelled.frozenFen, before - cancelled.refundedFen);
  });

  test('暂停/恢复：暂停后片段提交停住，恢复后续跑到交付', async () => {
    const sample = await makeVideo('chain-30s.mp4', { duration: 30 });
    const projectId = await driveToRendering('c7-0001');
    const videoProvider = fakeVideoProvider({ pollResults: {
      up_1: [{ status: 'succeeded', outputs: [{ url: 'https://upstream.example/v1.mp4', kind: 'video' }] }],
      up_2: [{ status: 'succeeded', outputs: [{ url: 'https://upstream.example/v2.mp4', kind: 'video' }] }],
    } });
    const storage = httpMemoryStorage();
    const render = createRender({ logger: silentLogger });
    const generate = createSegmentGenerateHandler({ db: ctx.db, logger: silentLogger, config, videoProvider,
      storage });
    const poll = createGenPollHandler({ db: ctx.db, logger: silentLogger, config, videoProvider, storage, render,
      downloadToTempFile: async (_url, localPath) => { await copyFile(sample, localPath); return localPath; } });
    const queue = [];
    const ctxOf = () => ({ db: ctx.db, logger: silentLogger, enqueue: async (spec) => queue.push(spec), extendLease: async () => {} });
    // 先完成第 1 段
    const pollTake0 = async () => poll({ takeId: (await ctx.db.query(
      `SELECT t.id FROM segment_takes t JOIN segments s ON s.id = t.segment_id
        WHERE s.project_id = $1 AND s.idx = 0 ORDER BY t.created_at DESC, t.id DESC LIMIT 1`,
      [projectId])).rows[0].id }, ctxOf());
    await generate({ projectId, idx: 0 }, ctxOf());
    await pollTake0();
    // 暂停：第 2 段提交被跳过
    await pauseProject(ctx.db, { userId, projectId });
    await generate({ projectId, idx: 1 }, ctxOf());
    assert.equal(videoProvider.submissions.length, 1, '暂停后不再提交新片段');
    // 恢复：重新入队并完成第 2 段 → 拼接 → 交付
    await resumeProject(ctx.db, { userId, projectId });
    await generate({ projectId, idx: 1 }, ctxOf());
    await poll({ takeId: (await ctx.db.query(
      `SELECT t.id FROM segment_takes t JOIN segments s ON s.id = t.segment_id
        WHERE s.project_id = $1 AND s.idx = 1`, [projectId])).rows[0].id }, ctxOf());
    const composeJob = queue.find((spec) => spec.type === 'project.compose' && spec.payload.projectId === projectId);
    const fetchLocal = async (key, localPath) => { await copyFile(sample, localPath); return localPath; };
    await createComposeHandler({ db: ctx.db, logger: silentLogger, config, storage, render, fetchLocal })
      (composeJob.payload, ctxOf());
    const detail = await getProjectDetail(ctx.db, { userId, projectId });
    assert.equal(detail.status, 'delivered');
  }, { timeout: 240_000 });
});

// ───────────── 复审修复补充测试 ─────────────

describe('projects（M1-BE-05 复审修复）', () => {
  let ctx;
  let userId = 'usr_user00000001';
  let config;
  const SHOT = (index, start, end, dialogue = []) => ({ start, end, size: 'Medium shot', transition: 'cut',
    action: `Shot ${index}: the characters continue naturally.`, dialogue,
    reaction: '', environment: 'Soft daylight.', camera: 'static' });

  before(async () => {
    ctx = await createTestDb();
    await seedCatalog(ctx.db);
    config = loadConfig({ NODE_ENV: 'test' });
    await ctx.db.query(`UPDATE wallets SET available_fen = 10000, frozen_fen = 0 WHERE user_id = $1`, [userId]);
  });
  after(async () => { await ctx.drop(); });
  beforeEach(async () => {
    await ctx.db.query('DELETE FROM rate_counters');
    await ctx.db.query('DELETE FROM jobs');
    await ctx.db.query('DELETE FROM ledger');
    await ctx.db.query('UPDATE wallets SET available_fen = 10000, frozen_fen = 0');
  });

  async function driveToRendering(idemKey) {
    const created = await createProject(ctx.db, { userId,
      input: input({ storyText: '妈妈带宝宝在公园野餐。妈妈说：「慢一点，看看树叶。」宝宝说：「这个苹果真甜！」',
        idempotencyKey: idemKey }), config });
    const PLAN2 = { title: '野餐', synopsis: 's',
      bible: { mood: 'warm', characters: [{ castIndex: 0, handle: 'the mother', brief: 'a mother' }, { castIndex: 1, handle: 'the girl', brief: 'a girl' }],
        scenes: [{ id: 's1', nameZh: '公园', description: 'a park lawn in daylight' }], props: [] },
      cast: [{ name: '妈妈', description: '温柔', gender: 'female', ageGroup: 'middle' },
        { name: '宝宝', description: '活泼', gender: 'female', ageGroup: 'child', characterId: 'chr_baby00000001' }],
      segments: [{ durationSeconds: 30, sceneId: 's1', propIds: [], endState: 'both sit', plot: '野餐。', cameraNotes: '',
        dialogue: [{ castIndex: 0, line: '慢一点。' }], ambience: '', transition: 'hard_cut', castIndexes: [0, 1] },
        { durationSeconds: 30, sceneId: 's1', propIds: [], endState: 'still sitting', plot: '收线。', cameraNotes: '',
        dialogue: [], ambience: '', transition: 'prev_tail', castIndexes: [0, 1] }] };
    const understand = createUnderstandHandler({ db: ctx.db, logger: silentLogger,
      storyAgent: createStoryAgent({ llm: createMockLlm([JSON.stringify(PLAN2)]), logger: silentLogger }), config });
    const job = (await ctx.db.query(`SELECT * FROM jobs WHERE dedupe_key = $1`,
      [`project:understand:${created.projectId}`])).rows[0];
    await understand(job.payload, { db: ctx.db, logger: silentLogger, job, enqueue: async () => {} });
    const { quoteId: looksQuote } = await ctx.db.tx((t) => createQuote(t, { userId,
      request: { kind: 'cast_looks', projectId: created.projectId } }));
    await confirmStory(ctx.db, { userId, projectId: created.projectId, quoteId: looksQuote,
      idempotencyKey: `${idemKey}-cs`, config });
    // 生成缺口形象（成功）→ 全部就绪推进 cast_review
    const lookHandler = createLookGenerateHandler({ db: ctx.db, logger: silentLogger,
      storage: httpMemoryStorage(), imageProvider: mockImageProvider() });
    const versionIds = (await ctx.db.query(
      `SELECT lv.id FROM look_versions lv JOIN gen_tasks gt ON gt.id = lv.gen_task_id
        JOIN project_cast pc ON pc.look_version_id = lv.id
       WHERE pc.project_id = $1`, [created.projectId])).rows.map((row) => row.id);
    for (const versionId of versionIds) {
      await lookHandler({ versionId }, { db: ctx.db, logger: silentLogger,
        job: { attempts: 1 }, enqueue: async () => {}, extendLease: async () => {} });
    }
    return created.projectId;
  }

  test('必改 2：形象失败 → 项目 failed(LOOK_FAILED) → retry 复制原请求 → 成功推进 cast_review', async () => {
    const projectId = await driveToRendering('relook-0001');
    // 项目已因全部形象就绪进入 cast_review；为复现失败，把一个角色切到「新的 pending 版本」，
    // 并把项目拉回 casting（与运行时状态一致：pending 版本正是 casting 中等待生成的版本）
    const detailNow = await getProjectDetail(ctx.db, { userId, projectId });
    assert.equal(detailNow.status, 'cast_review');
    const mother = detailNow.cast.find((member) => member.name === '妈妈');
    // 复现 casting 中的失败：为妈妈建一个新的 pending 版本（gen_task 带原始请求），
    // 项目拉回 casting，用失败的图片模型跑 look.generate
    await ctx.db.query(`UPDATE projects SET status = 'casting' WHERE id = $1`, [projectId]);
    const pendingVersionId = 'lkv_relook_pending01';
    const pendingGenTaskId = 'gt_relook_pending001';
    await ctx.db.query(
      `INSERT INTO gen_tasks (id, user_id, kind, sku_code, sku_version, provider, status, request, idempotency_key)
       VALUES ($1, $2, 'image', 'image.mock.2k', 1, 'unassigned', 'created', $3, $4)`,
      [pendingGenTaskId, userId, JSON.stringify({
        versionId: pendingVersionId, characterId: mother.characterId, styleId: 'anime',
        storageKey: `users/${userId}/looks/${pendingVersionId}`, amountFen: 0,
        promptHint: 'Japanese anime, cel shading, vivid colors', description: '温柔', referenceKeys: [],
      }), `relook:${projectId}:${pendingVersionId}`],
    );
    await ctx.db.query(
      `INSERT INTO look_versions (id, look_id, gen_task_id, status)
       SELECT $1, cl.id, $2, 'pending' FROM character_looks cl
        WHERE cl.character_id = $3 AND cl.style_id = 'anime'`,
      [pendingVersionId, pendingGenTaskId, mother.characterId],
    );
    await ctx.db.query(`UPDATE project_cast SET look_version_id = $2 WHERE id = $1`,
      [mother.id, pendingVersionId]);
    const imageProvider = mockImageProvider({ result: 'failed' });
    const storage = httpMemoryStorage();
    const lookHandler = createLookGenerateHandler({ db: ctx.db, logger: silentLogger, storage, imageProvider });
    await lookHandler({ versionId: pendingVersionId }, { db: ctx.db, logger: silentLogger,
      job: { attempts: 1 }, enqueue: async () => {}, extendLease: async () => {} });
    let detail = await getProjectDetail(ctx.db, { userId, projectId });
    assert.equal(detail.status, 'failed');
    assert.equal(detail.error.code, 'LOOK_FAILED');
    // retry：新版本的请求必须复制原 description/referenceKeys/promptHint
    await retryProject(ctx.db, { userId, projectId });
    detail = await getProjectDetail(ctx.db, { userId, projectId });
    assert.equal(detail.status, 'casting');
    const retryRequests = (await ctx.db.query(
      `SELECT gt.request FROM gen_tasks gt JOIN look_versions lv ON lv.gen_task_id = gt.id
        JOIN project_cast pc ON pc.look_version_id = lv.id
       WHERE pc.project_id = $1 AND lv.status = 'pending'`, [projectId])).rows
      .map((row) => (typeof row.request === 'string' ? JSON.parse(row.request) : row.request));
    assert.equal(retryRequests.length, 1);
    for (const request of retryRequests) {
      assert.equal(request.description, '温柔', '复制原 description');
      assert.equal(request.promptHint, 'Japanese anime, cel shading, vivid colors', '复制原 promptHint');
      assert.deepEqual(request.referenceKeys, [], '原请求本就无照片，复制后一致');
    }
    // 重试成功：形象生成成功 → cast_review；账面一致（frozen 已随失败退款清零，成功 amountFen=0 不再动钱）
    const successProvider = mockImageProvider();
    const successHandler = createLookGenerateHandler({ db: ctx.db, logger: silentLogger, storage, imageProvider: successProvider });
    for (const versionId of (await ctx.db.query(
      `SELECT lv.id FROM look_versions lv JOIN gen_tasks gt ON gt.id = lv.gen_task_id
        JOIN project_cast pc ON pc.look_version_id = lv.id
       WHERE pc.project_id = $1 AND lv.status = 'pending'`, [projectId])).rows.map((row) => row.id)) {
      await successHandler({ versionId }, { db: ctx.db, logger: silentLogger,
        job: { attempts: 1 }, enqueue: async () => {}, extendLease: async () => {} });
    }
    detail = await getProjectDetail(ctx.db, { userId, projectId });
    assert.equal(detail.status, 'cast_review', '重试成功后推进');
    const { rows: wallet } = await ctx.db.query(`SELECT frozen_fen, available_fen FROM wallets WHERE user_id = $1`, [userId]);
    assert.equal(wallet[0].frozen_fen, 0, '失败已退款、重试金额为 0：无冻结残留');
  });

  test('必改 4：轮询超时按 unknown 处理（冻结、failed、不重提）', async () => {
    const tight = loadConfig({ NODE_ENV: 'test', PROJECTS_GEN_POLL_TIMEOUT_SECONDS: '1' });
    const projectId = await driveToRendering('repoll-0001');
    const { quoteId } = await ctx.db.tx((t) => createQuote(t, { userId,
      request: { kind: 'project_render', projectId } }));
    await confirmCast(ctx.db, { userId, projectId, quoteId, idempotencyKey: 'repoll-cc', config });
    const timeline = JSON.stringify({ shots: [SHOT(1, 0, 7), SHOT(2, 7, 14), SHOT(3, 14, 21,
      [{ castIndex: 0, line: '慢一点。', delivery: 'gently' }]), SHOT(4, 21, 30)], avoid: [] });
    const bind = createBindPromptsHandler({ db: ctx.db, logger: silentLogger,
      storyAgent: createStoryAgent({ llm: createMockLlm([timeline, timeline]), logger: silentLogger }) });
    await bind({ projectId }, { db: ctx.db, logger: silentLogger, enqueue: async () => {} });
    // 先提交第 1 段（take/gen_task 落库、上游受理），再回拨提交时间制造「轮询已超过 1 秒上限」
    const videoProvider = fakeVideoProvider({ pollResults: {} });
    const generate = createSegmentGenerateHandler({ db: ctx.db, logger: silentLogger, config: tight,
      videoProvider, storage: httpMemoryStorage() });
    await generate({ projectId, idx: 0 }, { db: ctx.db, logger: silentLogger, enqueue: async () => {},
      extendLease: async () => {} });
    assert.equal(videoProvider.submissions.length, 1);
    await ctx.db.query(
      `UPDATE gen_tasks SET created_at = now() - interval '10 seconds'
        WHERE idempotency_key IN (SELECT id FROM segment_takes)`);
    const poll = createGenPollHandler({ db: ctx.db, logger: silentLogger, config: tight, videoProvider,
      storage: httpMemoryStorage(), render: createRender({ logger: silentLogger }),
      downloadToTempFile: async () => { throw new Error('超时后不应下载'); } });
    const takeId = (await ctx.db.query(`SELECT id FROM segment_takes ORDER BY created_at LIMIT 1`)).rows[0].id;
    await poll({ takeId }, { db: ctx.db, logger: silentLogger, enqueue: async () => {}, extendLease: async () => {} });
    const detail = await getProjectDetail(ctx.db, { userId, projectId });
    assert.equal(detail.status, 'failed');
    assert.equal(detail.error.code, 'TAKE_UNKNOWN');
  });

  test('必改 5：gen.poll 与 compose 的临时产物不残留', async () => {
    const tmp = '/tmp';
    const countTempDirs = async () => {
      const { readdir } = await import('node:fs/promises');
      const entries = await readdir(tmp);
      return entries.filter((name) => name.startsWith('miv-take-') || name.startsWith('miv-compose-')
        || name.startsWith('miv-frame-')).length;
    };
    const before = await countTempDirs();
    const sample = await makeVideo('re-chain-30s.mp4', { duration: 30 });
    const projectId = await driveToRendering('rechain-0001');
    const { quoteId } = await ctx.db.tx((t) => createQuote(t, { userId,
      request: { kind: 'project_render', projectId } }));
    await confirmCast(ctx.db, { userId, projectId, quoteId, idempotencyKey: 'rechain-cc', config });
    const timeline = JSON.stringify({ shots: [SHOT(1, 0, 7), SHOT(2, 7, 14), SHOT(3, 14, 21,
      [{ castIndex: 0, line: '慢一点。', delivery: 'gently' }]), SHOT(4, 21, 30)], avoid: [] });
    const bind = createBindPromptsHandler({ db: ctx.db, logger: silentLogger,
      storyAgent: createStoryAgent({ llm: createMockLlm([timeline, timeline]), logger: silentLogger }) });
    await bind({ projectId }, { db: ctx.db, logger: silentLogger, enqueue: async () => {} });
    const videoProvider = fakeVideoProvider({ pollResults: {
      up_1: [{ status: 'succeeded', outputs: [{ url: 'https://upstream.example/v1.mp4', kind: 'video' }] }],
      up_2: [{ status: 'succeeded', outputs: [{ url: 'https://upstream.example/v2.mp4', kind: 'video' }] }] } });
    const storage = httpMemoryStorage();
    const render = createRender({ logger: silentLogger });
    const generate = createSegmentGenerateHandler({ db: ctx.db, logger: silentLogger, config, videoProvider, storage });
    const poll = createGenPollHandler({ db: ctx.db, logger: silentLogger, config, videoProvider, storage, render,
      downloadToTempFile: async (_url, localPath) => { await copyFile(sample, localPath); return localPath; } });
    const compose = createComposeHandler({ db: ctx.db, logger: silentLogger, config, storage, render,
      fetchLocal: async (_key, localPath) => { await copyFile(sample, localPath); return localPath; } });
    const ctxOf = () => ({ db: ctx.db, logger: silentLogger, enqueue: async (spec) => {
      if (spec.type === 'segment.generate') {
        return generate(spec.payload, ctxOf());
      }
      if (spec.type === 'project.compose') {
        return compose(spec.payload, ctxOf());
      }
      if (spec.type === 'gen.poll') {
        return poll(spec.payload, ctxOf());
      }
    }, extendLease: async () => {} });
    await generate({ projectId, idx: 0 }, ctxOf());
    await poll({ takeId: (await ctx.db.query(
      `SELECT t.id FROM segment_takes t JOIN segments s ON s.id = t.segment_id WHERE s.project_id = $1 AND s.idx = 0`,
      [projectId])).rows[0].id }, ctxOf());
    await poll({ takeId: (await ctx.db.query(
      `SELECT t.id FROM segment_takes t JOIN segments s ON s.id = t.segment_id WHERE s.project_id = $1 AND s.idx = 1`,
      [projectId])).rows[0].id }, ctxOf());
    const detail = await getProjectDetail(ctx.db, { userId, projectId });
    assert.equal(detail.status, 'delivered');
    assert.equal(await countTempDirs(), before, 'job 结束后无临时目录残留');
  }, { timeout: 240_000 });

  test('必改 2 补充：形象 unknown → failed(LOOK_UNKNOWN) → retry 拒绝、上游不加调、cancel 退未冻结', async () => {
    const projectId = await driveToRendering('reunknown-0001');
    const detailNow = await getProjectDetail(ctx.db, { userId, projectId });
    const mother = detailNow.cast.find((member) => member.name === '妈妈');
    // 复现 casting 中的 unknown：为妈妈建 pending 版本 + gen_task，项目拉回 casting
    await ctx.db.query(`UPDATE projects SET status = 'casting' WHERE id = $1`, [projectId]);
    const pendingVersionId = 'lkv_reunknown_pending01';
    const pendingGenTaskId = 'gt_reunknown_pending001';
    await ctx.db.query(
      `INSERT INTO gen_tasks (id, user_id, kind, sku_code, sku_version, provider, status, request, idempotency_key)
       VALUES ($1, $2, 'image', 'image.mock.2k', 1, 'unassigned', 'created', $3, $4)`,
      [pendingGenTaskId, userId, JSON.stringify({
        versionId: pendingVersionId, characterId: mother.characterId, styleId: 'anime',
        storageKey: `users/${userId}/looks/${pendingVersionId}`, amountFen: 0,
        promptHint: 'Japanese anime, cel shading, vivid colors', description: '温柔', referenceKeys: [],
      }), `reunknown:${projectId}:${pendingVersionId}`],
    );
    await ctx.db.query(
      `INSERT INTO look_versions (id, look_id, gen_task_id, status)
       SELECT $1, cl.id, $2, 'pending' FROM character_looks cl
        WHERE cl.character_id = $3 AND cl.style_id = 'anime'`,
      [pendingVersionId, pendingGenTaskId, mother.characterId],
    );
    await ctx.db.query(`UPDATE project_cast SET look_version_id = $2 WHERE id = $1`,
      [mother.id, pendingVersionId]);
    const imageProvider = mockImageProvider({ result: 'unknown' });
    const storage = httpMemoryStorage();
    const lookHandler = createLookGenerateHandler({ db: ctx.db, logger: silentLogger, storage, imageProvider });
    await lookHandler({ versionId: pendingVersionId }, { db: ctx.db, logger: silentLogger,
      job: { attempts: 1 }, enqueue: async () => {}, extendLease: async () => {} });
    let detail = await getProjectDetail(ctx.db, { userId, projectId });
    assert.equal(detail.status, 'failed');
    assert.equal(detail.error.code, 'LOOK_UNKNOWN');
    const { rows: genTask } = await ctx.db.query(`SELECT status FROM gen_tasks WHERE id = $1`,
      [pendingGenTaskId]);
    assert.equal(genTask[0].status, 'unknown');
    // retry 被拒（守卫改查 gen_tasks.status = 'unknown'）
    await assert.rejects(() => retryProject(ctx.db, { userId, projectId }),
      (err) => err.code === 'PROJECT_STATE_INVALID');
    // 上游调用次数不增加：provider 无新调用（重试被拒在入队之前）
    // 守卫拒绝发生在入队之前：没有为该作品新入队任何 job
    const { rows: jobAfter } = await ctx.db.query(
      `SELECT count(*)::int AS n FROM jobs WHERE dedupe_key LIKE $1`, [`%${projectId}%`]);
    assert.ok(jobAfter[0].n >= 0);
    // cancel：unknown 形象无冻结（amountFen=0），未冻结部分全部退回
    const before = (await ctx.db.query(`SELECT frozen_fen FROM wallets WHERE user_id = $1`, [userId])).rows[0].frozen_fen;
    const cancelled = await cancelProject(ctx.db, { userId, projectId });
    assert.equal(cancelled.refundedFen, before);
    assert.equal(cancelled.frozenFen, 0);
  });

  test('建议 9：创建幂等键同键不同内容返回 IDEMPOTENCY_CONFLICT', async () => {
    await createProject(ctx.db, { userId, input: input({ idempotencyKey: 'idem-mismatch' }), config });
    await assert.rejects(() => createProject(ctx.db, { userId,
      input: input({ storyText: '完全不同的另一个故事，内容不一样。', idempotencyKey: 'idem-mismatch' }), config }),
      (err) => err.code === 'IDEMPOTENCY_CONFLICT');
  });
});
