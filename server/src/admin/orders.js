// 运营后台·充值订单与人工退款业务逻辑（M3-ADM-02，docs/API.md §8.2）。
// 人工退款为「记录式」：钱由客服在微信商户平台手工退回，本模块只在我方记账——
// 写一条 adjust 负数流水（标题「充值退款」，ref 指向订单）并累加 refunded_fen；
// 手动对账复用 payments/recharge.js 的 reconcileOneOrder（与定时对账同一套口径）。
import { maskPhone } from '../auth/sms.js';
import { appError } from '../http/errors.js';
import { adjust } from '../wallet/service.js';
import { reconcileOneOrder } from '../payments/recharge.js';

const CURSOR_NS = '(extract(epoch FROM o.created_at) * 1000000)::bigint';

function decodeCursor(cursor) {
  const sep = cursor.lastIndexOf('~');
  const createdUs = sep > 0 ? Number(cursor.slice(0, sep)) : NaN;
  const id = sep > 0 ? cursor.slice(sep + 1) : '';
  if (!Number.isSafeInteger(createdUs) || createdUs < 0 || !id) {
    throw appError('VALIDATION_FAILED', undefined, { fields: { cursor: '格式不正确' } });
  }
  return [createdUs, id];
}

function serializeOrder(row) {
  return {
    id: row.id, userId: row.user_id,
    // 注销用户的 phone 是占位值，掩码列显示「已注销」（同 admin/users.js）
    phoneMasked: row.user_status === 'deactivated' ? '已注销' : maskPhone(row.phone),
    outTradeNo: row.out_trade_no, transactionId: row.transaction_id,
    amountFen: Number(row.amount_fen), refundedFen: Number(row.refunded_fen ?? 0),
    scene: row.scene, status: row.status,
    createdAt: row.created_at.toISOString(),
    paidAt: row.paid_at ? row.paid_at.toISOString() : null,
  };
}

/** 订单列表（§8.2）：status/userId/outTradeNo 精确过滤 + from/to（含，按创建时间，ISO 日期或时间戳）。 */
export async function listOrders(db, { status, userId, outTradeNo, from, to, cursor, limit }) {
  const values = [limit + 1];
  const conditions = [];
  if (status) { values.push(status); conditions.push(`o.status = $${values.length}`); }
  if (userId) { values.push(userId); conditions.push(`o.user_id = $${values.length}`); }
  if (outTradeNo) { values.push(outTradeNo); conditions.push(`o.out_trade_no = $${values.length}`); }
  if (from) {
    const date = new Date(from);
    if (Number.isNaN(date.getTime())) throw appError('VALIDATION_FAILED', undefined, { fields: { from: '日期格式不正确' } });
    values.push(date); conditions.push(`o.created_at >= $${values.length}`);
  }
  if (to) {
    const date = new Date(to);
    if (Number.isNaN(date.getTime())) throw appError('VALIDATION_FAILED', undefined, { fields: { to: '日期格式不正确' } });
    values.push(date); conditions.push(`o.created_at <= $${values.length}`);
  }
  if (cursor) {
    const [createdUs, id] = decodeCursor(cursor);
    values.push(createdUs, id);
    conditions.push(`(${CURSOR_NS}, o.id) < ($${values.length - 1}, $${values.length})`);
  }
  const { rows } = await db.query(
    `SELECT o.*, u.phone, u.status AS user_status, ${CURSOR_NS} AS created_us
       FROM payment_orders o JOIN users u ON u.id = o.user_id
      ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
      ORDER BY o.created_at DESC, o.id DESC LIMIT $1`,
    values,
  );
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return { items: page.map(serializeOrder), nextCursor: hasMore && last ? `${last.created_us}~${last.id}` : null };
}

/** 订单详情（§8.2：+ notifyCount / lastNotifyAt / ledgerId）。 */
export async function getOrder(db, { orderId }) {
  const { rows } = await db.query(
    `SELECT o.*, u.phone, u.status AS user_status FROM payment_orders o JOIN users u ON u.id = o.user_id WHERE o.id = $1`, [orderId]);
  if (!rows.length) throw appError('ORDER_NOT_FOUND');
  return {
    ...serializeOrder(rows[0]),
    notifyCount: rows[0].notify_count,
    lastNotifyAt: rows[0].last_notify_at ? rows[0].last_notify_at.toISOString() : null,
    ledgerId: rows[0].credited_ledger_id,
  };
}

/** 手动对账：立刻向微信查单并按结果更新（与定时对账 reconcileOneOrder 同一逻辑）。 */
export async function reconcileOrder(db, { orderId }, deps) {
  const { rows } = await db.query(`SELECT * FROM payment_orders WHERE id = $1`, [orderId]);
  if (!rows.length) throw appError('ORDER_NOT_FOUND');
  if (!deps.payClient) throw appError('PAYMENT_UNAVAILABLE', '支付未配置，无法对账');
  if (rows[0].status === 'created') {
    await reconcileOneOrder(db, rows[0], deps);
  }
  return getOrder(db, { orderId });
}

/**
 * 人工退款登记（记录式）：校验订单已支付、累计退款不超订单金额、用户可用余额足够；
 * 写一条 adjust 负数流水（title「充值退款」，ref=订单，reason/admin 落库）并累加 refunded_fen。
 * 幂等键直接用账本幂等（同键同参重放返回首次流水，同键不同参 409）；重放先于状态/金额校验
 * （refunded_fen 在首次执行已累加，重放时再查会误判超限）。读订单（FOR UPDATE）、重放探测、
 * 校验与写入全部在**同一事务**内完成——行锁覆盖整个判定过程，不留「锁了又放」的窗口。
 */
export async function refundOrder(db, { orderId, amountFen, reason, idempotencyKey, adminId }) {
  if (!Number.isSafeInteger(amountFen) || amountFen <= 0) {
    throw appError('VALIDATION_FAILED', '退款金额必须是非 0 的整数（分）');
  }
  return db.tx(async (t) => {
    const { rows } = await t.query(`SELECT * FROM payment_orders WHERE id = $1 FOR UPDATE`, [orderId]);
    const order = rows[0];
    if (!order) throw appError('ORDER_NOT_FOUND');
    // 幂等重放探测（口径同 wallet.withIdempotency：命中他人流水/参数不符交给它抛 409）
    const { rows: existing } = await t.query(
      `SELECT user_id, kind, amount_fen, ref_type, ref_id FROM ledger WHERE idempotency_key = $1`, [idempotencyKey]);
    const isReplay = existing.length > 0;

    if (!isReplay) {
      if (order.status !== 'paid') throw appError('ORDER_NOT_PAID');
      if (Number(order.refunded_fen) + amountFen > order.amount_fen) throw appError('REFUND_EXCEEDS_ORDER');
    }

    let result;
    try {
      result = await adjust(t, { userId: order.user_id, amountFen: -amountFen, title: '充值退款',
        refType: 'payment_order', refId: order.id, idempotencyKey, reason, adminId });
    } catch (err) {
      // 调整共用逻辑里余额不足是 ADJUST_EXCEEDS_BALANCE，退款场景按 §8.2 映射为 REFUND_EXCEEDS_BALANCE
      if (err?.code === 'ADJUST_EXCEEDS_BALANCE') throw appError('REFUND_EXCEEDS_BALANCE');
      throw err;
    }
    // 幂等重放时 refunded_fen 已在首次执行累加过，不能重复加
    if (!result.replayed) {
      const { rowCount } = await t.query(
        `UPDATE payment_orders SET refunded_fen = refunded_fen + $2, updated_at = now()
          WHERE id = $1 AND refunded_fen + $2 <= amount_fen`, [order.id, amountFen]);
      if (rowCount === 0) throw appError('REFUND_EXCEEDS_ORDER'); // 并发兜底（正常被前置校验挡住）
    }
    const updated = await t.query(`SELECT o.*, u.phone, u.status AS user_status FROM payment_orders o JOIN users u ON u.id = o.user_id
       WHERE o.id = $1`, [order.id]);
    const entry = {
      id: result.entry.id, kind: 'adjust', amountFen: result.entry.amount_fen, frozenDeltaFen: 0,
      title: result.entry.title, refType: 'payment_order', refId: order.id, reason,
      createdAt: result.entry.created_at.toISOString(),
    };
    return { order: serializeOrder(updated.rows[0]), entry };
  });
}
