// PG 固定窗口限流（AGENTS.md §1：M1~M2 不引入 Redis，限流放 rate_counters 表）。
import { appError } from '../http/errors.js';

/**
 * 命中一次计数，超过 max 抛 429；返回 { count, retryAfterSeconds }。
 * key 约定 `<业务>:<对象>`，如 sms:daily:13800001234、login:phone:13800001234。
 * 同 key 同窗口一行，并发下由主键冲突 + 自增保证原子；窗口起点对齐整窗（天窗口按 UTC 对齐，作防滥用上限足够）。
 */
export async function hitRateLimit(db, { key, windowSeconds, max, code = 'RATE_LIMITED', message }) {
  const now = Date.now();
  const windowStart = new Date(Math.floor(now / (windowSeconds * 1000)) * windowSeconds * 1000);
  const { rows } = await db.query(
    `INSERT INTO rate_counters (key, window_start, count)
     VALUES ($1, $2, 1)
     ON CONFLICT (key, window_start) DO UPDATE SET count = rate_counters.count + 1
     RETURNING count`,
    [key, windowStart],
  );
  const retryAfterSeconds = Math.max(1, Math.ceil((windowStart.getTime() + windowSeconds * 1000 - now) / 1000));
  if (rows[0].count > max) throw appError(code, message, { retryAfterSeconds });
  return { count: rows[0].count, retryAfterSeconds };
}
