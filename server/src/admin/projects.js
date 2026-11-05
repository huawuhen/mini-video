// 运营后台·作品与失败/待核对处理业务逻辑（M3-ADM-03，docs/API.md §8.3）。
// 待核对（take unknown）= 上游提交结果未知、金额冻结、不自动重提不自动退款（AGENTS §5）；
// 运营在渠道后台查明后人工判定一次：not_charged 退还冻结 / charged 按原价结算，片段标
// failed，用户可重新生成；结论写 admin_audit_logs 与作品事件，同一 take 只能判定一次。
import { maskPhone } from '../auth/sms.js';
import { appError } from '../http/errors.js';
import { cancelProject } from '../projects/service.js';
import { appendEvent } from '../projects/state.js';
import { projectMoneySummary, videoUnitFen } from '../projects/money.js';
import { refund, settle } from '../wallet/service.js';

const CURSOR_NS = '(extract(epoch FROM p.created_at) * 1000000)::bigint';

function decodeCursor(cursor) {
  const sep = cursor.lastIndexOf('~');
  const createdUs = sep > 0 ? Number(cursor.slice(0, sep)) : NaN;
  const id = sep > 0 ? cursor.slice(sep + 1) : '';
  if (!Number.isSafeInteger(createdUs) || createdUs < 0 || !id) {
    throw appError('VALIDATION_FAILED', undefined, { fields: { cursor: '格式不正确' } });
  }
  return [createdUs, id];
}

/** 列表（§8.3）：status/userId 精确过滤；hasUnknown=true 只列有待核对片段的作品。 */
export async function listProjects(db, { status, userId, hasUnknown, cursor, limit }) {
  const values = [limit + 1];
  const conditions = [];
  if (status) { values.push(status); conditions.push(`p.status = $${values.length}`); }
  if (userId) { values.push(userId); conditions.push(`p.user_id = $${values.length}`); }
  if (hasUnknown) {
    conditions.push(`EXISTS (SELECT 1 FROM segments s2 JOIN segment_takes st2 ON st2.segment_id = s2.id
       WHERE s2.project_id = p.id AND st2.status = 'unknown')`);
  }
  if (cursor) {
    const [createdUs, id] = decodeCursor(cursor);
    values.push(createdUs, id);
    conditions.push(`(${CURSOR_NS}, p.id) < ($${values.length - 1}, $${values.length})`);
  }
  const { rows } = await db.query(
    `SELECT p.id, p.user_id, p.title, p.status, p.progress, p.created_at, p.updated_at, u.phone,
            ${CURSOR_NS} AS created_us,
            (SELECT count(*)::int FROM segments s3 JOIN segment_takes st3 ON st3.segment_id = s3.id
              WHERE s3.project_id = p.id AND st3.status = 'unknown' AND st3.resolved_outcome IS NULL) AS unknown_takes
       FROM projects p JOIN users u ON u.id = p.user_id
      ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
      ORDER BY p.created_at DESC, p.id DESC LIMIT $1`,
    values,
  );
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    items: page.map((row) => ({
      id: row.id, userId: row.user_id, phoneMasked: maskPhone(row.phone),
      title: row.title, status: row.status, progress: row.progress ?? { percent: 0, message: '' },
      unknownTakes: Number(row.unknown_takes),
      createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
    })),
    nextCursor: hasMore && last ? `${last.created_us}~${last.id}` : null,
  };
}

/** 片段与 take 明细（含 gen_task 状态、渠道名、上游任务 ID、待核对金额）。 */
async function loadSegments(db, { projectId, unitFen }) {
  const { rows } = await db.query(
    `SELECT s.id AS segment_id, s.idx, s.duration_seconds, s.plot, s.selected_take_id,
            st.id AS take_id, st.status AS take_status, st.error AS take_error,
            st.resolved_outcome, st.resolved_note, st.resolved_at, st.created_at AS take_created_at,
            gt.status AS gen_task_status, gt.upstream_id, pc.name AS channel_name
       FROM segments s
        LEFT JOIN segment_takes st ON st.segment_id = s.id
        LEFT JOIN gen_tasks gt ON gt.id = st.gen_task_id
        LEFT JOIN provider_channels pc ON pc.id = gt.channel_id
      WHERE s.project_id = $1
      ORDER BY s.idx, st.created_at, st.id`,
    [projectId],
  );
  const bySegment = new Map();
  for (const row of rows) {
    let seg = bySegment.get(row.segment_id);
    if (!seg) {
      seg = { id: row.segment_id, index: row.idx, durationSeconds: row.duration_seconds,
        plot: row.plot, selectedTakeId: row.selected_take_id, takes: [] };
      bySegment.set(row.segment_id, seg);
    }
    if (row.take_id) {
      seg.takes.push({
        id: row.take_id, status: row.take_status,
        genTaskStatus: row.gen_task_status ?? null,
        channel: row.channel_name ?? null,
        upstreamTaskId: row.upstream_id ?? null,
        // unknown 片段的冻结金额 = 段时长 × 锁定档位单价（与取消时 unknownFrozen 同口径）
        frozenFen: row.take_status === 'unknown' && row.resolved_outcome === null
          ? row.duration_seconds * unitFen : 0,
        error: row.take_error ?? null,
        resolvedOutcome: row.resolved_outcome ?? undefined,
        resolvedNote: row.resolved_note ?? undefined,
        resolvedAt: row.resolved_at ? row.resolved_at.toISOString() : undefined,
        createdAt: row.take_created_at.toISOString(),
      });
    }
  }
  return [...bySegment.values()];
}

/** 详情（§8.3 AdminProjectDetail）：片段/take、gen_task、渠道、金额聚合、事件时间线。 */
export async function getProjectDetail(db, { projectId }) {
  const { rows } = await db.query(
    `SELECT p.*, u.phone FROM projects p JOIN users u ON u.id = p.user_id WHERE p.id = $1`, [projectId]);
  if (!rows.length) throw appError('PROJECT_NOT_FOUND');
  const project = rows[0];
  const money = await projectMoneySummary(db, { userId: project.user_id, projectId });
  const unitFen = await videoUnitFen(db, project.tier_mapping_id);
  const [segments, events] = await Promise.all([
    loadSegments(db, { projectId, unitFen }),
    db.query(
      `SELECT id, status, progress, created_at FROM project_events
        WHERE project_id = $1 ORDER BY id DESC LIMIT 50`, [projectId]),
  ]);
  return {
    id: project.id, userId: project.user_id, phoneMasked: maskPhone(project.phone),
    title: project.title, status: project.status, progress: project.progress ?? { percent: 0, message: '' },
    unknownTakes: segments.reduce((n, seg) => n + seg.takes.filter((tk) => tk.status === 'unknown' && !tk.resolvedOutcome).length, 0),
    money: {
      reservedFen: money.reservedFen, settledFen: money.settledFen,
      refundedFen: money.refundedFen, frozenFen: money.frozenFen,
    },
    segments,
    events: events.rows.map((row) => ({
      id: Number(row.id), status: row.status, progress: row.progress ?? {},
      createdAt: row.created_at.toISOString(),
    })),
    createdAt: project.created_at.toISOString(), updatedAt: project.updated_at.toISOString(),
  };
}

/**
 * 待核对判定（§8.3，同一 take 只能判定一次）：
 * - not_charged：上游未扣费/未生成 → 退还该片段冻结（title「待核对退回」），片段标 failed；
 * - charged：上游已扣费 → 按原价结算该片段冻结（title「待核对结算」），片段标 failed。
 * 金额 = 段时长 × 锁定档位单价（与取消时 unknownFrozen、逐段结算同口径）。
 * 幂等：同键重放返回首次详情；不同键对已判定 take → 409 TAKE_ALREADY_RESOLVED；
 * 账本键再叠一层 `admin:resolve:<takeId>:refund|settle`（确定性，双保险）。
 */
export async function resolveTake(db, { takeId, outcome, note, idempotencyKey, adminId }) {
  const resolvedKey = `admin:resolve:${idempotencyKey}`;
  await db.tx(async (t) => {
    const { rows } = await t.query(
      `SELECT st.*, s.project_id, s.duration_seconds, p.user_id, p.tier_mapping_id, p.status AS project_status,
              p.progress AS project_progress
         FROM segment_takes st
          JOIN segments s ON s.id = st.segment_id
          JOIN projects p ON p.id = s.project_id
        WHERE st.id = $1
        FOR UPDATE OF st`, [takeId]);
    const take = rows[0];
    if (!take) throw appError('NOT_FOUND', '片段不存在');
    if (take.resolved_outcome) {
      // 同键重放 = 同一判定，放行（外层返回详情）；换键重判拒绝
      if (take.resolved_key !== resolvedKey) throw appError('TAKE_ALREADY_RESOLVED');
      return;
    }
    if (take.status !== 'unknown') throw appError('TAKE_NOT_UNKNOWN');
    const unitFen = await videoUnitFen(t, take.tier_mapping_id);
    const amountFen = take.duration_seconds * unitFen;
    const ledgerKey = `admin:resolve:${takeId}:${outcome === 'not_charged' ? 'refund' : 'settle'}`;
    if (outcome === 'not_charged') {
      await refund(t, { userId: take.user_id, amountFen, refType: 'project', refId: take.project_id,
        idempotencyKey: ledgerKey, title: '待核对退回' });
    } else {
      await settle(t, { userId: take.user_id, amountFen, refType: 'project', refId: take.project_id,
        idempotencyKey: ledgerKey, title: '待核对结算' });
    }
    const { rowCount } = await t.query(
      `UPDATE segment_takes SET status = 'failed', resolved_outcome = $2, resolved_note = $3,
          resolved_key = $4, resolved_by = $5, resolved_at = now()
        WHERE id = $1 AND status = 'unknown' AND resolved_outcome IS NULL`,
      [takeId, outcome, note, resolvedKey, adminId]);
    if (rowCount === 0) throw appError('TAKE_ALREADY_RESOLVED'); // 并发兜底
    // 作品时间线（用户可见）：片段本身已在 unknown 时把项目置 failed，这里只补核对结论
    await appendEvent(t, { projectId: take.project_id, status: take.project_status,
      progress: { ...(take.project_progress ?? { percent: 0 }),
        message: outcome === 'charged' ? '已核对：上游已计费' : '已核对：上游未扣费，费用已退回' },
      changed: [] });
  });
  return getProjectDetail(db, { projectId: (await loadTakeProject(db, takeId)) });
}

async function loadTakeProject(db, takeId) {
  const { rows } = await db.query(
    `SELECT s.project_id FROM segment_takes st JOIN segments s ON s.id = st.segment_id WHERE st.id = $1`, [takeId]);
  if (!rows.length) throw appError('NOT_FOUND', '片段不存在');
  return rows[0].project_id;
}

/** 后台取消：与用户侧取消同一套逻辑（退还未消耗冻结、unknown 保持冻结待 resolve）。 */
export async function cancelProjectAdmin(db, { projectId }) {
  const result = await cancelProject(db, { projectId });
  return { detail: await getProjectDetail(db, { projectId }), ...result };
}
