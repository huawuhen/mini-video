// seedMockChannels（M2-WEB-01 零费用联调）测试：写入并激活 local-mock 三渠道、幂等、
// 与真实渠道共存（路由切换语义）、生产环境拒绝。
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createLogger } from '../../src/logger.js';
import { loadDriverRegistry } from '../../src/engine/providers/index.js';
import { createChannelService } from '../../src/channels/service.js';
import { seedMockChannels } from '../../src/worker.js';
import { createTestDb } from '../helpers/db.js';

const SECRET = 'x'.repeat(40);
const silentLogger = createLogger({ level: 'silent' });

describe('seedMockChannels（M2-WEB-01 local-mock 联调渠道）', () => {
  let testDb;
  let db;
  let service;

  before(async () => {
    testDb = await createTestDb();
    db = testDb.db;
    const registry = await loadDriverRegistry({ logger: silentLogger });
    service = createChannelService({ db, secretKey: SECRET, registry, logger: silentLogger });
  });
  after(async () => { if (testDb) await testDb.drop(); });

  test('生产环境拒绝写入', async () => {
    await assert.rejects(seedMockChannels({ config: { production: true }, db, service, logger: silentLogger }),
      /生产环境禁止写入 local-mock/);
  });

  test('写入并激活三条 local-mock 渠道；幂等；与真实渠道共存且路由切换语义正确', async () => {
    // 先放一条「真实」渠道并激活（模拟既有 aiide 路由）
    const real = await service.createChannel({ kind: 'video', name: 'real-test', driver: 'aiide-ark',
      baseUrl: 'https://real.example.test', credential: 'sk-real-000000000', modelMap: { video: 'm' } },
      async () => {});
    await service.setChannelStatus(real.id, 'active', async () => {});
    await service.setRoutes('video', '*', [real.id], async () => {});
    assert.equal((await service.getRoutes('video'))[0].name, 'real-test');

    // seed --mock：写入 + 激活（真实渠道让位）
    const first = await seedMockChannels({ config: { production: false }, db, service, logger: silentLogger });
    assert.equal(first.channels.length, 3);
    const routes = await service.getRoutes('video');
    assert.equal(routes[0].name, 'local-mock');
    assert.equal(routes[0].driver, 'local-mock');
    const image = await service.getChannelByName('image', 'local-mock');
    const llm = await service.getChannelByName('llm', 'local-mock');
    assert.ok(image && llm, 'image/llm 也写入');

    // 幂等：再次 seed 不报错、不重复建渠道
    await seedMockChannels({ config: { production: false }, db, service, logger: silentLogger });
    const { rows } = await db.query(`SELECT count(*)::int AS n FROM provider_channels WHERE name = 'local-mock'`);
    assert.equal(rows[0].n, 3);

    // 切回真实渠道（channel:use 语义）后，再 seed --mock 又能把路由拉回 local-mock
    await service.setRoutes('video', '*', [real.id], async () => {});
    assert.equal((await service.getRoutes('video'))[0].name, 'real-test');
    await seedMockChannels({ config: { production: false }, db, service, logger: silentLogger });
    assert.equal((await service.getRoutes('video'))[0].name, 'local-mock');
  });
});
