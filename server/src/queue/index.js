// PG 任务队列（docs/ARCHITECTURE.md §4）：FOR UPDATE SKIP LOCKED 领取 + 租约 + 指数退避 + 去重键。
// q 参数可以是 db 或事务作用域 t：状态迁移事务里调用 enqueue，job 与状态一起提交或一起回滚。

const MAX_ERROR_LENGTH = 2000;

/** 可重试错误：处理器抛出 err.retryable === false 表示不再重试（如参数错误、业务状态已变）。 */
export class PermanentJobError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PermanentJobError';
    this.retryable = false;
  }
}

/**
 * 入队。dedupeKey 相同的 job 只会存在一个（已完成的也算），返回 null 表示被去重。
 * @returns {Promise<number | null>} job id
 */
export async function enqueue(q, { type, payload = {}, runAt, delaySeconds, dedupeKey, maxAttempts = 5 }) {
  const { rows } = await q.query(
    `INSERT INTO jobs (type, payload, run_at, dedupe_key, max_attempts)
     VALUES ($1, $2, COALESCE($3::timestamptz, now() + make_interval(secs => $4)), $5, $6)
     ON CONFLICT (dedupe_key) DO NOTHING
     RETURNING id`,
    [type, payload, runAt ?? null, delaySeconds ?? 0, dedupeKey ?? null, maxAttempts],
  );
  return rows[0]?.id ?? null;
}

/**
 * 领取一个可执行的 job：排队且到期的，或租约已过期的（Worker 崩溃后被重新领取）。
 * 超过最大次数的过期 job 直接标记失败，继续找下一个。
 */
export async function claim(db, { workerId, types, leaseSeconds = 120 }) {
  for (;;) {
    const { rows } = await db.query(
      `UPDATE jobs SET status = 'running', locked_by = $1, locked_until = now() + make_interval(secs => $2),
              attempts = attempts + 1, updated_at = now()
        WHERE id = (
          SELECT id FROM jobs
           WHERE type = ANY($3::text[])
             AND ((status = 'queued' AND run_at <= now()) OR (status = 'running' AND locked_until < now()))
           ORDER BY run_at, id
           FOR UPDATE SKIP LOCKED
           LIMIT 1)
        RETURNING *`,
      [workerId, leaseSeconds, types],
    );
    const job = rows[0];
    if (!job) return null;
    if (job.attempts <= job.max_attempts) return job;
    await db.query(
      `UPDATE jobs SET status = 'failed', locked_by = NULL, locked_until = NULL,
              last_error = COALESCE(last_error, '') || ' | 租约过期且超过最大次数', updated_at = now()
        WHERE id = $1`,
      [job.id],
    );
  }
}

/** 只有仍持有租约的 Worker 才能完成/失败/续约，防止租约被抢后旧 Worker 覆盖结果。返回是否成功。 */
export async function complete(db, job, workerId) {
  const { rowCount } = await db.query(
    `UPDATE jobs SET status = 'done', locked_by = NULL, locked_until = NULL, updated_at = now()
      WHERE id = $1 AND locked_by = $2 AND status = 'running'`,
    [job.id, workerId],
  );
  return rowCount === 1;
}

export async function fail(db, job, workerId, err) {
  const retry = err?.retryable !== false && job.attempts < job.max_attempts;
  const message = String(err?.stack || err?.message || err).slice(0, MAX_ERROR_LENGTH);
  const { rowCount } = await db.query(
    `UPDATE jobs SET status = $3, run_at = CASE WHEN $3 = 'queued' THEN now() + make_interval(secs => $4) ELSE run_at END,
            locked_by = NULL, locked_until = NULL, last_error = $5, updated_at = now()
      WHERE id = $1 AND locked_by = $2 AND status = 'running'`,
    [job.id, workerId, retry ? 'queued' : 'failed', retry ? backoffSeconds(job.attempts) : 0, message],
  );
  return { updated: rowCount === 1, retry };
}

export async function extendLease(db, job, workerId, leaseSeconds) {
  const { rowCount } = await db.query(
    `UPDATE jobs SET locked_until = now() + make_interval(secs => $3), updated_at = now()
      WHERE id = $1 AND locked_by = $2 AND status = 'running'`,
    [job.id, workerId, leaseSeconds],
  );
  return rowCount === 1;
}

/** 第 n 次失败后的等待秒数：5s、10s、20s … 上限 10 分钟，加 0~20% 抖动。 */
export function backoffSeconds(attempts) {
  const base = Math.min(5 * 2 ** Math.max(0, attempts - 1), 600);
  return Math.round(base * (1 + Math.random() * 0.2));
}
