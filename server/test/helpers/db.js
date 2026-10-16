// 测试数据库：每个测试文件建一个独立的临时库并执行全部迁移，结束时删除。
// 依赖 `npm run test:db:up`（Compose 项目 miv-test，127.0.0.1:56432）。禁止指向任何非测试库。
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { createDb } from '../../src/db/pool.js';
import { migrate } from '../../src/db/migrate.js';

const ADMIN_URL = process.env.TEST_DATABASE_URL || 'postgres://miv:miv_test_only@127.0.0.1:56432/miv';

if (!/127\.0\.0\.1:56432|localhost:56432/.test(ADMIN_URL)) {
  throw new Error('测试只能连接隔离测试库（127.0.0.1:56432），请检查 TEST_DATABASE_URL');
}

export async function createTestDb({ runMigrations = true } = {}) {
  const name = `miv_t_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }
  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  const db = createDb({ url: url.toString(), max: 5 });
  if (runMigrations) await migrate(db);
  return {
    db,
    url: url.toString(),
    async drop() {
      await db.close();
      const client = new pg.Client({ connectionString: ADMIN_URL });
      await client.connect();
      try {
        await client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await client.end();
      }
    },
  };
}
