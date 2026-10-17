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
    await insertRedeemCode(ctx.db, 'MIV-TEST-CODE-0003', 777);
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        post(base, '/wallet/redeem', { code: 'MIV-TEST-CODE-0003', idempotencyKey: `idem-race-000${i}` }, { cookie, csrf })),
    );
    assert.equal(results.filter((r) => r.status === 200).length, 1);
    assert.equal(results.filter((r) => r.status === 400).length, 7);
    const wallet = await (await request(base, 'GET', '/wallet', { cookie })).json();
    assert.equal(wallet.availableFen, 1777);
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

  test('报价估算：默认口径 min/max，档位或风格非法 400，他人数字人 404', async () => {
    await insertCharacter(ctx.db, 'chr_a1', userA);
    await insertCharacter(ctx.db, 'chr_a2', userA);
    const estimate = (body) => post(base, '/quotes/estimate', body, { cookie, csrf });
    let res = await estimate({ qualityTierId: 'standard', styleId: 'realistic', characterIds: [] });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { minFen: 100, maxFen: 1800 });

    res = await estimate({ qualityTierId: 'standard', styleId: 'realistic', characterIds: ['chr_a1', 'chr_a2'] });
    assert.deepEqual(await res.json(), { minFen: 100, maxFen: 1900 });

    res = await estimate({ qualityTierId: 'hd', styleId: 'realistic', characterIds: [] });
    assert.deepEqual(await res.json(), { minFen: 200, maxFen: 3600 });

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
    assert.equal(quote.amountFen, 800); // (10 + 30) 秒 × 0.20 元/秒
    assert.deepEqual(quote.breakdown, [
      { label: '片段 1 · 10 秒 · 标准', amountFen: 200 },
      { label: '片段 2 · 30 秒 · 标准', amountFen: 600 },
    ]);

    res = await post(base, '/quotes', { kind: 'segment_take', projectId: 'prj_a1', segmentId: 'seg_a2' }, { cookie, csrf });
    quote = await res.json();
    assert.equal(res.status, 200);
    assert.equal(quote.amountFen, 600);
    assert.deepEqual(quote.breakdown, [{ label: '片段 2 · 30 秒 · 标准', amountFen: 600 }]);

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
    const first = await ctx.db.tx((t) => consumeQuote(t, { userId: userA, quoteId: created.quoteId }));
    assert.equal(first.quote.id, created.quoteId);
    assert.equal(first.priced.amountFen, 50);
    const { rows } = await ctx.db.query(`SELECT consumed_at FROM quotes WHERE id = $1`, [created.quoteId]);
    assert.ok(rows[0].consumed_at);
    await assert.rejects(
      () => ctx.db.tx((t) => consumeQuote(t, { userId: userA, quoteId: created.quoteId })),
      (err) => err.code === 'QUOTE_EXPIRED',
    );
    await assert.rejects(
      () => ctx.db.tx((t) => consumeQuote(t, { userId: userA, quoteId: 'qt_nope' })),
      (err) => err.code === 'NOT_FOUND',
    );
  });

  test('过期报价使用返回 QUOTE_EXPIRED', async () => {
    const created = await (await post(base, '/quotes', { kind: 'look_regenerate', characterId: 'chr_a1', styleId: 'realistic' }, { cookie, csrf })).json();
    await ctx.db.query(`UPDATE quotes SET expires_at = now() - interval '1 second' WHERE id = $1`, [created.quoteId]);
    await assert.rejects(
      () => ctx.db.tx((t) => consumeQuote(t, { userId: userA, quoteId: created.quoteId })),
      (err) => err.code === 'QUOTE_EXPIRED',
    );
  });

  test('调价后旧报价 QUOTE_MISMATCH，且占用已回滚可重新报价', async () => {
    const created = await (await post(base, '/quotes', { kind: 'look_regenerate', characterId: 'chr_a1', styleId: 'realistic' }, { cookie, csrf })).json();
    // 模拟调价：新增 version 2，单价 50 → 60
    await ctx.db.query(
      `INSERT INTO skus (id, sku_code, version, kind, model, channel, resolution, unit, price_fen, cost_fen, durations)
       VALUES ('sku_mockimage2k0002', 'image.mock.2k', 2, 'image', 'mock-image', 'mock', '2k', 'image', 60, 0, '{}')`,
    );
    try {
      await assert.rejects(
        () => ctx.db.tx((t) => consumeQuote(t, { userId: userA, quoteId: created.quoteId })),
        (err) => err.code === 'QUOTE_MISMATCH',
      );
      const { rows } = await ctx.db.query(`SELECT consumed_at FROM quotes WHERE id = $1`, [created.quoteId]);
      assert.equal(rows[0].consumed_at, null, '比对失败的占用应随事务回滚');
    } finally {
      await ctx.db.query(`DELETE FROM skus WHERE id = 'sku_mockimage2k0002'`);
    }
  });

  test('参数变化（新增片段）后旧报价 QUOTE_MISMATCH', async () => {
    const created = await (await post(base, '/quotes', { kind: 'project_render', projectId: 'prj_a1' }, { cookie, csrf })).json();
    await insertSegment(ctx.db, 'seg_a3', 'prj_a1', 2, 15);
    await assert.rejects(
      () => ctx.db.tx((t) => consumeQuote(t, { userId: userA, quoteId: created.quoteId })),
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
});
