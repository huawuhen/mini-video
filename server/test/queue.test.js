import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { silentLogger } from '../src/logger.js';
import { claim, complete, enqueue, extendLease, fail, PermanentJobError } from '../src/queue/index.js';
import { createWorker } from '../src/worker.js';
import { createTestDb } from './helpers/db.js';

describe('queue', () => {
  let ctx;
  let db;
  before(async () => { ctx = await createTestDb(); db = ctx.db; });
  after(async () => { await ctx.drop(); });
  beforeEach(async () => { await db.query('DELETE FROM jobs'); });

  const opts = (workerId) => ({ workerId, types: ['t.a', 't.b'], leaseSeconds: 60 });

  test('去重键相同只入队一次', async () => {
    const first = await enqueue(db, { type: 't.a', dedupeKey: 'k1' });
    const second = await enqueue(db, { type: 't.a', dedupeKey: 'k1' });
    assert.ok(first);
    assert.equal(second, null);
  });

  test('在事务中入队，事务回滚则 job 不存在', async () => {
    await assert.rejects(db.tx(async (t) => {
      await enqueue(t, { type: 't.a' });
      throw new Error('rollback');
    }));
    const { rows } = await db.query('SELECT count(*)::int AS n FROM jobs');
    assert.equal(rows[0].n, 0);
  });

  test('并发领取不会重复', async () => {
    for (let i = 0; i < 20; i++) await enqueue(db, { type: 't.a', payload: { i } });
    const claimed = await Promise.all(Array.from({ length: 30 }, (_, i) => claim(db, opts(`w${i % 4}`))));
    const ids = claimed.filter(Boolean).map((j) => j.id);
    assert.equal(ids.length, 20);
    assert.equal(new Set(ids).size, 20);
  });

  test('只领取已注册类型、已到期的 job', async () => {
    await enqueue(db, { type: 't.other' });
    await enqueue(db, { type: 't.a', delaySeconds: 3600 });
    assert.equal(await claim(db, opts('w1')), null);
  });

  test('租约过期后可被其他 Worker 重新领取，旧 Worker 无法再完成', async () => {
    await enqueue(db, { type: 't.a' });
    const job = await claim(db, opts('w1'));
    await db.query(`UPDATE jobs SET locked_until = now() - interval '1 second' WHERE id = $1`, [job.id]);
    const again = await claim(db, opts('w2'));
    assert.equal(again.id, job.id);
    assert.equal(again.attempts, 2);
    assert.equal(await complete(db, job, 'w1'), false);
    assert.equal(await extendLease(db, job, 'w1', 60), false);
    assert.equal(await complete(db, again, 'w2'), true);
  });

  test('失败按退避重新排队，达到最大次数后标记失败', async () => {
    await enqueue(db, { type: 't.a', maxAttempts: 2 });
    let job = await claim(db, opts('w1'));
    assert.deepEqual(await fail(db, job, 'w1', new Error('e1')), { updated: true, retry: true });
    let row = (await db.query('SELECT status, run_at > now() AS later FROM jobs WHERE id = $1', [job.id])).rows[0];
    assert.equal(row.status, 'queued');
    assert.equal(row.later, true);
    await db.query('UPDATE jobs SET run_at = now() WHERE id = $1', [job.id]);
    job = await claim(db, opts('w1'));
    assert.deepEqual(await fail(db, job, 'w1', new Error('e2')), { updated: true, retry: false });
    row = (await db.query('SELECT status, last_error FROM jobs WHERE id = $1', [job.id])).rows[0];
    assert.equal(row.status, 'failed');
    assert.match(row.last_error, /e2/);
  });

  test('PermanentJobError 不重试', async () => {
    await enqueue(db, { type: 't.a' });
    const job = await claim(db, opts('w1'));
    assert.equal((await fail(db, job, 'w1', new PermanentJobError('bad'))).retry, false);
  });

  test('租约过期且超过最大次数的 job 被标记失败而不是再次执行', async () => {
    await enqueue(db, { type: 't.a', maxAttempts: 1 });
    const job = await claim(db, opts('w1'));
    await db.query(`UPDATE jobs SET locked_until = now() - interval '1 second' WHERE id = $1`, [job.id]);
    assert.equal(await claim(db, opts('w2')), null);
    const { rows } = await db.query('SELECT status FROM jobs WHERE id = $1', [job.id]);
    assert.equal(rows[0].status, 'failed');
  });

  test('Worker 执行处理器：成功完成、未注册类型不会被领取', async () => {
    const seen = [];
    const worker = createWorker({
      db, logger: silentLogger, workerId: 'wt',
      handlers: { 't.a': async (payload) => { seen.push(payload.n); } },
    });
    await enqueue(db, { type: 't.a', payload: { n: 1 } });
    await enqueue(db, { type: 't.b', payload: { n: 2 } });
    assert.equal(await worker.runOne(), true);
    assert.equal(await worker.runOne(), false);
    assert.deepEqual(seen, [1]);
    const { rows } = await db.query(`SELECT type, status FROM jobs ORDER BY id`);
    assert.deepEqual(rows, [{ type: 't.a', status: 'done' }, { type: 't.b', status: 'queued' }]);
  });

  test('Worker 处理器抛错时 job 重新排队并记录错误', async () => {
    const worker = createWorker({
      db, logger: silentLogger, workerId: 'wt',
      handlers: { 't.a': async () => { throw new Error('upstream 503'); } },
    });
    await enqueue(db, { type: 't.a' });
    await worker.runOne();
    const { rows } = await db.query('SELECT status, attempts, last_error FROM jobs');
    assert.equal(rows[0].status, 'queued');
    assert.equal(rows[0].attempts, 1);
    assert.match(rows[0].last_error, /upstream 503/);
  });
});
