// 作品相关的钱包流（docs/API.md §3 计费约定）：确认点 A 形象费、确认点 B 视频费预占，
// 片段逐段结算、失败按段退回、取消退回未提交部分。金额一律整数分；幂等键按用途拆分，
// 重复执行只生效一次（wallet/service 的 withIdempotency 保证）。
import { appError } from '../http/errors.js';
import { reserve, settle, refund } from '../wallet/service.js';

const REF = { type: 'project' };

export function reserveProjectLooks(t, { userId, projectId, amountFen }) {
  if (amountFen <= 0) return;
  return reserve(t, {
    userId, amountFen, refType: REF.type, refId: projectId,
    idempotencyKey: `project:${projectId}:looks:reserve`, title: '生成角色形象预占',
  });
}

export function reserveProjectVideo(t, { userId, projectId, amountFen }) {
  if (amountFen <= 0) return;
  return reserve(t, {
    userId, amountFen, refType: REF.type, refId: projectId,
    idempotencyKey: `project:${projectId}:video:reserve`, title: '视频生成预占',
  });
}

/** 单段结算/退回：金额 = 锁定档位映射的视频单价 × 段时长（与确认点 B 预占用同一计价来源）。 */
export function settleSegment(t, { userId, projectId, takeId, amountFen }) {
  if (amountFen <= 0) return;
  return settle(t, {
    userId, amountFen, refType: REF.type, refId: projectId,
    idempotencyKey: `project:${projectId}:video:${takeId}:settle`, title: '片段生成结算',
  });
}

/** 取消/过期时的兜底退回（次数幂等键按用途传入，如 cancel:video）。 */
export function refundProject(t, { userId, projectId, amountFen, purpose }) {
  if (amountFen <= 0) return;
  return refund(t, {
    userId, amountFen, refType: REF.type, refId: projectId,
    idempotencyKey: `project:${projectId}:refund:${purpose}`, title: '作品取消退回',
  });
}

/** 视频单价（分/秒）：按作品创建时锁定的 tier_mapping 找当前生效 SKU，与计价函数同源。 */
export async function videoUnitFen(t, tierMappingId) {
  const { rows } = await t.query(
    `SELECT s.price_fen FROM tier_mappings tm
       JOIN skus s ON s.sku_code = tm.video_sku_code AND s.kind = 'video' AND s.status = 'active'
      WHERE tm.id = $1
      ORDER BY s.version DESC LIMIT 1`,
    [tierMappingId],
  );
  if (!rows.length) throw appError('INTERNAL', '视频 SKU 不存在或未生效');
  return rows[0].price_fen;
}

/** Pricing 聚合（API §6.2）：视频流水的 ref 是 project；形象结算/退回（BE-04 惯例）的
 * ref 是 look/versionId，需经 project_cast 关联归集到作品。 */
export async function projectMoneySummary(t, { userId, projectId }) {
  const { rows } = await t.query(
    `SELECT kind, COALESCE(SUM(l.frozen_delta_fen), 0) AS frozen, COALESCE(SUM(l.amount_fen), 0) AS available
       FROM ledger l
      WHERE l.user_id = $1
        AND (l.ref_type = 'project' AND l.ref_id = $2
          OR l.ref_type = 'look' AND l.ref_id IN (
            SELECT lv2.id FROM look_versions lv2
              JOIN character_looks cl2 ON cl2.id = lv2.look_id
             WHERE cl2.character_id IN (
               SELECT pc.character_id FROM project_cast pc WHERE pc.project_id = $2)))
      GROUP BY kind`,
    [userId, projectId],
  );
  const byKind = Object.fromEntries(rows.map((row) => [row.kind, row]));
  const reserved = Number(byKind.reserve?.frozen ?? 0);
  const settled = Number(byKind.settle?.frozen ? -byKind.settle.frozen : 0);
  const refunded = Number(byKind.refund?.available ?? 0);
  return { reservedFen: reserved, settledFen: settled, refundedFen: refunded,
    frozenFen: Math.max(0, reserved - settled - refunded) };
}
