import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { silentLogger } from '../src/logger.js';
import { createMemoryStorage } from '../src/queue/cron.js';
import { enqueue } from '../src/queue/index.js';
import { buildHandlers, createWorker } from '../src/worker.js';
import { createTestDb } from './helpers/db.js';
import { mockImageProvider, TINY_PNG } from './helpers/providers.js';

const ORIGIN = 'http://localhost:5173';
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

function captureSmsProvider() {
  const provider = { sent: [], id: 'test-capture', async send({ phone, code }) { provider.sent.push({ phone, code }); } };
  return provider;
}

const mivCookie = (res) => res.headers.getSetCookie().find((c) => c.startsWith('miv_sid='))?.split(';')[0];

async function signUp(base, provider, phone) {
  await post(base, '/auth/sms', { phone });
  const code = provider.sent.at(-1).code;
  const res = await post(base, '/auth/login', { phone, code, agreeTerms: true });
  assert.equal(res.status, 200);
  const body = await res.json();
  return { body, cookie: mivCookie(res), csrf: body.csrfToken, userId: body.user.id };
}

function post(base, path, body, opts = {}) {
  const headers = { 'Content-Type': 'application/json', Origin: ORIGIN, ...(opts.cookie ? { Cookie: opts.cookie } : {}), ...(opts.csrf ? { 'X-CSRF-Token': opts.csrf } : {}) };
  return fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
}
function send(base, method, path, body, opts = {}) {
  const headers = { Origin: ORIGIN, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(opts.cookie ? { Cookie: opts.cookie } : {}), ...(opts.csrf ? { 'X-CSRF-Token': opts.csrf } : {}) };
  return fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}
function multipart(base, path, { cookie, csrf }, filename, buffer) {
  const form = new FormData();
  form.append('file', new Blob([buffer]), filename);
  return fetch(`${base}${path}`, { method: 'POST', headers: { Cookie: cookie, Origin: ORIGIN, 'X-CSRF-Token': csrf }, body: form });
}

/** 记录 put/remove 的内存存储。 */
function recordingStorage() {
  const memory = createMemoryStorage();
  const puts = [];
  const removed = [];
  return {
    puts,
    removed,
    async put(key, buffer, opts) { puts.push({ key, buffer, opts }); return memory.put(key, buffer, opts); },
    async signedUrl(key) { return memory.signedUrl(key); },
    async remove(keys) { removed.push(...keys); return memory.remove(keys); },
  };
}

describe('assets（M1-BE-04）', () => {
  let ctx;
  let server;
  let base;
  let provider;
  let storage;
  let A; // 主用户
  let B; // 他人
  let sms; // 与 app 共用的短信 provider 实例
  let limitedServer;
  let limitedBase;
  let noExtractServer;
  let noExtractBase;

  before(async () => {
    ctx = await createTestDb();
    provider = mockImageProvider();
    storage = recordingStorage();
    sms = captureSmsProvider(); // 登录用与注入 app 的必须是同一实例
    const app = createApp({
      config: loadConfig({ NODE_ENV: 'test' }), db: ctx.db, logger: silentLogger,
      urlFor: (key) => `https://cdn.test/${key}`, storage, extractText: async () => '提取的正文',
      smsProvider: sms,
    });
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}/api/v1`;
    A = await signUp(base, sms, '15800000001');
    B = await signUp(base, sms, '15800000002');

    // 独立配置：上传上限 2（配额测试）；无 extractText（docx 不支持）
    const limited = createApp({
      config: loadConfig({ NODE_ENV: 'test', UPLOADS_MAX_UNREFERENCED: '2' }), db: ctx.db, logger: silentLogger,
      urlFor: (key) => `https://cdn.test/${key}`, storage, smsProvider: captureSmsProvider(),
    });
    limitedServer = limited.listen(0, '127.0.0.1');
    await new Promise((resolve) => limitedServer.once('listening', resolve));
    limitedBase = `http://127.0.0.1:${limitedServer.address().port}/api/v1`;
    const noExtract = createApp({
      config: loadConfig({ NODE_ENV: 'test' }), db: ctx.db, logger: silentLogger,
      urlFor: (key) => `https://cdn.test/${key}`, storage, smsProvider: captureSmsProvider(),
    });
    noExtractServer = noExtract.listen(0, '127.0.0.1');
    await new Promise((resolve) => noExtractServer.once('listening', resolve));
    noExtractBase = `http://127.0.0.1:${noExtractServer.address().port}/api/v1`;
  });
  after(async () => {
    for (const s of [server, limitedServer, noExtractServer]) await new Promise((resolve) => s.close(resolve));
    await ctx.drop();
  });

  test('上传：文件头校验（伪装扩展名被拒）、URL 经 urlFor 签发', async () => {
    const ok = await multipart(base, '/uploads/image', A, 'photo.jpg', TINY_PNG); // PNG 内容配 .jpg 名：以文件头为准
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.match(body.uploadId, /^upl_/);
    assert.match(body.url, /^https:\/\/cdn\.test\/users\/usr_[^/]+\/uploads\/upl_/);

    const fake = await multipart(base, '/uploads/image', A, 'photo.jpg', Buffer.from('这不是图片'));
    assert.equal(fake.status, 400);
    assert.equal((await fake.json()).code, 'UPLOAD_TYPE_INVALID');

    const gif = await multipart(base, '/uploads/image', A, 'x.png', Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]));
    assert.equal(gif.status, 400);

    const jpeg = await multipart(base, '/uploads/image', A, 'x.png', JPEG_BYTES);
    assert.equal(jpeg.status, 200, 'JPEG 文件头可通过');
  });

  test('上传：超过 10MB 立即中断返回 UPLOAD_TOO_LARGE', async () => {
    const big = Buffer.concat([TINY_PNG, Buffer.alloc(10 * 1024 * 1024)]);
    const res = await multipart(base, '/uploads/image', A, 'big.png', big);
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, 'UPLOAD_TOO_LARGE');
  });

  test('上传：每个用户未引用图片上限（超出 429）', async () => {
    const c = await signUp(base, sms, '15800000003');
    for (let i = 0; i < 2; i += 1) {
      const res = await multipart(limitedBase, '/uploads/image', c, `p${i}.png`, TINY_PNG);
      assert.equal(res.status, 200);
    }
    const third = await multipart(limitedBase, '/uploads/image', c, 'p3.png', TINY_PNG);
    assert.equal(third.status, 429);
    assert.equal((await third.json()).code, 'RATE_LIMITED');
  });

  test('故事上传：txt 去 BOM 提取正文；docx 走注入的 extractText，未注入返回 UPLOAD_TYPE_INVALID', async () => {
    const txt = await multipart(base, '/uploads/story', A, '我的故事.txt', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('  从前有一只小猫。\n')]));
    assert.equal(txt.status, 200);
    assert.deepEqual(await txt.json(), { title: '我的故事', text: '从前有一只小猫。' });

    const docx = Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.from('fake-docx')]);
    const withExtract = await multipart(base, '/uploads/story', A, '故事.docx', docx);
    assert.deepEqual(await withExtract.json(), { title: '故事', text: '提取的正文' });

    const withoutExtract = await multipart(noExtractBase, '/uploads/story', A, '故事.docx', docx);
    assert.equal(withoutExtract.status, 400);
    assert.equal((await withoutExtract.json()).code, 'UPLOAD_TYPE_INVALID');

    const empty = await multipart(base, '/uploads/story', A, 'empty.txt', Buffer.from('   '));
    assert.equal(empty.status, 400);
  });

  test('创建数字人：引用校验、无照片必填描述、非法音色 400', async () => {
    const badRef = await post(base, '/characters', { name: '妈妈', photoUploadIds: ['upl_nope'] }, { cookie: A.cookie, csrf: A.csrf });
    assert.equal(badRef.status, 400);
    assert.equal((await badRef.json()).message, '部分图片不存在、已失效或已被其他数字人使用，请重新上传');

    const others = await multipart(base, '/uploads/image', B, 'b.png', TINY_PNG);
    const othersId = (await others.json()).uploadId;
    const notMine = await post(base, '/characters', { name: '妈妈', photoUploadIds: [othersId] }, { cookie: A.cookie, csrf: A.csrf });
    assert.equal(notMine.status, 400, '引用他人上传 400');

    const noDesc = await post(base, '/characters', { name: '宝宝', photoUploadIds: [] }, { cookie: A.cookie, csrf: A.csrf });
    assert.equal(noDesc.status, 400);
    assert.ok((await noDesc.json()).details.fields.description);

    const badVoice = await post(base, '/characters', { name: '宝宝', description: '5 岁小女孩', defaultVoiceId: 'vc_nope' }, { cookie: A.cookie, csrf: A.csrf });
    assert.equal(badVoice.status, 400);
    assert.ok((await badVoice.json()).details.fields.defaultVoiceId);

    const ok = await post(base, '/characters', { name: '妈妈', description: '30 岁女性，短发', tags: ['家人'] }, { cookie: A.cookie, csrf: A.csrf });
    assert.equal(ok.status, 201);
    const chr = await ok.json();
    assert.match(chr.id, /^chr_/);
    assert.equal(chr.avatarUrl, undefined, '无照片无形象时没有 avatarUrl');
    assert.deepEqual(chr.styleIds, []);
    assert.equal(chr.worksCount, 0);
  });

  test('数字人详情/列表/他人资源 404', async () => {
    const up = await multipart(base, '/uploads/image', A, 'a1.png', TINY_PNG);
    const uploadId = (await up.json()).uploadId;
    const created = await (await post(base, '/characters', { name: '爸爸', photoUploadIds: [uploadId] }, { cookie: A.cookie, csrf: A.csrf })).json();

    const detail = await (await send(base, 'GET', `/characters/${created.id}`, undefined, { cookie: A.cookie })).json();
    assert.equal(detail.photos.length, 1);
    assert.equal(detail.photos[0].uploadId, uploadId);
    assert.match(detail.photos[0].url, /^https:\/\/cdn\.test\//);
    assert.match(detail.avatarUrl, /^https:\/\/cdn\.test\/users\//, '无形象时 avatarUrl 取第一张参考照片');

    const list = await (await send(base, 'GET', '/characters', undefined, { cookie: A.cookie })).json();
    assert.ok(list.items.some((c) => c.id === created.id));

    for (const [method, path] of [
      ['GET', `/characters/${created.id}`],
      ['PATCH', `/characters/${created.id}`],
      ['PUT', `/characters/${created.id}/photos`],
      ['DELETE', `/characters/${created.id}`],
    ]) {
      const res = await send(base, method, path, method === 'GET' ? undefined : {}, { cookie: B.cookie, csrf: B.csrf });
      assert.equal(res.status, 404, `${method} 他人资源 404`);
    }
  });

  test('PATCH 与照片整体替换：旧照片解除引用交由清理回收；并发替换最终一致', async () => {
    const up1 = (await (await multipart(base, '/uploads/image', A, 'old.png', TINY_PNG)).json()).uploadId;
    const up2 = (await (await multipart(base, '/uploads/image', A, 'new.png', TINY_PNG)).json()).uploadId;
    const created = await (await post(base, '/characters', { name: '爷爷', photoUploadIds: [up1] }, { cookie: A.cookie, csrf: A.csrf })).json();

    const patched = await (await send(base, 'PATCH', `/characters/${created.id}`, { name: '外公', tags: ['家人', '长辈'], defaultVoiceId: 'vc_middlem_dad' }, { cookie: A.cookie, csrf: A.csrf })).json();
    assert.equal(patched.name, '外公');
    assert.equal(patched.defaultVoiceId, 'vc_middlem_dad');
    const cleared = await (await send(base, 'PATCH', `/characters/${created.id}`, { defaultVoiceId: null }, { cookie: A.cookie, csrf: A.csrf })).json();
    assert.equal(cleared.defaultVoiceId, undefined, '显式 null 清除默认音色');

    const replaced = await (await send(base, 'PUT', `/characters/${created.id}/photos`, { uploadIds: [up2] }, { cookie: A.cookie, csrf: A.csrf })).json();
    assert.deepEqual(replaced.photos.map((p) => p.uploadId), [up2]);
    const up1Row = (await ctx.db.query(`SELECT referenced_at FROM uploads WHERE id = $1`, [up1])).rows[0];
    assert.equal(up1Row.referenced_at, null, '被替换的旧照片解除引用，交由 uploads.sweep 回收');

    // 并发整体替换同一上传：不重复、最终一致（唯一约束兜底）
    const results = await Promise.all(Array.from({ length: 5 }, () =>
      send(base, 'PUT', `/characters/${created.id}/photos`, { uploadIds: [up1] }, { cookie: A.cookie, csrf: A.csrf })));
    const statuses = await Promise.all(results.map(async (r) => `${r.status}:${JSON.stringify(await r.json()).slice(0, 120)}`));
    assert.ok(results.every((r) => r.status === 200), `并发替换全部成功，实际 ${statuses.join(' | ')}`);
    const count = (await ctx.db.query(`SELECT count(*)::int AS n FROM character_photos WHERE character_id = $1`, [created.id])).rows[0].n;
    assert.equal(count, 1, '同一上传只关联一行');
    const final = await (await send(base, 'GET', `/characters/${created.id}`, undefined, { cookie: A.cookie })).json();
    assert.deepEqual(final.photos.map((p) => p.uploadId), [up1]);

    const tooMany = await send(base, 'PUT', `/characters/${created.id}/photos`, { uploadIds: [up1, up1, up1, up1, up1, up2] }, { cookie: A.cookie, csrf: A.csrf });
    assert.equal(tooMany.status, 400);
  });

  test('生成形象：预占 → 生成 → 自动选中 → 结算，对账正确（要点 d/e）', async () => {
    await ctx.db.query(`UPDATE wallets SET available_fen = 1000, frozen_fen = 0 WHERE user_id = $1`, [A.userId]);
    const up = (await (await multipart(base, '/uploads/image', A, 'mom.png', TINY_PNG)).json()).uploadId;
    const chr = await (await post(base, '/characters', { name: '妈妈2', photoUploadIds: [up] }, { cookie: A.cookie, csrf: A.csrf })).json();
    const quote = await (await post(base, '/quotes', { kind: 'look_regenerate', characterId: chr.id, styleId: 'realistic' }, { cookie: A.cookie, csrf: A.csrf })).json();

    // 同键并发首发（§6 审查 2）：手机双击场景，两个请求都应返回同一版本，只产生一个版本、只预占一次
    const created2 = await Promise.all([
      post(base, `/characters/${chr.id}/looks/realistic/versions`, { quoteId: quote.quoteId, idempotencyKey: 'look-key-0001' }, { cookie: A.cookie, csrf: A.csrf }),
      post(base, `/characters/${chr.id}/looks/realistic/versions`, { quoteId: quote.quoteId, idempotencyKey: 'look-key-0001' }, { cookie: A.cookie, csrf: A.csrf }),
    ]);
    assert.ok(created2.every((r) => r.status === 202), `并发同键都应 202，实际 ${created2.map((r) => r.status)}`);
    const bodies = await Promise.all(created2.map((r) => r.json()));
    const version = bodies[0];
    assert.match(version.id, /^lkv_/);
    assert.equal(version.status, 'pending');
    assert.ok(bodies.every((v) => v.id === version.id), '并发同键返回同一版本');
    assert.equal((await ctx.db.query(`SELECT count(*)::int AS n FROM gen_tasks WHERE idempotency_key LIKE 'look.create:%look-key-0001'`)).rows[0].n, 1);
    assert.equal((await ctx.db.query(`SELECT count(*)::int AS n FROM look_versions`)).rows[0].n, 1);
    let wallet = (await ctx.db.query(`SELECT available_fen, frozen_fen FROM wallets WHERE user_id = $1`, [A.userId])).rows[0];
    assert.deepEqual(wallet, { available_fen: 950, frozen_fen: 50 }, '只预占一次');

    // Worker 执行（成功 provider）：转存、自动选中、结算
    const handlers = buildHandlers({ config: loadConfig({ NODE_ENV: 'test' }), db: ctx.db, logger: silentLogger, storage, imageProvider: provider });
    const worker = createWorker({ db: ctx.db, logger: silentLogger, handlers, workerId: 'worker-assets', concurrency: 1 });
    assert.equal(await worker.runOne(), true);
    const done = (await ctx.db.query(`SELECT status, image_key FROM look_versions WHERE id = $1`, [version.id])).rows[0];
    assert.equal(done.status, 'succeeded');
    assert.equal(done.image_key, `users/${A.userId}/looks/${version.id}`);
    assert.deepEqual(storage.puts.at(-1)?.key, `users/${A.userId}/looks/${version.id}`);
    const look = (await ctx.db.query(`SELECT selected_version_id FROM character_looks WHERE character_id = $1`, [chr.id])).rows[0];
    assert.equal(look.selected_version_id, version.id, '成功后自动选中新版本');
    wallet = (await ctx.db.query(`SELECT available_fen, frozen_fen FROM wallets WHERE user_id = $1`, [A.userId])).rows[0];
    assert.deepEqual(wallet, { available_fen: 950, frozen_fen: 0 }, '冻结结算，对账正确');
    const ledger = await ctx.db.query(`SELECT kind, idempotency_key FROM ledger WHERE ref_id = $1 AND user_id = $2`, [version.id, A.userId]);
    assert.ok(ledger.rows.some((r) => r.kind === 'reserve' && r.idempotency_key === `look:${version.id}:reserve`));
    assert.ok(ledger.rows.some((r) => r.kind === 'settle' && r.idempotency_key === `look:${version.id}:settle`));

    // 重复执行处理器：不重复结算、不重复调上游
    await handlers['look.generate']({ versionId: version.id }, { db: ctx.db, logger: silentLogger });
    assert.equal(provider.calls.length, 1, '终态后不再调用上游');
    assert.equal((await ctx.db.query(`SELECT count(*)::int AS n FROM ledger WHERE idempotency_key = $1`, [`look:${version.id}:settle`])).rows[0].n, 1, '结算只生效一次');

    // 列表聚合：styleIds 只算成功选中的、avatarUrl 优先形象
    const list = await (await send(base, 'GET', '/characters', undefined, { cookie: A.cookie })).json();
    const mom = list.items.find((c) => c.id === chr.id);
    assert.deepEqual(mom.styleIds, ['realistic']);
    assert.match(mom.avatarUrl, /looks\//, '优先使用形象而非照片');
  });

  test('余额不足 402 且不留版本、报价未消费（要点 g）', async () => {
    const up = (await (await multipart(base, '/uploads/image', A, 'kid.png', TINY_PNG)).json()).uploadId;
    const chr = await (await post(base, '/characters', { name: '宝宝2', photoUploadIds: [up] }, { cookie: A.cookie, csrf: A.csrf })).json();
    await ctx.db.query(`UPDATE wallets SET available_fen = 10, frozen_fen = 0 WHERE user_id = $1`, [A.userId]);
    const quote = await (await post(base, '/quotes', { kind: 'look_regenerate', characterId: chr.id, styleId: 'anime' }, { cookie: A.cookie, csrf: A.csrf })).json();
    const res = await post(base, `/characters/${chr.id}/looks/anime/versions`, { quoteId: quote.quoteId, idempotencyKey: 'look-broke-001' }, { cookie: A.cookie, csrf: A.csrf });
    assert.equal(res.status, 402);
    assert.equal((await res.json()).code, 'INSUFFICIENT_BALANCE');
    assert.equal((await ctx.db.query(`SELECT count(*)::int AS n FROM look_versions lv JOIN gen_tasks gt ON gt.id = lv.gen_task_id WHERE gt.idempotency_key LIKE '%look-broke-001'`)).rows[0].n, 0, '不留版本');
    assert.equal((await ctx.db.query(`SELECT consumed_at FROM quotes WHERE id = $1`, [quote.quoteId])).rows[0].consumed_at, null, '报价消费随事务回滚');
    const wallet = (await ctx.db.query(`SELECT available_fen, frozen_fen FROM wallets WHERE user_id = $1`, [A.userId])).rows[0];
    assert.deepEqual(wallet, { available_fen: 10, frozen_fen: 0 });
  });

  test('上游失败全额退回、unknown 保持冻结不重提、重复执行不重复退回（要点 e/g）', async () => {
    await ctx.db.query(`UPDATE wallets SET available_fen = 500, frozen_fen = 0 WHERE user_id = $1`, [A.userId]);
    const up = (await (await multipart(base, '/uploads/image', A, 'p.png', TINY_PNG)).json()).uploadId;
    const chr = await (await post(base, '/characters', { name: '爸爸2', photoUploadIds: [up] }, { cookie: A.cookie, csrf: A.csrf })).json();
    const quote = await (await post(base, '/quotes', { kind: 'look_regenerate', characterId: chr.id, styleId: 'manga_drama' }, { cookie: A.cookie, csrf: A.csrf })).json();
    const version = await (await post(base, `/characters/${chr.id}/looks/manga_drama/versions`, { quoteId: quote.quoteId, idempotencyKey: 'look-fail-0001' }, { cookie: A.cookie, csrf: A.csrf })).json();

    // 业务失败：版本 failed、全额退回
    const failing = buildHandlers({ config: loadConfig({ NODE_ENV: 'test' }), db: ctx.db, logger: silentLogger, storage, imageProvider: mockImageProvider({ result: 'failed' }) });
    const worker = createWorker({ db: ctx.db, logger: silentLogger, handlers: failing, workerId: 'worker-fail', concurrency: 1 });
    assert.equal(await worker.runOne(), true);
    let row = (await ctx.db.query(`SELECT status, error FROM look_versions WHERE id = $1`, [version.id])).rows[0];
    assert.equal(row.status, 'failed');
    assert.equal(row.error.message, '模拟模型拒绝');
    let wallet = (await ctx.db.query(`SELECT available_fen, frozen_fen FROM wallets WHERE user_id = $1`, [A.userId])).rows[0];
    assert.deepEqual(wallet, { available_fen: 500, frozen_fen: 0 }, '全额退回');
    assert.equal((await ctx.db.query(`SELECT count(*)::int AS n FROM ledger WHERE idempotency_key = $1 AND kind = 'refund'`, [`look:${version.id}:refund`])).rows[0].n, 1);

    // 重复执行：不重复退回、不重复调上游
    const callsBefore = provider.calls.length;
    await failing['look.generate']({ versionId: version.id }, { db: ctx.db, logger: silentLogger });
    wallet = (await ctx.db.query(`SELECT available_fen, frozen_fen FROM wallets WHERE user_id = $1`, [A.userId])).rows[0];
    assert.deepEqual(wallet, { available_fen: 500, frozen_fen: 0 });

    // unknown：版本保持 pending、金额保持冻结、不自动重提
    const unknownProvider = mockImageProvider({ result: 'unknown' });
    const quote2 = await (await post(base, '/quotes', { kind: 'look_regenerate', characterId: chr.id, styleId: 'cartoon_3d' }, { cookie: A.cookie, csrf: A.csrf })).json();
    await ctx.db.query(`UPDATE wallets SET available_fen = 500, frozen_fen = 0 WHERE user_id = $1`, [A.userId]);
    const version2 = await (await post(base, `/characters/${chr.id}/looks/cartoon_3d/versions`, { quoteId: quote2.quoteId, idempotencyKey: 'look-unk-0001' }, { cookie: A.cookie, csrf: A.csrf })).json();
    const unknownHandlers = buildHandlers({ config: loadConfig({ NODE_ENV: 'test' }), db: ctx.db, logger: silentLogger, storage, imageProvider: unknownProvider });
    const worker2 = createWorker({ db: ctx.db, logger: silentLogger, handlers: unknownHandlers, workerId: 'worker-unknown', concurrency: 1 });
    assert.equal(await worker2.runOne(), true);
    row = (await ctx.db.query(`SELECT status FROM look_versions WHERE id = $1`, [version2.id])).rows[0];
    assert.equal(row.status, 'pending', 'unknown 保持 pending');
    assert.equal((await ctx.db.query(`SELECT status FROM gen_tasks WHERE idempotency_key LIKE '%look-unk-0001'`)).rows[0].status, 'unknown');
    wallet = (await ctx.db.query(`SELECT available_fen, frozen_fen FROM wallets WHERE user_id = $1`, [A.userId])).rows[0];
    assert.deepEqual(wallet, { available_fen: 450, frozen_fen: 50 }, '金额保持冻结');
    assert.equal((await ctx.db.query(`SELECT count(*)::int AS n FROM jobs WHERE dedupe_key = $1 AND status = 'done'`, [`look:${version2.id}`])).rows[0].n, 1, '任务完成、不自动重提');
    assert.equal(provider.calls.length, callsBefore, '成功 provider 未被误用');
  });

  test('selection：只能选本数字人本风格的 succeeded 版本（要点 f）', async () => {
    const up = (await (await multipart(base, '/uploads/image', A, 'sel.png', TINY_PNG)).json()).uploadId;
    const chr = await (await post(base, '/characters', { name: '挑选', photoUploadIds: [up] }, { cookie: A.cookie, csrf: A.csrf })).json();
    await ctx.db.query(`UPDATE wallets SET available_fen = 200, frozen_fen = 0 WHERE user_id = $1`, [A.userId]);
    const quote = await (await post(base, '/quotes', { kind: 'look_regenerate', characterId: chr.id, styleId: 'picture_book' }, { cookie: A.cookie, csrf: A.csrf })).json();
    const version = await (await post(base, `/characters/${chr.id}/looks/picture_book/versions`, { quoteId: quote.quoteId, idempotencyKey: 'look-sel-0001' }, { cookie: A.cookie, csrf: A.csrf })).json();
    const handlers = buildHandlers({ config: loadConfig({ NODE_ENV: 'test' }), db: ctx.db, logger: silentLogger, storage, imageProvider: provider });
    const worker = createWorker({ db: ctx.db, logger: silentLogger, handlers, workerId: 'worker-sel', concurrency: 1 });
    await worker.runOne();

    const ok = await send(base, 'PUT', `/characters/${chr.id}/looks/picture_book/selection`, { versionId: version.id }, { cookie: A.cookie, csrf: A.csrf });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).looks[0].selectedVersionId, version.id);

    const bad = await send(base, 'PUT', `/characters/${chr.id}/looks/picture_book/selection`, { versionId: 'lkv_nope' }, { cookie: A.cookie, csrf: A.csrf });
    assert.equal(bad.status, 400);
    const wrongStyle = await send(base, 'PUT', `/characters/${chr.id}/looks/anime/selection`, { versionId: version.id }, { cookie: A.cookie, csrf: A.csrf });
    assert.equal(wrongStyle.status, 400);
  });

  test('软删除：列表/详情不可见，形象版本保留，历史作品引用不受影响（要点 c/g）', async () => {
    const up = (await (await multipart(base, '/uploads/image', A, 'del.png', TINY_PNG)).json()).uploadId;
    const chr = await (await post(base, '/characters', { name: '将删除', photoUploadIds: [up] }, { cookie: A.cookie, csrf: A.csrf })).json();
    await ctx.db.query(`UPDATE wallets SET available_fen = 200, frozen_fen = 0 WHERE user_id = $1`, [A.userId]);
    const quote = await (await post(base, '/quotes', { kind: 'look_regenerate', characterId: chr.id, styleId: 'clay' }, { cookie: A.cookie, csrf: A.csrf })).json();
    const version = await (await post(base, `/characters/${chr.id}/looks/clay/versions`, { quoteId: quote.quoteId, idempotencyKey: 'look-del-0001' }, { cookie: A.cookie, csrf: A.csrf })).json();
    const handlers = buildHandlers({ config: loadConfig({ NODE_ENV: 'test' }), db: ctx.db, logger: silentLogger, storage, imageProvider: provider });
    await createWorker({ db: ctx.db, logger: silentLogger, handlers, workerId: 'worker-del', concurrency: 1 }).runOne();

    const del = await send(base, 'DELETE', `/characters/${chr.id}`, undefined, { cookie: A.cookie, csrf: A.csrf });
    assert.deepEqual(await del.json(), { ok: true });
    assert.equal((await send(base, 'GET', `/characters/${chr.id}`, undefined, { cookie: A.cookie })).status, 404);
    const list = await (await send(base, 'GET', '/characters', undefined, { cookie: A.cookie })).json();
    assert.ok(!list.items.some((c) => c.id === chr.id));
    assert.equal((await ctx.db.query(`SELECT count(*)::int AS n FROM look_versions WHERE id = $1`, [version.id])).rows[0].n, 1, '形象版本保留');

    // 历史作品引用：project_cast 行仍在，join 未删除作品可统计（BE-06 依赖）
    await ctx.db.query(
      `INSERT INTO projects (id, user_id, story_text, source_type, style_id, quality_tier_id, tier_mapping_id, status)
       VALUES ('prj_hist', $1, '历史', 'text', 'realistic', 'standard', 'tm_standard00000001', 'delivered')`,
      [A.userId],
    );
    await ctx.db.query(
      `INSERT INTO project_cast (id, project_id, idx, name, match_source, character_id) VALUES ('cast_hist', 'prj_hist', 0, '角色', 'user', $1)`,
      [chr.id],
    );
    const joined = (await ctx.db.query(
      `SELECT p.id FROM project_cast pc JOIN projects p ON p.id = pc.project_id WHERE pc.character_id = $1 AND p.deleted_at IS NULL`,
      [chr.id],
    )).rows;
    assert.deepEqual(joined.map((r) => r.id), ['prj_hist'], '软删除不影响历史作品查询');
  });

  test('上传引用独占（§6 审查 1）：被其他数字人使用的照片拒绝复用，替换后清理不报错', async () => {
    const up = (await (await multipart(base, '/uploads/image', A, 'share.png', TINY_PNG)).json()).uploadId;
    const chr1 = await (await post(base, '/characters', { name: '甲', photoUploadIds: [up] }, { cookie: A.cookie, csrf: A.csrf })).json();
    // 同用户第二个数字人复用同一张照片 → 400（引用独占）
    const conflict = await post(base, '/characters', { name: '乙', photoUploadIds: [up] }, { cookie: A.cookie, csrf: A.csrf });
    assert.equal(conflict.status, 400);

    // 遗留共用数据（绕过 API 直接造）：chr2 的照片行也引用 up，然后 chr1 替换照片
    await post(base, '/characters', { name: '丙', description: '描述' }, { cookie: A.cookie, csrf: A.csrf });
    const chr2Id = (await (await send(base, 'GET', '/characters', undefined, { cookie: A.cookie })).json()).items.find((c) => c.name === '丙').id;
    await ctx.db.query(`INSERT INTO character_photos (id, character_id, upload_id) VALUES ('cph_legacy', $1, $2)`, [chr2Id, up]);
    const up2 = (await (await multipart(base, '/uploads/image', A, 'share2.png', TINY_PNG)).json()).uploadId;
    const replaced = await send(base, 'PUT', `/characters/${chr1.id}/photos`, { uploadIds: [up2] }, { cookie: A.cookie, csrf: A.csrf });
    assert.equal(replaced.status, 200);
    // up 仍被 chr2 的遗留照片行引用：referenced_at 不得被清空（清了 sweep 会跳过且不会误删）
    const refRow = (await ctx.db.query(`SELECT referenced_at FROM uploads WHERE id = $1`, [up])).rows[0];
    assert.ok(refRow.referenced_at, '仍被其他数字人照片行引用的上传不清引用');

    // sweep 防御：即使出现 referenced_at 为 NULL 但被照片行引用的异常数据，也跳过不删、不报 FK 错
    await ctx.db.query(`UPDATE uploads SET referenced_at = NULL, created_at = now() - interval '2 days' WHERE id = $1`, [up]);
    const { runUploadsSweep } = await import('../src/queue/cron.js');
    const swept = await runUploadsSweep(ctx.db, { storage, batchSize: 10 });
    assert.equal((await ctx.db.query(`SELECT count(*)::int AS n FROM uploads WHERE id = $1`, [up])).rows[0].n, 1, '被照片行引用的上传跳过不删');
    assert.ok(!storage.removed.includes(up), '对应对象不被删除');
  });

  test('submitting 崩溃恢复（§6 审查 3）：重试不重提、停滞转 unknown 保持冻结', async () => {
    const spy = mockImageProvider();
    await ctx.db.query(`UPDATE wallets SET available_fen = 500, frozen_fen = 0 WHERE user_id = $1`, [A.userId]);
    const up = (await (await multipart(base, '/uploads/image', A, 'crash.png', TINY_PNG)).json()).uploadId;
    const chr = await (await post(base, '/characters', { name: '崩溃测试', photoUploadIds: [up] }, { cookie: A.cookie, csrf: A.csrf })).json();
    const quote = await (await post(base, '/quotes', { kind: 'look_regenerate', characterId: chr.id, styleId: 'realistic' }, { cookie: A.cookie, csrf: A.csrf })).json();
    const version = await (await post(base, `/characters/${chr.id}/looks/realistic/versions`, { quoteId: quote.quoteId, idempotencyKey: 'look-crash-001' }, { cookie: A.cookie, csrf: A.csrf })).json();
    const taskKey = `look.create:${A.userId}:look-crash-001`;

    // 模拟进程在上游已接受请求后崩溃：gen_task 停在 submitting、刚刚更新
    await ctx.db.query(`UPDATE gen_tasks SET status = 'submitting', updated_at = now() WHERE idempotency_key = $1`, [taskKey]);
    const handlers = buildHandlers({ config: loadConfig({ NODE_ENV: 'test' }), db: ctx.db, logger: silentLogger, storage, imageProvider: spy });
    const worker = createWorker({ db: ctx.db, logger: silentLogger, handlers, workerId: 'worker-crash', concurrency: 1 });

    // 第一次重领取：submitting 且新鲜 → 抛可重试错误，job 重新排队，provider 不被调用
    assert.equal(await worker.runOne(), true);
    let job = (await ctx.db.query(`SELECT status FROM jobs WHERE dedupe_key = $1`, [`look:${version.id}`])).rows[0];
    assert.equal(job.status, 'queued', '抛可重试错误后 job 重新排队');
    assert.equal(spy.calls.length, 0, 'submitting 期间绝不重提');
    assert.equal((await ctx.db.query(`SELECT status FROM gen_tasks WHERE idempotency_key = $1`, [taskKey])).rows[0].status, 'submitting');

    // 停滞超过阈值：转 unknown、保持冻结、结束
    await ctx.db.query(`UPDATE jobs SET run_at = now() WHERE dedupe_key = $1`, [`look:${version.id}`]);
    await ctx.db.query(`UPDATE gen_tasks SET updated_at = now() - interval '11 minutes' WHERE idempotency_key = $1`, [taskKey]);
    assert.equal(await worker.runOne(), true);
    assert.equal((await ctx.db.query(`SELECT status FROM gen_tasks WHERE idempotency_key = $1`, [taskKey])).rows[0].status, 'unknown');
    assert.equal((await ctx.db.query(`SELECT status FROM look_versions WHERE id = $1`, [version.id])).rows[0].status, 'pending', '版本保持 pending');
    const wallet = (await ctx.db.query(`SELECT available_fen, frozen_fen FROM wallets WHERE user_id = $1`, [A.userId])).rows[0];
    assert.deepEqual(wallet, { available_fen: 450, frozen_fen: 50 }, '金额保持冻结，等 M2 对账');
    assert.equal(spy.calls.length, 0, '全程未调用 provider');
    job = (await ctx.db.query(`SELECT status FROM jobs WHERE dedupe_key = $1`, [`look:${version.id}`])).rows[0];
    assert.equal(job.status, 'done', '任务正常完成，不自动重提');
  });

  test('provider 输入（§6 审查 4）：携带照片 key、描述与风格提示词', async () => {
    await ctx.db.query(`UPDATE wallets SET available_fen = 200, frozen_fen = 0 WHERE user_id = $1`, [A.userId]);
    const up = (await (await multipart(base, '/uploads/image', A, 'input.png', TINY_PNG)).json()).uploadId;
    const chr = await (await post(base, '/characters', { name: '输入检查', photoUploadIds: [up], description: '5 岁小女孩' }, { cookie: A.cookie, csrf: A.csrf })).json();
    const quote = await (await post(base, '/quotes', { kind: 'look_regenerate', characterId: chr.id, styleId: 'picture_book' }, { cookie: A.cookie, csrf: A.csrf })).json();
    await post(base, `/characters/${chr.id}/looks/picture_book/versions`, { quoteId: quote.quoteId, idempotencyKey: 'look-input-001' }, { cookie: A.cookie, csrf: A.csrf });
    const local = mockImageProvider();
    const handlers = buildHandlers({ config: loadConfig({ NODE_ENV: 'test' }), db: ctx.db, logger: silentLogger, storage, imageProvider: local });
    await createWorker({ db: ctx.db, logger: silentLogger, handlers, workerId: 'worker-input', concurrency: 1 }).runOne();
    assert.equal(local.calls.length, 1);
    assert.deepEqual(local.calls[0].referenceKeys, [`users/${A.userId}/uploads/${up}`]);
    assert.equal(local.calls[0].description, '5 岁小女孩');
    assert.equal(local.calls[0].promptHint, 'children picture book, watercolor texture, gentle palette');
    const task = (await ctx.db.query(`SELECT provider FROM gen_tasks WHERE idempotency_key LIKE '%look-input-001'`)).rows[0];
    assert.equal(task.provider, 'mock-image', 'provider 记录真实注入实现的 id');
  });

  test('生产配置：未注入 storage 或 imageProvider 时启动报错', () => {
    const prodConfig = loadConfig({ NODE_ENV: 'production', DATABASE_URL: 'postgres://x/y', ALLOWED_ORIGINS: 'https://miv.example', SMS_PROVIDER: 'real' });
    assert.throws(() => buildHandlers({ config: prodConfig, db: ctx.db, logger: silentLogger }), /对象存储/);
    assert.throws(() => buildHandlers({ config: prodConfig, db: ctx.db, logger: silentLogger, storage: {} }), /图片模型/);
    assert.throws(() => createApp({ config: prodConfig, db: ctx.db, logger: silentLogger }), /对象存储/);
  });
});
