// M1-BE-05 C2：创建作品（幂等、免费次数）、project.understand（想法扩写分支、持久化、回填形象）。
// storyAgent 用注入的 mock（engine story mock 同构），不调用真实 LLM。
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { createTestDb } from '../helpers/db.js';
import { silentLogger } from '../../src/logger.js';
import { loadConfig } from '../../src/config.js';
import { createProject, getProjectDetail, reanalyzeProject, consumeFreeQuota, beijingDayStartUtc }
  from '../../src/projects/service.js';
import { createUnderstandHandler } from '../../src/projects/understand.js';
import { classifyInput } from '../../src/engine/story/index.js';
import { createMockLlm } from '../../src/engine/llm/mock.js';
import { createStoryAgent } from '../../src/engine/story/index.js';

const config = loadConfig({ NODE_ENV: 'test' });

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
    // 测试间隔离：清免费计数器与 jobs，避免共享用户下的计数污染
    await ctx.db.query('DELETE FROM rate_counters');
    await ctx.db.query('DELETE FROM jobs');
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
});
