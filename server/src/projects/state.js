// 作品状态迁移原语（docs/ARCHITECTURE.md §4）：每次迁移是一个短事务内的条件 UPDATE，
// 失败即 409 PROJECT_STATE_INVALID；同事务写 project_events 并 NOTIFY，SSE 与续跑都以此为准。
import { appError } from '../http/errors.js';

export const GROUPS = {
  active: ['understanding', 'casting', 'rendering', 'composing', 'paused'],
  review: ['story_review', 'cast_review'],
  done: ['delivered'],
  failed: ['failed', 'canceled'],
  expired: ['expired'],
};

export function groupOf(status) {
  return Object.entries(GROUPS).find(([, list]) => list.includes(status))?.[0] ?? 'active';
}

/** 进度分档（认领说明的内部口径）；segmentStep 用于 rendering 阶段按段均分。 */
export const PROGRESS = {
  understanding: { percent: 10, message: '正在理解故事、规划片段' },
  story_review: { percent: 15, message: '故事已就绪，等待你确认' },
  casting: { percent: 30, message: '正在生成角色形象' },
  cast_review: { percent: 40, message: '角色已就绪，等待你确认' },
  rendering: (done, total) => ({
    percent: total ? 45 + Math.round((done / total) * 45) : 45,
    message: total ? `正在生成片段 ${Math.min(done + 1, total)}/${total}` : '正在生成片段',
  }),
  composing: { percent: 95, message: '正在拼接成片' },
  delivered: { percent: 100, message: '已完成' },
};

/**
 * 条件状态迁移。from 为允许的前置状态数组；error 结构 { code, message, step }；
 * 返回更新前的行不存在或状态不符时抛 409。
 */
export async function transition(t, { projectId, userId, from, to, pausedFrom = null, error = null,
  progress, changed = [] }) {
  const nextProgress = progress ?? PROGRESS[to] ?? { percent: 0, message: '' };
  // rendering 的进度是 (done, total) => object 的函数：这里按 0/total 求值，事件里存对象
  const value = typeof nextProgress === 'function' ? nextProgress(0, 0) : nextProgress;
  const { rows } = await t.query(
    `UPDATE projects SET status = $3, paused_from = $4, error = $5, progress = $6, updated_at = now()
      WHERE id = $1 AND user_id = $2 AND status = ANY($7::text[]) AND deleted_at IS NULL
      RETURNING id`,
    [projectId, userId, to, pausedFrom, error ? JSON.stringify(error) : null,
      JSON.stringify(value), from],
  );
  if (!rows.length) throw appError('PROJECT_STATE_INVALID');
  await appendEvent(t, { projectId, status: to, progress: value, changed });
  return rows[0];
}

/**
 * M2-BE-04①：作品流水线任务在队列里重试耗尽（job 终态 failed）时的兜底——
 * 此前 bind_prompts 等连续失败 5 次后 job 标 failed，但作品永远停在进行中
 * （无 error、视频费一直冻结）。这里把作品置 failed（带 step 与中文原因），
 * 金额按 A 口径保持冻结：retry 免费重建、cancel 一次性退回未结算部分。
 * 幂等：仅当作品仍处于进行中状态才迁移（已是 failed/delivered/canceled 则不动）。
 */
export async function markProjectPipelineFailed(db, { projectId, step, code = 'PIPELINE_FAILED',
  message = '制作遇到问题，可以重试或取消', logger }) {
  try {
    await db.tx(async (t) => {
      const { rows } = await t.query(
        `UPDATE projects SET status = 'failed', paused_from = NULL, updated_at = now(),
            error = $2, progress = jsonb_build_object('percent', 0, 'message', $3::text)
          WHERE id = $1 AND deleted_at IS NULL
            AND status IN ('understanding', 'casting', 'rendering', 'composing', 'paused')
          RETURNING user_id`,
        [projectId, JSON.stringify({ code, step, message }), message],  // $1 id / $2 error / $3 message
      );
      if (rows.length) {
        await appendEvent(t, { projectId, status: 'failed',
          progress: { percent: 0, message: '制作失败' }, changed: [] });
      }
    });
  } catch (error) {
    // 兜底自身失败不阻塞 job 记账（下次 cron/人工可再处理）；记日志供排查
    logger?.error?.('pipeline_fail_fallback_error', { projectId, step, message: error?.message });
  }
}

/** 只更新进度（状态不变），如 rendering 内每完成一段推进一次。 */
export async function updateProgress(t, { projectId, progress, changed = [] }) {
  const value = typeof progress === 'function' ? progress(0, 0) : progress;
  await t.query(`UPDATE projects SET progress = $2, updated_at = now() WHERE id = $1`,
    [projectId, JSON.stringify(value)]);
  await appendEvent(t, { projectId, status: null, progress: value, changed });
}

export async function appendEvent(t, { projectId, status, progress, changed = [] }) {
  await t.query(
    `INSERT INTO project_events (project_id, status, progress, changed) VALUES ($1, $2, $3, $4)`,
    [projectId, status ?? 'unchanged', JSON.stringify(progress ?? { percent: 0, message: '' }), changed],
  );
  await t.query(`SELECT pg_notify('project_events', $1)`,
    [JSON.stringify({ projectId, status: status ?? undefined })]);
}

export async function requireProject(q, { userId, projectId }) {
  const { rows } = await q.query(
    `SELECT * FROM projects WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
    [projectId, userId],
  );
  if (!rows.length) throw appError('NOT_FOUND');
  return rows[0];
}
