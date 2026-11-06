// 运营后台·作品与失败/待核对处理业务逻辑（M3-ADM-03，docs/API.md §8.3）。
// 待核对（take unknown）= 上游提交结果未知、金额冻结、不自动重提不自动退款（AGENTS §5）；
// 运营在渠道后台查明后人工判定一次：not_charged 退还冻结 / charged 按原价结算，片段标
// failed，用户可重新生成；结论写 admin_audit_logs 与作品事件，同一 take 只能判定一次。
import { maskPhone } from '../auth/sms.js';
import { appError } from '../http/errors.js';
import { cancelProject } from '../projects/service.js';
import { appendEvent } from '../projects/state.js';
import { projectMoneySummary } from '../projects/money.js';
import { refund } from '../wallet/service.js';

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

/** 片段与 take 明细（含 gen_task 状态、渠道名、上游任务 ID、待核对金额）。
 * 待核对金额一律取 take 下单时写入的 gen_tasks.request.amountFen（复审必改①：
 * 与逐段结算/退回同口径，改价不影响判定与取消的冻结金额）。 */
async function loadSegments(db, { projectId }) {
  const { rows } = await db.query(
    `SELECT s.id AS segment_id, s.idx, s.duration_seconds, s.plot, s.selected_take_id,
            st.id AS take_id, st.status AS take_status, st.error AS take_error,
            st.resolved_outcome, st.resolved_note, st.resolved_at, st.created_at AS take_created_at,
            gt.status AS gen_task_status, gt.upstream_id, gt.request AS gen_request,
            pc.name AS channel_name
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
      const request = row.gen_request
        ? (typeof row.gen_request === 'string' ? JSON.parse(row.gen_request) : row.gen_request) : {};
      seg.takes.push({
        id: row.take_id, status: row.take_status,
        genTaskStatus: row.gen_task_status ?? null,
        channel: row.channel_name ?? null,
        upstreamTaskId: row.upstream_id ?? null,
        frozenFen: row.take_status === 'unknown' && row.resolved_outcome === null
          ? Number(request.amountFen ?? 0) : 0,
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
  const [segments, events] = await Promise.all([
    loadSegments(db, { projectId }),
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
 * 待核对判定（§8.3，2026-11-05 用户决策：上游已扣费但没出片由平台承担）。
 * 两种结论**对用户的资金处理相同**，`charged` 只体现在 resolved_outcome 与审计：
 * - 金额一律取 take 下单时写入的 gen_tasks.request.amountFen（复审必改①，不按当前价重算）；
 * - 作品仍可重试（未取消/未过期，且非交付后重拍）→ **保持冻结**，只把 take 置 failed
 *   （与普通片段失败一致：重试复用这笔冻结，取消时随其他冻结一起退回）；
 * - 交付后重拍（redelivery）的 take，或作品已取消/已过期 → **当场退回**（标题「待核对退回」）；
 * - 不向用户结算。用户可见时间线统一「已核对：该片段生成失败，费用未扣除」。
 * 幂等（§8.3）：同键同结论重放返回首次结果（replayed=true，审计跳过）；同键不同结论
 * 409 IDEMPOTENCY_CONFLICT；换键重判 409 TAKE_ALREADY_RESOLVED；非 unknown 409 TAKE_NOT_UNKNOWN。
 */
export async function resolveTake(db, { takeId, outcome, note, idempotencyKey, adminId }) {
  const resolvedKey = `admin:resolve:${idempotencyKey}`;
  let replayed = false;
  let refundedFen = 0;
  await db.tx(async (t) => {
    const { rows } = await t.query(
      `SELECT st.*, s.project_id, p.user_id, p.status AS project_status, p.progress AS project_progress,
              gt.request AS gen_request
         FROM segment_takes st
          JOIN segments s ON s.id = st.segment_id
          JOIN projects p ON p.id = s.project_id
          LEFT JOIN gen_tasks gt ON gt.id = st.gen_task_id
        WHERE st.id = $1
        FOR UPDATE OF st`, [takeId]);
    const take = rows[0];
    if (!take) throw appError('NOT_FOUND', '片段不存在');
    if (take.resolved_outcome) {
      if (take.resolved_key !== resolvedKey) throw appError('TAKE_ALREADY_RESOLVED'); // 换键重判
      if (take.resolved_outcome !== outcome) throw appError('IDEMPOTENCY_CONFLICT'); // 同键不同结论
      replayed = true;
      return;
    }
    if (take.status !== 'unknown') throw appError('TAKE_NOT_UNKNOWN');
    const request = take.gen_request
      ? (typeof take.gen_request === 'string' ? JSON.parse(take.gen_request) : take.gen_request) : {};
    const amountFen = request.amountFen;
    if (!Number.isSafeInteger(amountFen) || amountFen <= 0) {
      // 内部不变量被破坏（与逐段结算同口径报错），不猜金额
      throw appError('INTERNAL', `片段任务缺少下单金额 amountFen：take=${takeId}`);
    }
    const redelivery = request.redelivery === true;
    const terminal = take.project_status === 'canceled' || take.project_status === 'expired';
    if (redelivery || terminal) {
      // 无重试入口：当场退回（不向用户结算）
      await refund(t, { userId: take.user_id, amountFen, refType: 'project', refId: take.project_id,
        idempotencyKey: `admin:resolve:${takeId}:refund`, title: '待核对退回' });
      refundedFen = amountFen;
    }
    // 其余情况保持冻结：与普通片段失败一致，用户点「重试」复用这笔冻结
    const { rowCount } = await t.query(
      `UPDATE segment_takes SET status = 'failed', resolved_outcome = $2, resolved_note = $3,
          resolved_key = $4, resolved_by = $5, resolved_at = now()
        WHERE id = $1 AND status = 'unknown' AND resolved_outcome IS NULL`,
      [takeId, outcome, note, resolvedKey, adminId]);
    if (rowCount === 0) throw appError('TAKE_ALREADY_RESOLVED'); // 并发兜底
    // 判定清零最后一个待核对片段、且作品停在 failed(TAKE_UNKNOWN) 时，恢复为普通失败
    //（错误码换成 SEGMENT_FAILED）——用户端据 error.code 决定展示「等客服」还是「可重试」视图
    const { rows: remaining } = await t.query(
      `SELECT 1 FROM segment_takes st JOIN segments s ON s.id = st.segment_id
        WHERE s.project_id = $1 AND st.status = 'unknown' LIMIT 1`, [take.project_id]);
    if (!remaining.length && take.project_status === 'failed') {
      await t.query(
        `UPDATE projects SET error = $2, updated_at = now()
          WHERE id = $1 AND status = 'failed' AND error->>'code' = 'TAKE_UNKNOWN'`,
        [take.project_id, JSON.stringify({ code: 'SEGMENT_FAILED',
          message: '片段生成失败，可以重试或取消', step: 'rendering' })]);
    }
    // 用户可见时间线（统一文案，不暴露上游是否计费）
    await appendEvent(t, { projectId: take.project_id, status: take.project_status,
      progress: { ...(take.project_progress ?? { percent: 0 }),
        message: '已核对：该片段生成失败，费用未扣除' },
      changed: [] });
  });
  const projectId = await loadTakeProject(db, takeId);
  return { detail: await getProjectDetail(db, { projectId }), replayed, refundedFen };
}

async function loadTakeProject(db, takeId) {
  const { rows } = await db.query(
    `SELECT s.project_id FROM segment_takes st JOIN segments s ON s.id = st.segment_id WHERE st.id = $1`, [takeId]);
  if (!rows.length) throw appError('NOT_FOUND', '片段不存在');
  return rows[0].project_id;
}

/** 后台取消：与用户侧取消同一套逻辑（退还未消耗冻结、unknown 保持冻结待 resolve）。 */
export async function cancelProjectAdmin(db, { projectId }) {
  const result = await cancelProject(db, { projectId, asAdmin: true });
  return { detail: await getProjectDetail(db, { projectId }), ...result };
}
