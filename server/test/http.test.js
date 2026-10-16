import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createLogger, silentLogger } from '../src/logger.js';
import { createTestDb } from './helpers/db.js';

describe('http', () => {
  let ctx;
  let server;
  let base;
  before(async () => {
    ctx = await createTestDb();
    const app = createApp({ config: loadConfig({ NODE_ENV: 'test' }), db: ctx.db, logger: silentLogger, urlFor: (key) => `https://cdn.test/${key}?e=1&token=x` });
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}/api/v1`;
  });
  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await ctx.drop();
  });

  test('健康检查', async () => {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    assert.match(res.headers.get('x-request-id'), /^req_/);
  });

  test('GET /catalog 符合 API.md §2', async () => {
    const res = await fetch(`${base}/catalog`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.styles.length, 6);
    assert.deepEqual(body.styles[0], { id: 'realistic', name: '真人写实', description: '接近真实拍摄的家庭影像' });
    assert.deepEqual(body.qualityTiers.map((t) => [t.id, t.pricePer30sFen]), [['standard', 600], ['hd', 1200]]);
    assert.deepEqual(body.ratios, ['9:16', '16:9', '1:1']);
    assert.equal(body.limits.maxDurationSeconds, 90);
    assert.equal(body.limits.retentionDays, 90);
    assert.equal(body.limits.dailyFreeUnderstanding, 20);
    for (const tier of body.qualityTiers) assert.ok(!('model' in tier) && !('skuCode' in tier), '不暴露模型');
  });

  test('档位映射的 SKU 下架后，该档位不再展示', async () => {
    await ctx.db.query(`UPDATE skus SET status = 'inactive' WHERE sku_code = 'video.mock.1080p'`);
    try {
      const body = await (await fetch(`${base}/catalog`)).json();
      assert.deepEqual(body.qualityTiers.map((t) => t.id), ['standard']);
    } finally {
      await ctx.db.query(`UPDATE skus SET status = 'active' WHERE sku_code = 'video.mock.1080p'`);
    }
  });

  test('GET /voices 全量与分类筛选；有素材时返回试听链接', async () => {
    const all = await (await fetch(`${base}/voices`)).json();
    assert.equal(all.items.length, 14);
    assert.equal(all.items[0].categoryName, '少女');
    assert.ok(!('sampleUrl' in all.items[0]), '未上传素材时不返回 sampleUrl');
    await ctx.db.query(`UPDATE voices SET sample_key = 'voices/girl.mp3' WHERE id = 'vc_girl_gentle'`);
    const girls = await (await fetch(`${base}/voices?category=girl`)).json();
    assert.deepEqual(girls.items.map((v) => v.id), ['vc_girl_gentle', 'vc_girl_lively']);
    assert.match(girls.items[0].sampleUrl, /^https:\/\/cdn\.test\/voices\/girl\.mp3/);
  });

  test('参数错误返回统一错误格式', async () => {
    const res = await fetch(`${base}/voices?category=robot`);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.code, 'VALIDATION_FAILED');
    assert.equal(typeof body.message, 'string');
    assert.match(body.requestId, /^req_/);
    assert.ok(body.details.fields.category);
  });

  test('未知接口 404、坏 JSON 400，均为 JSON 错误体', async () => {
    const missing = await fetch(`${base}/nope`);
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).code, 'NOT_FOUND');
    const bad = await fetch(`${base}/health`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{oops' });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).code, 'VALIDATION_FAILED');
  });
});

test('日志脱敏：手机号、密钥字段、签名参数', () => {
  const lines = [];
  const logger = createLogger({ level: 'debug', write: (l) => lines.push(JSON.parse(l)) });
  logger.info('x', { phone: '13812345678', note: '用户 13812345678 登录', code: '123456', url: 'https://cdn/a.mp4?e=1&token=abc', nested: { csrfToken: 't' } });
  const [line] = lines;
  assert.equal(line.phone, '138****5678');
  assert.equal(line.note, '用户 138****5678 登录');
  assert.equal(line.code, '***');
  assert.equal(line.url, 'https://cdn/a.mp4?e=***&token=***');
  assert.equal(line.nested.csrfToken, '***');
});

test('生产环境缺少关键配置时拒绝启动', () => {
  assert.throws(() => loadConfig({ NODE_ENV: 'production' }), /DATABASE_URL/);
  assert.throws(() => loadConfig({ NODE_ENV: 'production', DATABASE_URL: 'postgres://x' }), /ALLOWED_ORIGINS/);
});
