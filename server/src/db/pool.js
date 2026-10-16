// PostgreSQL 访问层：连接池 + 事务（嵌套事务用 SAVEPOINT）。
// 约定（AGENTS.md §5）：只写参数化 SQL；事务短小，事务内禁止等待上游网络调用。
import pg from 'pg';

// int8（bigint，金额与 bigserial）默认按字符串返回；金额以分为单位远小于 2^53，安全转成 Number。
pg.types.setTypeParser(20, (value) => {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new Error(`bigint 超出安全整数范围：${value}`);
  return n;
});

let savepointSeq = 0;

function wrapClient(client, depth) {
  const scope = {
    query: (text, params) => client.query(text, params),
    /** 嵌套事务：内层失败只回滚到自己的 SAVEPOINT，异常继续向外抛。 */
    tx: async (fn) => {
      const name = `sp_${depth}_${++savepointSeq}`;
      await client.query(`SAVEPOINT ${name}`);
      try {
        const result = await fn(wrapClient(client, depth + 1));
        await client.query(`RELEASE SAVEPOINT ${name}`);
        return result;
      } catch (err) {
        await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
        throw err;
      }
    },
    inTransaction: true,
  };
  return scope;
}

/**
 * @returns {{ pool: pg.Pool, query: Function, tx: Function, close: Function }}
 * db.query(text, params)              单条语句（自动提交）
 * db.tx(async (t) => { t.query(); t.tx(...) })  事务；t.tx 为嵌套 SAVEPOINT
 */
export function createDb({ url, max = 10, logger } = {}) {
  const pool = new pg.Pool({ connectionString: url, max, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000 });
  pool.on('error', (err) => logger?.error('pg_pool_error', { err }));

  async function tx(fn, { isolation } = {}) {
    const client = await pool.connect();
    try {
      await client.query(isolation ? `BEGIN ISOLATION LEVEL ${isolation}` : 'BEGIN');
      const result = await fn(wrapClient(client, 1));
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  return {
    pool,
    query: (text, params) => pool.query(text, params),
    tx,
    inTransaction: false,
    close: () => pool.end(),
  };
}
