import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { silentLogger } from '../src/logger.js';
import { consumeQuote } from '../src/wallet/pricing.js';
import { charge, redeemCodeHash, refund, reserve, settle } from '../src/wallet/service.js';
import { createTestDb } from './helpers/db.js';

const ORIGIN = 'http://localhost:5173';

function captureSmsProvider() {
  const provider = { sent: [], id: 'test-capture', async send({ phone, code }) { provider.sent.push({ phone, code }); } };
  return provider;
}

function request(base, method, path, { body, cookie, csrf } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  if (csrf) headers['X-CSRF-Token'] = csrf;
  if (body !== undefined) headers.Origin = ORIGIN;
  return fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

const post = (base, path, body, opts) => request(base, 'POST', path, { body, ...opts });
const mivCookie = (res) => res.headers.getSetCookie().find((c) => c.startsWith('miv_sid='))?.split(';')[0];

async function signUp(base, provider, phone) {
  await post(base, '/auth/sms', { phone });
  const code = provider.sent.at(-1).code;
  const res = await post(base, '/auth/login', { phone, code, agreeTerms: true });
  assert.equal(res.status, 200);
  return { body: await res.json(), cookie: mivCookie(res) };
}

const insertRedeemCode = (db, code, amountFen) =>
  db.query(`INSERT INTO redeem_codes (code_hash, amount_fen) VALUES ($1, $2)`, [redeemCodeHash(code), amountFen]);
const insertCharacter = (db, id, userId) =>
  db.query(`INSERT INTO characters (id, user_id, name) VALUES ($1, $2, '测试角色')`, [id, userId]);
const insertProject = (db, id, userId) =>
  db.query(
    `INSERT INTO projects (id, user_id, story_text, source_type, style_id, quality_tier_id, tier_mapping_id, status)
     VALUES ($1, $2, '测试故事内容', 'text', 'realistic', 'standard', 'tm_standard00000001', 'understanding')`,
    [id, userId],
  );
const insertSegment = (db, id, projectId, idx, seconds) =>
  db.query(`INSERT INTO segments (id, project_id, idx, duration_seconds, plot) VALUES ($1, $2, $3, $4, '测试剧情')`, [id, projectId, idx, seconds]);
const insertCast = (db, id, projectId, idx) =>
  db.query(`INSERT INTO project_cast (id, project_id, idx, name, match_source) VALUES ($1, $2, $3, '角色', 'new')`, [id, projectId, idx]);

describe('wallet（M1-BE-02）', () => {
  let ctx;
  let server;
  let base;
  let provider;
  let cookie; // 用户 A
  let csrf;
  let userA;

  before(async () => {
    ctx = await createTestDb();
    provider = captureSmsProvider();
    const app = createApp({ config: loadConfig({ NODE_ENV: 'test' }), db: ctx.db, logger: silentLogger, smsProvider: provider });
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}/api/v1`;

    const a = await signUp(base, provider, '15800000001');
    cookie = a.cookie;
    csrf = a.body.csrfToken;
    userA = a.body.user.id;
    // 他人用户（资源归属测试用）
    await ctx.db.query(`INSERT INTO users (id, phone, nickname) VALUES ('usr_other00000001', '15800000099', '他人')`);
  });
  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await ctx.drop();
  });

  test('未登录访问钱包接口返回 401', async () => {
    for (const [method, path] of [['GET', '/wallet'], ['GET', '/wallet/ledger'], ['POST', '/wallet/redeem'], ['POST', '/quotes']]) {
      const res = await request(base, method, path, { body: method === 'GET' ? undefined : {} });
      assert.equal(res.status, 401);
      assert.equal((await res.json()).code, 'UNAUTHENTICATED');
    }
  });

  test('GET /wallet 初始为 0；GET /wallet/ledger 为空', async () => {
    const res = await request(base, 'GET', '/wallet', { cookie });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { availableFen: 0, frozenFen: 0 });
    const ledger = await (await request(base, 'GET', '/wallet/ledger', { cookie })).json();
    assert.deepEqual(ledger, { items: [], nextCursor: null });
  });

  test('兑换码：成功入账、幂等重放、同键不同码 409、无效与已用 400', async () => {
    const code1 = 'MIV-TEST-CODE-0001';
    await insertRedeemCode(ctx.db, code1, 1000);
    let res = await post(base, '/wallet/redeem', { code: code1, idempotencyKey: 'idem-redeem-0001' }, { cookie, csrf });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { amountFen: 1000, wallet: { availableFen: 1000, frozenFen: 0 } });

    // 幂等重放：同键同码返回首次结果，不重复入账
    res = await post(base, '/wallet/redeem', { code: code1, idempotencyKey: 'idem-redeem-0001' }, { cookie, csrf });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { amountFen: 1000, wallet: { availableFen: 1000, frozenFen: 0 } });

    // 同键不同参数 → 409
    await insertRedeemCode(ctx.db, 'MIV-TEST-CODE-0002', 500);
    res = await post(base, '/wallet/redeem', { code: 'MIV-TEST-CODE-0002', idempotencyKey: 'idem-redeem-0001' }, { cookie, csrf });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).code, 'IDEMPOTENCY_CONFLICT');

    // 无效码
    res = await post(base, '/wallet/redeem', { code: 'MIV-NOPE', idempotencyKey: 'idem-redeem-0002' }, { cookie, csrf });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).message, '兑换码无效或已被使用');

    // 已用码再用新键
    res = await post(base, '/wallet/redeem', { code: code1, idempotencyKey: 'idem-redeem-0003' }, { cookie, csrf });
    assert.equal(res.status, 400);
    const wallet = await (await request(base, 'GET', '/wallet', { cookie })).json();
    assert.equal(wallet.availableFen, 1000);

    // 流水：中文标题
    const ledger = await (await request(base, 'GET', '/wallet/ledger', { cookie })).json();
    assert.equal(ledger.items.length, 1);
    assert.equal(ledger.items[0].kind, 'redeem');
    assert.equal(ledger.items[0].amountFen, 1000);
    assert.equal(ledger.items[0].title, '兑换码充值');
  });

  test('并发兑换同一码（不同幂等键）只成功一次', async () => {
    const f = await signUp(base, provider, '15800000006'); // 独立用户，避免与兑换码尝试上限计数互相干扰
    await insertRedeemCode(ctx.db, 'MIV-TEST-CODE-0003', 777);
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        post(base, '/wallet/redeem', { code: 'MIV-TEST-CODE-0003', idempotencyKey: `idem-race-000${i}` }, { cookie: f.cookie, csrf: f.body.csrfToken })),
    );
    assert.equal(results.filter((r) => r.status === 200).length, 1);
    assert.equal(results.filter((r) => r.status === 400).length, 7);
    const wallet = await (await request(base, 'GET', '/wallet', { cookie: f.cookie })).json();
    assert.equal(wallet.availableFen, 777);
  });

  test('流水分页：keyset 翻页与非法 cursor', async () => {
    const c = await signUp(base, provider, '15800000003');
    for (const [id, day, amount] of [['led_t1', '2026-01-03T00:00:00Z', 300], ['led_t2', '2026-01-02T00:00:00Z', 200], ['led_t3', '2026-01-01T00:00:00Z', 100]]) {
      await ctx.db.query(
        `INSERT INTO ledger (id, user_id, kind, amount_fen, frozen_delta_fen, title, idempotency_key, created_at)
         VALUES ($1, $2, 'recharge', $3, 0, '测试充值', $4, $5)`,
        [id, c.body.user.id, amount, `test-led-${id}`, day],
      );
    }
    const page1 = await (await request(base, 'GET', '/wallet/ledger?limit=2', { cookie: c.cookie })).json();
    assert.deepEqual(page1.items.map((i) => i.id), ['led_t1', 'led_t2']);
    assert.deepEqual(page1.items.map((i) => i.amountFen), [300, 200]);
    assert.ok(page1.nextCursor);
    const page2 = await (await request(base, 'GET', `/wallet/ledger?limit=2&cursor=${encodeURIComponent(page1.nextCursor)}`, { cookie: c.cookie })).json();
    assert.deepEqual(page2.items.map((i) => i.id), ['led_t3']);
    assert.equal(page2.nextCursor, null);
    const bad = await request(base, 'GET', '/wallet/ledger?cursor=garbage', { cookie: c.cookie });
    assert.equal(bad.status, 400);
    assert.ok((await bad.json()).details.fields.cursor);
  });

  test('报价估算：PRD 默认口径（30 秒下限，缺形象计入上下限），档位或风格非法 400，他人数字人 404', async () => {
    await insertCharacter(ctx.db, 'chr_a1', userA);
    await insertCharacter(ctx.db, 'chr_a2', userA);
    await ctx.db.query(`INSERT INTO characters (id, user_id, name) VALUES ('chr_a3', $1, '测试角色')`, [userA]);
    // chr_a1：本风格已有 succeeded 选中形象（不计缺形象）；chr_a3：选中形象 failed（计缺形象）
    // selected_version_id 的 FK 是 DEFERRABLE，须在同一事务内插入环引用的两表
    await ctx.db.tx(async (t) => {
      await t.query(`INSERT INTO character_looks (id, character_id, style_id, selected_version_id) VALUES ('cl_a1', 'chr_a1', 'realistic', 'lkv_a1')`);
      await t.query(`INSERT INTO look_versions (id, look_id, status) VALUES ('lkv_a1', 'cl_a1', 'succeeded')`);
      await t.query(`INSERT INTO character_looks (id, character_id, style_id, selected_version_id) VALUES ('cl_a3', 'chr_a3', 'realistic', 'lkv_a3')`);
      await t.query(`INSERT INTO look_versions (id, look_id, status) VALUES ('lkv_a3', 'cl_a3', 'failed')`);
    });
    const estimate = (body) => post(base, '/quotes/estimate', body, { cookie, csrf });
    let res = await estimate({ qualityTierId: 'standard', styleId: 'realistic', characterIds: [] });
    assert.equal(res.status, 200);
    // M2-BE-01 真实 SKU：标准 80 分/秒
    assert.deepEqual(await res.json(), { minFen: 2400, maxFen: 7200 });

    res = await estimate({ qualityTierId: 'standard', styleId: 'realistic', characterIds: ['chr_a1', 'chr_a2', 'chr_a3'] });
    assert.equal(res.status, 200);
    // 3 个勾选中 2 个缺形象：min = 80×30 + 2×50，max = 80×90 + 2×50
    assert.deepEqual(await res.json(), { minFen: 2500, maxFen: 7300 });

    res = await estimate({ qualityTierId: 'hd', styleId: 'realistic', characterIds: [] });
    assert.deepEqual(await res.json(), { minFen: 4500, maxFen: 13500 });

    res = await estimate({ qualityTierId: 'nope', styleId: 'realistic', characterIds: [] });
    assert.equal(res.status, 400);
    assert.ok((await res.json()).details.fields.qualityTierId);
    res = await estimate({ qualityTierId: 'standard', styleId: 'nope', characterIds: [] });
    assert.equal(res.status, 400);
    assert.ok((await res.json()).details.fields.styleId);

    await insertCharacter(ctx.db, 'chr_other1', 'usr_other00000001');
    res = await estimate({ qualityTierId: 'standard', styleId: 'realistic', characterIds: ['chr_other1'] });
    assert.equal(res.status, 404);
  });

  test('报价 look_regenerate：契约字段齐全；他人资源 404；缺字段 400', async () => {
    let res = await post(base, '/quotes', { kind: 'look_regenerate', characterId: 'chr_a1', styleId: 'realistic' }, { cookie, csrf });
    assert.equal(res.status, 200);
    const quote = await res.json();
    assert.match(quote.quoteId, /^qt_/);
    assert.equal(quote.kind, 'look_regenerate');
    assert.equal(quote.amountFen, 50);
    assert.deepEqual(quote.breakdown, [{ label: '生成形象 · 真人写实', amountFen: 50 }]);
    assert.match(quote.expiresAt, /^\d{4}-\d{2}-\d{2}T/);

    res = await post(base, '/quotes', { kind: 'look_regenerate', characterId: 'chr_other1', styleId: 'realistic' }, { cookie, csrf });
    assert.equal(res.status, 404);

    res = await post(base, '/quotes', { kind: 'look_regenerate', styleId: 'realistic' }, { cookie, csrf });
    assert.equal(res.status, 400);
    assert.ok((await res.json()).details.fields.characterId);

    res = await post(base, '/quotes', { kind: 'nope', projectId: 'prj_x' }, { cookie, csrf });
    assert.equal(res.status, 400);
    assert.ok((await res.json()).details.fields.kind);
  });

  test('报价 project_render / segment_take / cast_looks：按锁定档位映射取价，明细为中文', async () => {
    await insertProject(ctx.db, 'prj_a1', userA);
    await insertSegment(ctx.db, 'seg_a1', 'prj_a1', 0, 10);
    await insertSegment(ctx.db, 'seg_a2', 'prj_a1', 1, 30);
    await insertCast(ctx.db, 'cast_a1', 'prj_a1', 0);
    await insertCast(ctx.db, 'cast_a2', 'prj_a1', 1);

    let res = await post(base, '/quotes', { kind: 'project_render', projectId: 'prj_a1' }, { cookie, csrf });
    assert.equal(res.status, 200);
    let quote = await res.json();
    assert.equal(quote.amountFen, 3200); // M2-BE-01：(10 + 30) 秒 × 80 分/秒
    assert.deepEqual(quote.breakdown, [
      { label: '片段 1 · 10 秒 · 标准', amountFen: 800 },
      { label: '片段 2 · 30 秒 · 标准', amountFen: 2400 },
    ]);

    res = await post(base, '/quotes', { kind: 'segment_take', projectId: 'prj_a1', segmentId: 'seg_a2' }, { cookie, csrf });
    quote = await res.json();
    assert.equal(res.status, 200);
    assert.equal(quote.amountFen, 2400);
    assert.deepEqual(quote.breakdown, [{ label: '片段 2 · 30 秒 · 标准', amountFen: 2400 }]);

    res = await post(base, '/quotes', { kind: 'cast_looks', projectId: 'prj_a1' }, { cookie, csrf });
    quote = await res.json();
    assert.equal(res.status, 200);
    assert.equal(quote.amountFen, 100); // 2 个缺形象角色 × 0.50 元
    assert.deepEqual(quote.breakdown, [{ label: '生成形象 × 2 · 真人写实', amountFen: 100 }]);

    res = await post(base, '/quotes', { kind: 'project_render', projectId: 'prj_nope' }, { cookie, csrf });
    assert.equal(res.status, 404);
    res = await post(base, '/quotes', { kind: 'segment_take', projectId: 'prj_a1', segmentId: 'seg_other' }, { cookie, csrf });
    assert.equal(res.status, 404);
  });

  test('consumeQuote：原子占用成功后再次使用返回 QUOTE_EXPIRED；未知报价 NOT_FOUND', async () => {
    const created = await (await post(base, '/quotes', { kind: 'look_regenerate', characterId: 'chr_a1', styleId: 'realistic' }, { cookie, csrf })).json();
    const ref = { kind: 'look_regenerate', refType: 'character', refId: 'chr_a1' };
    const first = await ctx.db.tx((t) => consumeQuote(t, { userId: userA, quoteId: created.quoteId, ...ref }));
    assert.equal(first.quote.id, created.quoteId);
    assert.equal(first.priced.amountFen, 50);
    const { rows } = await ctx.db.query(`SELECT consumed_at FROM quotes WHERE id = $1`, [created.quoteId]);
    assert.ok(rows[0].consumed_at);
    await assert.rejects(
      () => ctx.db.tx((t) => consumeQuote(t, { userId: userA, quoteId: created.quoteId, ...ref })),
      (err) => err.code === 'QUOTE_EXPIRED',
    );
    await assert.rejects(
      () => ctx.db.tx((t) => consumeQuote(t, { userId: userA, quoteId: 'qt_nope', ...ref })),
      (err) => err.code === 'NOT_FOUND',
    );
  });

  test('consumeQuote 归属校验（§6 审查 5）：声明与报价不符返回 QUOTE_MISMATCH，占用回滚', async () => {
    const created = await (await post(base, '/quotes', { kind: 'look_regenerate', characterId: 'chr_a1', styleId: 'realistic' }, { cookie, csrf })).json();
    // 拿 chr_a1 的报价去确认 chr_a2
    await assert.rejects(
      () => ctx.db.tx((t) => consumeQuote(t, { userId: userA, quoteId: created.quoteId, kind: 'look_regenerate', refType: 'character', refId: 'chr_a2' })),
      (err) => err.code === 'QUOTE_MISMATCH',
    );
    // 换一个 kind 声明
    await assert.rejects(
      () => ctx.db.tx((t) => consumeQuote(t, { userId: userA, quoteId: created.quoteId, kind: 'project_render', refType: 'project', refId: 'chr_a1' })),
      (err) => err.code === 'QUOTE_MISMATCH',
    );
    const { rows } = await ctx.db.query(`SELECT consumed_at FROM quotes WHERE id = $1`, [created.quoteId]);
    assert.equal(rows[0].consumed_at, null, '归属不符的占用应随事务回滚');
  });

  test('segment_take 跨作品报价 404（§6 审查 5）', async () => {
    await insertProject(ctx.db, 'prj_b1', userA);
    await insertSegment(ctx.db, 'seg_b1', 'prj_b1', 0, 20);
    // seg_b1 属于 prj_b1，却声明 prj_a1 → 404
    const bad = await post(base, '/quotes', { kind: 'segment_take', projectId: 'prj_a1', segmentId: 'seg_b1' }, { cookie, csrf });
    assert.equal(bad.status, 404);
    const ok = await post(base, '/quotes', { kind: 'segment_take', projectId: 'prj_b1', segmentId: 'seg_b1' }, { cookie, csrf });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).amountFen, 1600); // M2-BE-01：20 秒 × 80 分/秒
  });

  test('过期报价使用返回 QUOTE_EXPIRED', async () => {
    const created = await (await post(base, '/quotes', { kind: 'look_regenerate', characterId: 'chr_a1', styleId: 'realistic' }, { cookie, csrf })).json();
    await ctx.db.query(`UPDATE quotes SET expires_at = now() - interval '1 second' WHERE id = $1`, [created.quoteId]);
    await assert.rejects(
      () => ctx.db.tx((t) => consumeQuote(t, { userId: userA, quoteId: created.quoteId, kind: 'look_regenerate', refType: 'character', refId: 'chr_a1' })),
      (err) => err.code === 'QUOTE_EXPIRED',
    );
  });

  test('调价后旧报价 QUOTE_MISMATCH，且占用已回滚可重新报价', async () => {
    const created = await (await post(base, '/quotes', { kind: 'look_regenerate', characterId: 'chr_a1', styleId: 'realistic' }, { cookie, csrf })).json();
    // 模拟调价：新增 version 2，单价 50 → 60（settings.look_image_sku_code 现指向 image.gpt2.1k，迁移 005）
    await ctx.db.query(
      `INSERT INTO skus (id, sku_code, version, kind, model, channel, resolution, unit, price_fen, cost_fen, durations)
       VALUES ('sku_gpt21k0000000002', 'image.gpt2.1k', 2, 'image', 'gpt-image-2', 'modelhub', '1k', 'image', 60, 21, '{}')`,
    );
    try {
      await assert.rejects(
        () => ctx.db.tx((t) => consumeQuote(t, { userId: userA, quoteId: created.quoteId, kind: 'look_regenerate', refType: 'character', refId: 'chr_a1' })),
        (err) => err.code === 'QUOTE_MISMATCH',
      );
      const { rows } = await ctx.db.query(`SELECT consumed_at FROM quotes WHERE id = $1`, [created.quoteId]);
      assert.equal(rows[0].consumed_at, null, '比对失败的占用应随事务回滚');
    } finally {
      await ctx.db.query(`DELETE FROM skus WHERE id = 'sku_gpt21k0000000002'`);
    }
  });

  test('参数变化（新增片段）后旧报价 QUOTE_MISMATCH', async () => {
    const created = await (await post(base, '/quotes', { kind: 'project_render', projectId: 'prj_a1' }, { cookie, csrf })).json();
    await insertSegment(ctx.db, 'seg_a3', 'prj_a1', 2, 15);
    await assert.rejects(
      () => ctx.db.tx((t) => consumeQuote(t, { userId: userA, quoteId: created.quoteId, kind: 'project_render', refType: 'project', refId: 'prj_a1' })),
      (err) => err.code === 'QUOTE_MISMATCH',
    );
  });

  test('并发预占不超扣；settle / refund 走冻结；流水齐全', async () => {
    await ctx.db.query(`UPDATE wallets SET available_fen = 100, frozen_fen = 0 WHERE user_id = $1`, [userA]);
    const reserveOne = (i) => ctx.db.tx((t) => reserve(t, {
      userId: userA, amountFen: 30, refType: 'quote', refId: `qt_test_${i}`, idempotencyKey: `test-rsv-${i}`, title: '作品《测试》预占',
    }));
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => reserveOne(i).then(
      (r) => ({ ok: true, r }),
      (err) => ({ ok: false, err }),
    )));
    assert.equal(results.filter((r) => r.ok).length, 3, '100 分只够预占 3 次 30 分');
    assert.equal(results.filter((r) => !r.ok).every((r) => r.err.code === 'INSUFFICIENT_BALANCE'), true);
    const okIndex = results.findIndex((r) => r.ok); // 成功的是哪几个 key 是随机的，后续断言用实际成功的那个

    let wallet = await (await request(base, 'GET', '/wallet', { cookie })).json();
    assert.deepEqual(wallet, { availableFen: 10, frozenFen: 90 });

    // 幂等重放：同键不重复冻结；同键不同金额 409
    const replay = await ctx.db.tx((t) => reserve(t, {
      userId: userA, amountFen: 30, refType: 'quote', refId: `qt_test_${okIndex}`, idempotencyKey: `test-rsv-${okIndex}`, title: '作品《测试》预占',
    }));
    assert.equal(replay.replayed, true);
    wallet = await (await request(base, 'GET', '/wallet', { cookie })).json();
    assert.deepEqual(wallet, { availableFen: 10, frozenFen: 90 });
    await assert.rejects(
      () => ctx.db.tx((t) => reserve(t, {
        userId: userA, amountFen: 20, refType: 'quote', refId: `qt_test_${okIndex}`, idempotencyKey: `test-rsv-${okIndex}`, title: '作品《测试》预占',
      })),
      (err) => err.code === 'IDEMPOTENCY_CONFLICT',
    );

    // 结算两个、退回一个：10 + 30 = 40 可用，冻结清零
    for (const i of [0, 1]) {
      await ctx.db.tx((t) => settle(t, {
        userId: userA, amountFen: 30, refType: 'quote', refId: `qt_test_${i}`, idempotencyKey: `test-stl-${i}`, title: '作品《测试》结算',
      }));
    }
    await ctx.db.tx((t) => refund(t, {
      userId: userA, amountFen: 30, refType: 'quote', refId: 'qt_test_2', idempotencyKey: 'test-rfd-2', title: '作品《测试》退回',
    }));
    wallet = await (await request(base, 'GET', '/wallet', { cookie })).json();
    assert.deepEqual(wallet, { availableFen: 40, frozenFen: 0 });

    const { rows } = await ctx.db.query(
      `SELECT kind, count(*)::int AS n FROM ledger WHERE user_id = $1 AND idempotency_key LIKE 'test-%' GROUP BY kind ORDER BY kind`,
      [userA],
    );
    assert.deepEqual(rows, [
      { kind: 'refund', n: 1 },
      { kind: 'reserve', n: 3 },
      { kind: 'settle', n: 2 },
    ]);
  });

  test('服务层：charge 余额不足 402；settle 冻结不足按 INTERNAL 兜底', async () => {
    await ctx.db.query(`UPDATE wallets SET available_fen = 10, frozen_fen = 0 WHERE user_id = $1`, [userA]);
    await assert.rejects(
      () => ctx.db.tx((t) => charge(t, {
        userId: userA, amountFen: 30, refType: 'test', refId: 't1', idempotencyKey: 'test-chg-1', title: '测试扣费',
      })),
      (err) => err.code === 'INSUFFICIENT_BALANCE',
    );
    await assert.rejects(
      () => ctx.db.tx((t) => settle(t, {
        userId: userA, amountFen: 30, refType: 'test', refId: 't2', idempotencyKey: 'test-stl-x', title: '测试结算',
      })),
      (err) => err.code === 'INTERNAL',
    );
  });

  test('金额入口校验（§6 审查 2）：负数与 0 一律 INTERNAL 且不动余额', async () => {
    await ctx.db.query(`UPDATE wallets SET available_fen = 500, frozen_fen = 0 WHERE user_id = $1`, [userA]);
    for (const amountFen of [-500, 0]) {
      await assert.rejects(
        () => ctx.db.tx((t) => charge(t, { userId: userA, amountFen, refType: 'test', refId: 'amt', idempotencyKey: `test-amt-c-${amountFen}`, title: '测试' })),
        (err) => err.code === 'INTERNAL',
      );
      await assert.rejects(
        () => ctx.db.tx((t) => reserve(t, { userId: userA, amountFen, refType: 'test', refId: 'amt', idempotencyKey: `test-amt-r-${amountFen}`, title: '测试' })),
        (err) => err.code === 'INTERNAL',
      );
    }
    const wallet = await (await request(base, 'GET', '/wallet', { cookie })).json();
    assert.deepEqual(wallet, { availableFen: 500, frozenFen: 0 });
  });

  test('幂等键跨用户冲突（§6 审查 3）：他人复用同键返回 409 且不动余额', async () => {
    await ctx.db.tx((t) => charge(t, { userId: userA, amountFen: 10, refType: 'test', refId: 'k1', idempotencyKey: 'test-cross-user-1', title: '测试' }));
    const before = await (await request(base, 'GET', '/wallet', { cookie })).json();
    await assert.rejects(
      () => ctx.db.tx((t) => charge(t, { userId: 'usr_other00000001', amountFen: 10, refType: 'test', refId: 'k1', idempotencyKey: 'test-cross-user-1', title: '测试' })),
      (err) => err.code === 'IDEMPOTENCY_CONFLICT',
    );
    const after = await (await request(base, 'GET', '/wallet', { cookie })).json();
    assert.deepEqual(after, before, '他人复用幂等键不得影响任何一方余额');
  });

  test('重放比对含 frozen_delta_fen（§6 审查 4）：同键不同结算金额返回 409', async () => {
    await ctx.db.query(`UPDATE wallets SET available_fen = 300, frozen_fen = 0 WHERE user_id = $1`, [userA]);
    await ctx.db.tx((t) => reserve(t, { userId: userA, amountFen: 100, refType: 'test', refId: 'fd', idempotencyKey: 'test-fd-r', title: '测试' }));
    await ctx.db.tx((t) => settle(t, { userId: userA, amountFen: 100, refType: 'test', refId: 'fd', idempotencyKey: 'test-fd-s', title: '测试' }));
    await assert.rejects(
      () => ctx.db.tx((t) => settle(t, { userId: userA, amountFen: 200, refType: 'test', refId: 'fd', idempotencyKey: 'test-fd-s', title: '测试' })),
      (err) => err.code === 'IDEMPOTENCY_CONFLICT',
    );
  });

  test('同事务多条流水翻页不丢不重（§6 审查 1）', async () => {
    const d = await signUp(base, provider, '15800000004');
    const userIdD = d.body.user.id;
    await ctx.db.query(`UPDATE wallets SET available_fen = 100, frozen_fen = 0 WHERE user_id = $1`, [userIdD]);
    // 同一事务内 3 笔流水：created_at 完全相同（now() 为事务开始时间），毫秒游标会整段跳过
    await ctx.db.tx(async (t) => {
      for (let i = 0; i < 3; i += 1) {
        await charge(t, { userId: userIdD, amountFen: 1, refType: 'test', refId: `t${i}`, idempotencyKey: `test-page-${i}`, title: '测试扣费' });
      }
    });
    const seen = [];
    let cursor = '';
    for (let page = 0; page < 6; page += 1) {
      const res = await request(base, 'GET', `/wallet/ledger?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, { cookie: d.cookie });
      assert.equal(res.status, 200);
      const body = await res.json();
      seen.push(...body.items.map((i) => i.id));
      if (!body.nextCursor) break;
      cursor = body.nextCursor;
    }
    assert.equal(seen.length, 3, `应逐页翻满 3 条，实际 ${seen.length}`);
    assert.equal(new Set(seen).size, 3, '翻页不得重复');
  });

  test('兑换码尝试上限（§6 审查 7）：同一用户 1 小时内最多 10 次', async () => {
    const e = await signUp(base, provider, '15800000005');
    for (let i = 0; i < 10; i += 1) {
      const res = await post(base, '/wallet/redeem', { code: 'MIV-GUESS', idempotencyKey: `test-guess-${i}` }, { cookie: e.cookie, csrf: e.body.csrfToken });
      assert.equal(res.status, 400, `第 ${i + 1} 次应为验证失败`);
    }
    const limited = await post(base, '/wallet/redeem', { code: 'MIV-GUESS', idempotencyKey: 'test-guess-11' }, { cookie: e.cookie, csrf: e.body.csrfToken });
    assert.equal(limited.status, 429);
    assert.equal((await limited.json()).code, 'RATE_LIMITED');
  });
});
