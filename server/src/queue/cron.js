// 定时任务（docs/TASKS.md M1-BE-03、CODEX_HANDOFF §6 M1-BE-03 开工要点 a~g）。
// 调度：每个调度循环用「cron:<任务>:<窗口起点>」去重键入队，多 Worker 同时调度也只入队一次；
// 清理：分批执行（每批一个短事务），可重复执行；单批失败抛错交给队列重试，处理器按业务状态幂等（要点 f）。
import { enqueue } from './index.js';

/** 任务清单与各自的入队周期（窗口大小）。窗口对齐到周期起点，同窗口内重复调度被去重键挡住。 */
export function cronTasks(config) {
  return [
    { type: 'auth.sweep', everySeconds: config.cron.sweepEverySeconds },
    { type: 'uploads.sweep', everySeconds: config.cron.sweepEverySeconds },
    { type: 'projects.expire_sweep', everySeconds: config.cron.expireSweepEverySeconds },
    { type: 'jobs.cleanup', everySeconds: config.cron.jobsCleanupEverySeconds },
  ];
}

/** 时间窗口起点：floor(now / 窗口) * 窗口。 */
export function windowStart(everySeconds, nowMs = Date.now()) {
  return new Date(Math.floor(nowMs / (everySeconds * 1000)) * everySeconds * 1000);
}

/**
 * 调度器：start() 时立即调度一次，之后按 config.cron.tickSeconds 循环；stop() 停止。
 * 每个任务的入队键为 cron:<type>:<窗口 ISO>——同一窗口内无论多少个 Worker 调度多少次都只入队一次。
 */
export function createScheduler({ config, db, logger }) {
  let timer = null;

  async function tick() {
    for (const task of cronTasks(config)) {
      const key = `cron:${task.type}:${windowStart(task.everySeconds).toISOString()}`;
      const jobId = await enqueue(db, { type: task.type, dedupeKey: key });
      if (jobId !== null) logger.info('cron_enqueued', { type: task.type, dedupeKey: key, jobId });
    }
  }

  return {
    tick,
    start() {
      this.tick().catch((err) => logger.error('cron_tick_error', { err }));
      timer = setInterval(() => this.tick().catch((err) => logger.error('cron_tick_error', { err })), config.cron.tickSeconds * 1000);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

/**
 * engine/storage 就绪前的开发/测试存储实现（接口同 engine/README.md：put / signedUrl / remove）。
 * Worker 主入口缺省使用；测试注入有记录的模拟实现。
 */
export function createMemoryStorage() {
  const objects = new Map();
  return {
    async put(key, buffer, { contentType } = {}) { objects.set(key, { buffer, contentType }); },
    async signedUrl(key) { return `memory://${key}`; },
    async remove(keys) { for (const key of keys) objects.delete(key); },
  };
}

/** 分批删除：每批一个短事务，返回删除总数；无行即停，可重复执行。 */
async function deleteInBatches(db, { table, where, params = [], batchSize }) {
  let total = 0;
  for (;;) {
    const { rowCount } = await db.tx((t) => t.query(
      `DELETE FROM ${table} WHERE ctid IN (SELECT ctid FROM ${table} WHERE ${where} LIMIT ${batchSize})`,
      params,
    ));
    total += rowCount;
    if (rowCount < batchSize) return total;
  }
}

/**
 * auth.sweep（要点 c）：
 * - rate_counters：过期窗口（最长窗口 1 天 + 1 天缓冲）
 * - sms_codes：已作废（consumed_at）或已过期（expires_at）超过 1 天
 * - sessions：已过期
 */
export async function runAuthSweep(db, { batchSize }) {
  const rateCounters = await deleteInBatches(db, {
    table: 'rate_counters',
    where: 'window_start < now() - make_interval(secs => $1)',
    params: [172_800],
    batchSize,
  });
  const smsCodes = await deleteInBatches(db, {
    table: 'sms_codes',
    where: 'COALESCE(consumed_at, expires_at) < now() - make_interval(secs => $1)',
    params: [86_400],
    batchSize,
  });
  const sessions = await deleteInBatches(db, {
    table: 'sessions',
    where: 'expires_at < now()',
    params: [],
    batchSize,
  });
  return { rateCounters, smsCodes, sessions };
}

/**
 * jobs.cleanup（要点 f）：只清理超过保留期（默认 30 天）的 done 行。
 * 删掉后同去重键可再次入队，因此各业务处理器必须按业务状态幂等，不能只靠去重键。
 */
export async function runJobsCleanup(db, { batchSize, retentionDays }) {
  const doneJobs = await deleteInBatches(db, {
    table: 'jobs',
    where: "status = 'done' AND updated_at < now() - make_interval(days => $1)",
    params: [retentionDays],
    batchSize,
  });
  return { doneJobs };
}

/**
 * uploads.sweep（要点 d）：24 小时未被引用的上传，先在事务外删存储对象、再删记录。
 * 两步都可重复执行：对象已删时 remove 幂等，记录已删时 DELETE 影响 0 行。
 */
export async function runUploadsSweep(db, { storage, batchSize, olderThanSeconds = 86_400 }) {
  let total = 0;
  for (;;) {
    const { rows } = await db.query(
      `SELECT id, storage_key FROM uploads
        WHERE referenced_at IS NULL AND created_at < now() - make_interval(secs => $1)
        ORDER BY id LIMIT $2`,
      [olderThanSeconds, batchSize],
    );
    if (!rows.length) break;
    await storage.remove(rows.map((r) => r.storage_key));
    const { rowCount } = await db.tx((t) => t.query(`DELETE FROM uploads WHERE id = ANY($1)`, [rows.map((r) => r.id)]));
    total += rowCount;
    if (rows.length < batchSize) break;
  }
  return { uploads: total };
}

/**
 * projects.expire_sweep（要点 e）：delivered 且 expires_at 到期的作品：
 * ① 短事务：锁定一批 → 状态改 expired、写 project_events；② 事务外删成片与片段视频对象；
 * ③ 清空对应 video_key（封面、尾帧、海报与作品记录保留）。
 * 每批一个短事务，可重复执行；另含一个补偿循环：清理此前中断遗留的 expired 作品视频 key（要点 f：按业务状态幂等）。
 */
export async function runProjectsExpireSweep(db, { storage, batchSize }) {
  let expired = 0;
  let cleared = 0;

  for (;;) {
    const batch = await db.tx(async (t) => {
      const { rows } = await t.query(
        `SELECT id FROM projects
          WHERE status = 'delivered' AND expires_at <= now()
          ORDER BY expires_at, id LIMIT $1 FOR UPDATE SKIP LOCKED`,
        [batchSize],
      );
      if (!rows.length) return { ids: [], videoKeys: [] };
      const ids = rows.map((r) => r.id);
      await t.query(`UPDATE projects SET status = 'expired', updated_at = now() WHERE id = ANY($1)`, [ids]);
      for (const id of ids) {
        await t.query(
          `INSERT INTO project_events (project_id, status, progress, changed) VALUES ($1, 'expired', $2, '{}')`,
          [id, JSON.stringify({ percent: 100, message: '作品保存期已结束，视频已清理' })],
        );
      }
      const { rows: keys } = await t.query(
        `SELECT r.video_key, st.video_key AS take_video_key
           FROM renders r
           LEFT JOIN segments seg ON seg.project_id = r.project_id
           LEFT JOIN segment_takes st ON st.segment_id = seg.id
          WHERE r.project_id = ANY($1)`,
        [ids],
      );
      return { ids, videoKeys: keys.flatMap((k) => [k.video_key, k.take_video_key]).filter(Boolean) };
    });
    if (!batch.ids.length) break;
    if (batch.videoKeys.length) await storage.remove(batch.videoKeys);
    await clearVideoKeys(db, batch.ids);
    expired += batch.ids.length;
    if (batch.ids.length < batchSize) break;
  }

  // 补偿：上次执行在删对象后、清 key 前中断的 expired 作品，把剩余视频 key 清干净（业务状态幂等）
  for (;;) {
    const { rows } = await db.query(
      `SELECT DISTINCT p.id, r.video_key AS render_key, st.video_key AS take_key
         FROM projects p
         JOIN renders r ON r.project_id = p.id
         LEFT JOIN segments seg ON seg.project_id = p.id
         LEFT JOIN segment_takes st ON st.segment_id = seg.id
        WHERE p.status = 'expired' AND (r.video_key IS NOT NULL OR st.video_key IS NOT NULL)
        LIMIT $1`,
      [batchSize],
    );
    if (!rows.length) break;
    const ids = [...new Set(rows.map((r) => r.id))];
    const keys = rows.flatMap((r) => [r.render_key, r.take_key]).filter(Boolean);
    await storage.remove(keys);
    await clearVideoKeys(db, ids);
    cleared += ids.length;
    if (rows.length < batchSize) break;
  }

  return { expired, cleared };
}

/** 清空一批作品的成片与片段视频 key（只清视频；封面、尾帧、海报保留）。 */
async function clearVideoKeys(db, projectIds) {
  await db.tx(async (t) => {
    await t.query(`UPDATE renders SET video_key = NULL WHERE project_id = ANY($1) AND video_key IS NOT NULL`, [projectIds]);
    await t.query(
      `UPDATE segment_takes SET video_key = NULL
        WHERE segment_id IN (SELECT id FROM segments WHERE project_id = ANY($1)) AND video_key IS NOT NULL`,
      [projectIds],
    );
  });
}
