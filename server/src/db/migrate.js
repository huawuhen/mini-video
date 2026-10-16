// 迁移执行器：按文件名顺序执行 migrations/NNN-*.sql，每个文件一个事务。
// 已执行的文件记录校验和，被改动时拒绝启动（已发布的迁移不再修改，改结构就新增文件）。
// 用咨询锁保证多个进程同时启动时只有一个在执行。
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));
const LOCK_KEY = 7_204_311_001; // 任意固定值，仅本项目使用
const FILE_PATTERN = /^\d{3}-[a-z0-9-]+\.sql$/;

export async function migrate(db, { dir = MIGRATIONS_DIR, logger } = {}) {
  const files = (await readdir(dir)).filter((f) => FILE_PATTERN.test(f)).sort();
  const client = await db.pool.connect();
  const applied = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    const { rows } = await client.query('SELECT version, checksum FROM schema_migrations');
    const done = new Map(rows.map((r) => [r.version, r.checksum]));
    for (const file of files) {
      const sql = await readFile(path.join(dir, file), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      if (done.has(file)) {
        if (done.get(file) !== checksum) throw new Error(`迁移文件 ${file} 在执行后被修改，请改为新增迁移文件`);
        continue;
      }
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)', [file, checksum]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        err.message = `迁移 ${file} 失败：${err.message}`;
        throw err;
      }
      applied.push(file);
      logger?.info('migration_applied', { file });
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
    client.release();
  }
  return applied;
}

// 命令行：npm run migrate -w server
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { loadConfig } = await import('../config.js');
  const { createDb } = await import('./pool.js');
  const { createLogger } = await import('../logger.js');
  const config = loadConfig();
  const logger = createLogger({ level: config.logLevel });
  const db = createDb({ url: config.databaseUrl, max: 1, logger });
  try {
    const applied = await migrate(db, { logger });
    logger.info('migrate_done', { applied: applied.length });
  } finally {
    await db.close();
  }
}
