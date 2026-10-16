import assert from 'node:assert/strict';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { MIGRATIONS_DIR, migrate } from '../src/db/migrate.js';
import { newId } from '../src/db/ids.js';
import { createTestDb } from './helpers/db.js';

describe('db', () => {
  let ctx;
  before(async () => { ctx = await createTestDb(); });
  after(async () => { await ctx.drop(); });

  test('迁移可重复执行，第二次不再应用任何文件', async () => {
    assert.deepEqual(await migrate(ctx.db), []);
    const { rows } = await ctx.db.query('SELECT version FROM schema_migrations');
    assert.ok(rows.some((r) => r.version === '001-init.sql'));
  });

  test('已执行的迁移文件被修改时拒绝执行', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'miv-mig-'));
    try {
      await cp(MIGRATIONS_DIR, dir, { recursive: true });
      await writeFile(path.join(dir, '001-init.sql'), '-- tampered\nSELECT 1;');
      await assert.rejects(migrate(ctx.db, { dir }), /被修改/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('事务提交与回滚', async () => {
    const id = newId('usr');
    await ctx.db.tx(async (t) => {
      await t.query(`INSERT INTO users (id, phone, nickname) VALUES ($1, $2, '甲')`, [id, '13800000001']);
    });
    await assert.rejects(ctx.db.tx(async (t) => {
      await t.query(`UPDATE users SET nickname = '乙' WHERE id = $1`, [id]);
      throw new Error('boom');
    }), /boom/);
    const { rows } = await ctx.db.query('SELECT nickname FROM users WHERE id = $1', [id]);
    assert.equal(rows[0].nickname, '甲');
  });

  test('嵌套事务失败只回滚到 SAVEPOINT', async () => {
    const id = newId('usr');
    await ctx.db.tx(async (t) => {
      await t.query(`INSERT INTO users (id, phone, nickname) VALUES ($1, $2, '外层')`, [id, '13800000002']);
      await assert.rejects(t.tx(async (inner) => {
        await inner.query(`UPDATE users SET nickname = '内层' WHERE id = $1`, [id]);
        throw new Error('inner');
      }));
    });
    const { rows } = await ctx.db.query('SELECT nickname FROM users WHERE id = $1', [id]);
    assert.equal(rows[0].nickname, '外层');
  });

  test('bigint 金额以 Number 返回；余额不能为负', async () => {
    const id = newId('usr');
    await ctx.db.query(`INSERT INTO users (id, phone, nickname) VALUES ($1, $2, '丙')`, [id, '13800000003']);
    await ctx.db.query('INSERT INTO wallets (user_id, available_fen) VALUES ($1, 5000)', [id]);
    const { rows } = await ctx.db.query('SELECT available_fen FROM wallets WHERE user_id = $1', [id]);
    assert.equal(rows[0].available_fen, 5000);
    await assert.rejects(ctx.db.query('UPDATE wallets SET available_fen = available_fen - 6000 WHERE user_id = $1', [id]), /check/i);
  });

  test('种子数据：6 种风格、2 个档位、14 个音色、最长 90 秒', async () => {
    const count = async (table) => (await ctx.db.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;
    assert.equal(await count('styles'), 6);
    assert.equal(await count('quality_tiers'), 2);
    assert.equal(await count('voices'), 14);
    const { rows } = await ctx.db.query(`SELECT value FROM settings WHERE key = 'max_duration_seconds'`);
    assert.equal(rows[0].value, 90);
  });

  test('同一作品内两个角色不能用同一音色（唯一索引）', async () => {
    const userId = newId('usr');
    const projectId = newId('prj');
    await ctx.db.query(`INSERT INTO users (id, phone, nickname) VALUES ($1, '13800000004', '丁')`, [userId]);
    await ctx.db.query(
      `INSERT INTO projects (id, user_id, story_text, source_type, style_id, quality_tier_id, tier_mapping_id, status)
       VALUES ($1, $2, '故事', 'text', 'cartoon_3d', 'standard', 'tm_standard00000001', 'cast_review')`,
      [projectId, userId],
    );
    const insertCast = (idx) => ctx.db.query(
      `INSERT INTO project_cast (id, project_id, idx, name, match_source, voice_id) VALUES ($1, $2, $3, '角色', 'ai', 'vc_girl_gentle')`,
      [newId('cast'), projectId, idx],
    );
    await insertCast(0);
    await assert.rejects(insertCast(1), /project_cast_voice_uniq/);
  });
});

test('newId：前缀登记、长度固定、只含小写字母和数字', () => {
  const ids = new Set(Array.from({ length: 2000 }, () => newId('prj')));
  assert.equal(ids.size, 2000);
  for (const id of ids) assert.match(id, /^prj_[0-9a-z]{16}$/);
  assert.throws(() => newId('xyz'), /未登记/);
});
