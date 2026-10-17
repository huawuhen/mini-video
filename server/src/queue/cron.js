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
 * uploads.sweep（要点 d）：24 小时未被引用的上传。
 * §6 审查 1：先在短事务里「认领删除」——只删仍满足条件且**没有 character_photos 行引用**的行并带出
 * storage_key（与引用操作靠行锁互斥）；提交后再删存储对象。异常数据（仍被引用）跳过而不是整批失败；
 * 删对象失败只记日志：孤儿对象可接受，误删用户照片不可接受。
 */
export async function runUploadsSweep(db, { storage, logger, batchSize, olderThanSeconds = 86_400 }) {
  let total = 0;
  for (;;) {
    const { rows } = await db.tx((t) => t.query(
      `DELETE FROM uploads
        WHERE id IN (
          SELECT id FROM uploads
           WHERE referenced_at IS NULL AND created_at < now() - make_interval(secs => $1)
             AND NOT EXISTS (SELECT 1 FROM character_photos WHERE upload_id = uploads.id)
           ORDER BY id LIMIT $2)
          AND referenced_at IS NULL AND created_at < now() - make_interval(secs => $1)
          AND NOT EXISTS (SELECT 1 FROM character_photos WHERE upload_id = uploads.id)
        RETURNING storage_key`,
      [olderThanSeconds, batchSize],
    ));
    if (!rows.length) break;
    try {
      await storage.remove(rows.map((r) => r.storage_key));
    } catch (err) {
      // 记录已删、对象留下：等 storage 侧按孤儿对象兜底，不影响任务成功
      logger?.warn('uploads_sweep_remove_failed', { count: rows.length, err });
    }
    total += rows.length;
    if (rows.length < batchSize) break;
  }
  return { uploads: total };
}

/**
 * projects.expire_sweep（要点 e）：delivered 且 expires_at 到期的作品：
 * ① 短事务：锁定一批 → 状态改 expired、写 project_events，同时带出成片与片段视频 key；
 * ② 事务外删对象；③ 按 key 精确清空（只清本次确实已删除对象的 key）。
 * §6 审查 2：成片与片段 key 分两条查询、以 project_id 为条件——以 renders 为起点会在没有成片记录时
 * 漏掉片段视频，renders × takes 连接还会笛卡尔积重复。删对象失败记日志、本次不清 key，留待下次调度。
 * 另含补偿循环：清理此前中断遗留的 expired 作品视频 key（要点 f：按业务状态幂等）。
 */
export async function runProjectsExpireSweep(db, { storage, logger, batchSize }) {
  let expired = 0;
  let clearedKeys = 0;

  for (;;) {
    const batch = await db.tx(async (t) => {
      const { rows } = await t.query(
        `SELECT id FROM projects
          WHERE status = 'delivered' AND expires_at <= now()
          ORDER BY expires_at, id LIMIT $1 FOR UPDATE SKIP LOCKED`,
        [batchSize],
      );
      if (!rows.length) return { ids: [], keys: [] };
      const ids = rows.map((r) => r.id);
      await t.query(`UPDATE projects SET status = 'expired', updated_at = now() WHERE id = ANY($1)`, [ids]);
      for (const id of ids) {
        await t.query(
          `INSERT INTO project_events (project_id, status, progress, changed) VALUES ($1, 'expired', $2, '{}')`,
          [id, JSON.stringify({ percent: 100, message: '作品保存期已结束，视频已清理' })],
        );
      }
      return { ids, keys: await collectVideoKeys(t, ids) };
    });
    if (!batch.ids.length) break;
    expired += batch.ids.length;
    clearedKeys += await removeAndClearVideoKeys(db, storage, logger, batch.keys);
    if (batch.ids.length < batchSize) break;
  }

  // 补偿：上次执行在删对象后、清 key 前中断的 expired 作品，把剩余视频 key 清干净（业务状态幂等）
  for (;;) {
    const keys = await collectStaleVideoKeys(db, batchSize);
    if (!keys.length) break;
    const cleared = await removeAndClearVideoKeys(db, storage, logger, keys);
    clearedKeys += cleared;
    if (cleared === 0) break; // 删对象失败：本次不清 key，避免同批空转，留待下次调度
  }

  return { expired, clearedKeys };
}

/** 一批作品的全部视频对象 key：成片与片段分两条查询（§6 审查 2）。 */
async function collectVideoKeys(t, projectIds) {
  const renderKeys = (await t.query(
    `SELECT video_key FROM renders WHERE project_id = ANY($1) AND video_key IS NOT NULL`,
    [projectIds],
  )).rows.map((r) => r.video_key);
  const takeKeys = (await t.query(
    `SELECT st.video_key FROM segment_takes st JOIN segments seg ON seg.id = st.segment_id
      WHERE seg.project_id = ANY($1) AND st.video_key IS NOT NULL`,
    [projectIds],
  )).rows.map((r) => r.video_key);
  return [...renderKeys, ...takeKeys];
}

/** 补偿候选：已 expired 但视频 key 未清的行（成片与片段分两条，均按作品状态驱动）。 */
async function collectStaleVideoKeys(db, batchSize) {
  const renderKeys = (await db.query(
    `SELECT r.video_key FROM renders r JOIN projects p ON p.id = r.project_id
      WHERE p.status = 'expired' AND r.video_key IS NOT NULL LIMIT $1`,
    [batchSize],
  )).rows.map((r) => r.video_key);
  const takeKeys = (await db.query(
    `SELECT st.video_key FROM segment_takes st
       JOIN segments seg ON seg.id = st.segment_id
       JOIN projects p ON p.id = seg.project_id
      WHERE p.status = 'expired' AND st.video_key IS NOT NULL LIMIT $1`,
    [batchSize],
  )).rows.map((r) => r.video_key);
  return [...renderKeys, ...takeKeys];
}

/** 事务外删对象，成功后按 key 精确清空；失败记日志并返回 0（key 留待下次调度重试）。 */
async function removeAndClearVideoKeys(db, storage, logger, keys) {
  if (!keys.length) return 0;
  try {
    await storage.remove(keys);
  } catch (err) {
    logger?.warn('expire_sweep_remove_failed', { count: keys.length, err });
    return 0;
  }
  await db.tx(async (t) => {
    await t.query(`UPDATE renders SET video_key = NULL WHERE video_key = ANY($1)`, [keys]);
    await t.query(`UPDATE segment_takes SET video_key = NULL WHERE video_key = ANY($1)`, [keys]);
  });
  return keys.length;
}
