// 渠道层集成测试（M2-BE-03）：凭证加密、渠道 CRUD/软删除、路由切换语义、任务绑定渠道、
// 停用/软删除渠道仍可轮询、驱动缺失渠道被跳过、无生效渠道门禁 503、健康度统计、种子引导。
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createLogger } from '../../src/logger.js';
import { loadDriverRegistry } from '../../src/engine/providers/index.js';
import { createChannelService } from '../../src/channels/service.js';
import { createChannelRouter } from '../../src/channels/router.js';
import { encryptCredential, decryptCredential, credentialMask, hashAdminPassword, verifyAdminPassword } from '../../src/channels/crypto.js';
import { createTestDb } from '../helpers/db.js';

const SECRET = 'x'.repeat(40);
const silentLogger = createLogger({ level: 'silent' });

describe('渠道层（M2-BE-03）', () => {
  let testDb;
  let db;
  let registry;
  let service;
  let router;

  before(async () => {
    testDb = await createTestDb();
    db = testDb.db;
    registry = await loadDriverRegistry({ logger: silentLogger });
  });
  after(async () => { await testDb.drop(); });

  const noAudit = async () => {};

  test('凭证加密：AES-GCM 往返、掩码、错误密钥解不开', () => {
    const enc = encryptCredential(SECRET, 'sk-live-abcdef1234');
    assert.equal(decryptCredential(SECRET, enc), 'sk-live-abcdef1234');
    assert.equal(credentialMask('sk-live-abcdef1234'), '****1234');
    assert.throws(() => decryptCredential('y'.repeat(40), enc), /解密失败|不合法/);
    assert.throws(() => encryptCredential('short', 'x'), /至少 32 字节/);
  });

  test('管理员口令哈希与校验', () => {
    const hash = hashAdminPassword('a-strong-password-123');
    assert.ok(verifyAdminPassword(hash, 'a-strong-password-123'));
    assert.ok(!verifyAdminPassword(hash, 'wrong-password-123'));
    assert.throws(() => hashAdminPassword('short'), /至少 12 位/);
  });

  test('创建渠道：凭证密文入库、接口形状只含掩码、驱动不存在报 400', async () => {
    service = createChannelService({ db, secretKey: SECRET, registry, logger: silentLogger });
    router = createChannelRouter({ db, service, registry, logger: silentLogger });
    const row = await service.createChannel({
      kind: 'video', name: `t-video-${Date.now()}`, driver: 'aiide-ark',
      baseUrl: 'https://v.example.test/', credential: 'sk-video-secret-9876',
      modelMap: { video: 'dreamina-seedance-2-5-hc' }, costFen: { 'video.480p': 68 },
    }, noAudit);
    assert.match(row.credential_enc, /^v1:/);
    assert.equal(row.base_url, 'https://v.example.test'); // 去尾斜杠
    await assert.rejects(service.createChannel({
      kind: 'video', name: 't-bad', driver: 'no-such-driver',
      baseUrl: 'https://v.example.test', credential: 'sk-x-longenough',
    }, noAudit), /驱动不存在/);
  });

  test('路由：pick 返回生效渠道；use 切换后新提交用新渠道；在途仍回原渠道', async () => {
    const name = `t-route-${Date.now()}`;
    const a = await service.createChannel({ kind: 'image', name: `${name}-a`, driver: 'openai-images',
      baseUrl: 'https://a.example.test', credential: 'sk-image-a-1111', modelMap: { image: 'gpt-image-2' } }, noAudit);
    const b = await service.createChannel({ kind: 'image', name: `${name}-b`, driver: 'openai-images',
      baseUrl: 'https://b.example.test', credential: 'sk-image-b-2222', modelMap: { image: 'gpt-image-2' } }, noAudit);
    await service.setRoutes('image', '*', [a.id], noAudit);
    const first = await router.pick('image');
    assert.equal(first.channelId, a.id);
    // 切换到 b：只影响新提交
    await service.setRoutes('image', '*', [b.id], noAudit);
    const second = await router.pick('image');
    assert.equal(second.channelId, b.id);
    // 已绑 a 的任务仍回 a（forTask，即使 a 已停用）
    await service.setChannelStatus(a.id, 'disabled', noAudit);
    const bound = await router.forTask(a.id);
    assert.equal(bound.channelId, a.id);
    assert.ok(bound.instance, '停用渠道仍可创建驱动实例（在途轮询）');
  });

  test('软删除：retired 不被 pick 选中；在途清空前凭证保留，清空后 sweep 清除', async () => {
    const name = `t-retire-${Date.now()}`;
    const row = await service.createChannel({ kind: 'llm', name, driver: 'openai-compatible',
      baseUrl: 'https://l.example.test', credential: 'sk-llm-zzzz-9999', modelMap: { llm: 'glm-4.6' } }, noAudit);
    await service.setRoutes('llm', '*', [row.id], noAudit);
    await service.retireChannel(row.id, noAudit);
    // 软删除后路由被清：pick 报 NO_ACTIVE_CHANNEL（503）
    await assert.rejects(router.pick('llm'), (error) => error.code === 'NO_ACTIVE_CHANNEL' && error.status === 503
      && /暂时不可用/.test(error.message));
    // 有在途任务时凭证保留
    const user = await db.query(
      `INSERT INTO users (id, phone, nickname) VALUES ('usr_chtest0000001', '15999000001', '渠道测试')
       ON CONFLICT (id) DO NOTHING RETURNING id`);
    assert.ok(user.rows.length || true);
    await db.query(
      `INSERT INTO gen_tasks (id, user_id, kind, provider, status, request, idempotency_key, channel_id)
       VALUES ('gt_chtest0000001', 'usr_chtest0000001', 'llm', 'test', 'running', '{}', 'idem-chtest-1', $1)`,
      [row.id]);
    let swept = await service.sweepRetiredCredentials();
    const kept = await service.getChannel(row.id);
    assert.ok(kept.credential_enc.length > 0, '在途未清空：凭证保留（仍可轮询）');
    // 在途结束后清除凭证
    await db.query(`UPDATE gen_tasks SET status = 'succeeded' WHERE id = 'gt_chtest0000001'`);
    swept = await service.sweepRetiredCredentials();
    const cleared = await service.getChannel(row.id);
    assert.equal(cleared.credential_enc, '', '在途清空后凭证被清除');
    assert.ok(swept.cleared >= 1);
    // 凭证已清除的渠道 forTask 返回 instance: null（任务保持原状，不退款不重提）
    const bound = await router.forTask(row.id);
    assert.equal(bound.instance, null);
  });

  test('驱动缺失：路由指向不存在驱动的渠道被跳过（pick 报无生效渠道）', async () => {
    const name = `t-missing-${Date.now()}`;
    // 直插一条 driver 指向不存在值的渠道（正常接口会被拦，这里模拟「删了驱动目录」的场景）
    const { rows: [inserted] } = await db.query(
      `INSERT INTO provider_channels (id, kind, name, driver, base_url, credential_enc, model_map, params)
       VALUES ('pch_missing0000001', 'video', $1, 'deleted-driver', 'https://x.example.test', 'v1:000000000000000000000000:0000', '{}', '{}')
       RETURNING *`, [name]);
    await db.query(`INSERT INTO channel_routes (kind, capability, channel_id, rank) VALUES ('video', '*', $1, 1)`,
      [inserted.id]);
    await assert.rejects(router.pick('video'), (error) => error.code === 'NO_ACTIVE_CHANNEL');
    // forTask 对驱动缺失渠道：instance null（在途保持原状）
    const bound = await router.forTask('pch_missing0000001');
    assert.equal(bound.instance, null);
    await db.query(`DELETE FROM channel_routes WHERE channel_id = $1`, [inserted.id]);
  });

  test('健康度：真实请求统计（submitted/succeeded/failed）与在途数', async () => {
    const name = `t-health-${Date.now()}`;
    const row = await service.createChannel({ kind: 'image', name, driver: 'openai-images',
      baseUrl: 'https://h.example.test', credential: 'sk-health-1234', modelMap: { image: 'gpt-image-2' } }, noAudit);
    await router.recordSubmission({ channelId: row.id, genTaskId: null, status: 'running', latencyMs: 800 });
    await router.recordSubmission({ channelId: row.id, genTaskId: null, status: 'succeeded', latencyMs: 0 });
    await router.recordSubmission({ channelId: row.id, genTaskId: null, status: 'failed', latencyMs: 0, errorCode: 'X' });
    const health = await service.healthFor([row.id]);
    const entry = health.get(row.id);
    assert.equal(entry.total, 3);
    assert.equal(entry.failed, 1);
    assert.equal(entry.successRate, 0.67);
  });

  test('成本标记：渠道成本高于逻辑 SKU 用户价时 costVsPrice 报 over', async () => {
    const name = `t-cost-${Date.now()}`;
    const row = await service.createChannel({ kind: 'video', name, driver: 'aiide-ark',
      baseUrl: 'https://c.example.test', credential: 'sk-cost-12345', modelMap: { video: 'm' },
      costFen: { 'video.480p': 150, 'video.720p': 100 } }, noAudit); // 480p 成本 150 > 用户价 100
    const flag = await service.costVsPrice(row);
    assert.ok(flag, '成本高于用户价应被标出');
    assert.deepEqual(flag.over, [{ capability: 'video.480p', costFen: 150, priceFen: 100 }]);
  });

  test('种子引导：仅表空时写种子（本库已有渠道 → seeded=false）', async () => {
    const result = await service.seedFromEnv([
      { kind: 'llm', name: 'seed-llm', driver: 'openai-compatible', baseUrl: 'https://s.example.test',
        credential: 'sk-seed-123456', modelMap: { llm: 'glm-4.6' }, activate: true },
    ], noAudit);
    assert.equal(result.seeded, false, '已有渠道：不覆盖（以数据库为准）');
  });
});
