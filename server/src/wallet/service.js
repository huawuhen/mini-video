// 钱包账本（docs/API.md §3、ARCHITECTURE §3）。
// 金额一律整数「分」，禁止浮点。所有写操作接收调用方的事务作用域 t（§6 M1-BE-02 要点 a），
// 余额用带条件的 UPDATE 原子增减，影响 0 行即拒绝；每笔流水带 idempotency_key（唯一）：
// 同键重放返回首次结果，同键不同参数 409 IDEMPOTENCY_CONFLICT。
import { createHash } from 'node:crypto';
import { newId } from '../db/ids.js';
import { appError } from '../http/errors.js';

export const redeemCodeHash = (code) => createHash('sha256').update(code).digest('hex');

/** amountFen 为对可用余额的变化（扣减为负），frozenDeltaFen 为对冻结金额的变化。 */
async function insertLedger(t, { userId, kind, amountFen, frozenDeltaFen, title, refType, refId, idempotencyKey }) {
  const { rows } = await t.query(
    `INSERT INTO ledger (id, user_id, kind, amount_fen, frozen_delta_fen, title, ref_type, ref_id, idempotency_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id, kind, amount_fen, title, created_at`,
    [newId('led'), userId, kind, amountFen, frozenDeltaFen, title, refType, refId, idempotencyKey],
  );
  return rows[0];
}

/**
 * 幂等包装：先锁幂等键再查首次流水。命中时按 expect（snake 列名 → 期望值，undefined 字段跳过）
 * 逐项比对，不一致抛 409；一致返回首次结果，不再执行 fn。
 */
async function withIdempotency(t, { idempotencyKey, expect }, fn) {
  await t.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`miv:wallet:${idempotencyKey}`]);
  const { rows } = await t.query(
    `SELECT id, kind, amount_fen, title, ref_type, ref_id, created_at FROM ledger WHERE idempotency_key = $1`,
    [idempotencyKey],
  );
  if (rows.length) {
    const first = rows[0];
    for (const [column, expected] of Object.entries(expect)) {
      if (expected !== undefined && first[column] !== expected) throw appError('IDEMPOTENCY_CONFLICT');
    }
    return { replayed: true, entry: first };
  }
  return fn();
}

/** 预占：可用 → 冻结。余额不足 402 INSUFFICIENT_BALANCE。 */
export async function reserve(t, { userId, amountFen, refType, refId, idempotencyKey, title }) {
  const result = await withIdempotency(
    t,
    { idempotencyKey, expect: { kind: 'reserve', amount_fen: -amountFen, ref_type: refType, ref_id: refId } },
    async () => {
      const { rowCount } = await t.query(
        `UPDATE wallets SET available_fen = available_fen - $2, frozen_fen = frozen_fen + $2, updated_at = now()
          WHERE user_id = $1 AND available_fen >= $2`,
        [userId, amountFen],
      );
      if (rowCount === 0) throw appError('INSUFFICIENT_BALANCE');
      const entry = await insertLedger(t, { userId, kind: 'reserve', amountFen: -amountFen, frozenDeltaFen: amountFen, title, refType, refId, idempotencyKey });
      return { replayed: false, entry };
    },
  );
  return { ...result, amountFen: result.entry.amount_fen };
}

/** 结算：冻结 → 扣除。冻结不足属调用方状态错误，按 500 兜底暴露。 */
export async function settle(t, { userId, amountFen, refType, refId, idempotencyKey, title }) {
  const result = await withIdempotency(
    t,
    { idempotencyKey, expect: { kind: 'settle', amount_fen: 0, ref_type: refType, ref_id: refId } },
    async () => {
      const { rowCount } = await t.query(
        `UPDATE wallets SET frozen_fen = frozen_fen - $2, updated_at = now()
          WHERE user_id = $1 AND frozen_fen >= $2`,
        [userId, amountFen],
      );
      if (rowCount === 0) throw appError('INTERNAL', '冻结金额不足，无法结算');
      const entry = await insertLedger(t, { userId, kind: 'settle', amountFen: 0, frozenDeltaFen: -amountFen, title, refType, refId, idempotencyKey });
      return { replayed: false, entry };
    },
  );
  return { ...result, amountFen: result.entry.amount_fen };
}

/** 退回：冻结 → 可用。失败退回与取消退回共用。 */
export async function refund(t, { userId, amountFen, refType, refId, idempotencyKey, title }) {
  const result = await withIdempotency(
    t,
    { idempotencyKey, expect: { kind: 'refund', amount_fen: amountFen, ref_type: refType, ref_id: refId } },
    async () => {
      const { rowCount } = await t.query(
        `UPDATE wallets SET available_fen = available_fen + $2, frozen_fen = frozen_fen - $2, updated_at = now()
          WHERE user_id = $1 AND frozen_fen >= $2`,
        [userId, amountFen],
      );
      if (rowCount === 0) throw appError('INTERNAL', '冻结金额不足，无法退回');
      const entry = await insertLedger(t, { userId, kind: 'refund', amountFen, frozenDeltaFen: -amountFen, title, refType, refId, idempotencyKey });
      return { replayed: false, entry };
    },
  );
  return { ...result, amountFen: result.entry.amount_fen };
}

/** 直接扣费：从可用余额扣除（不走冻结）。余额不足 402。 */
export async function charge(t, { userId, amountFen, refType, refId, idempotencyKey, title }) {
  const result = await withIdempotency(
    t,
    { idempotencyKey, expect: { kind: 'charge', amount_fen: -amountFen, ref_type: refType, ref_id: refId } },
    async () => {
      const { rowCount } = await t.query(
        `UPDATE wallets SET available_fen = available_fen - $2, updated_at = now()
          WHERE user_id = $1 AND available_fen >= $2`,
        [userId, amountFen],
      );
      if (rowCount === 0) throw appError('INSUFFICIENT_BALANCE');
      const entry = await insertLedger(t, { userId, kind: 'charge', amountFen: -amountFen, frozenDeltaFen: 0, title, refType, refId, idempotencyKey });
      return { replayed: false, entry };
    },
  );
  return { ...result, amountFen: result.entry.amount_fen };
}

/** 兑换码充值：码只存哈希；used_by IS NULL 条件更新防并发重复兑换。 */
export async function redeem(t, { userId, code, idempotencyKey }) {
  const hash = redeemCodeHash(code);
  const result = await withIdempotency(
    t,
    { idempotencyKey, expect: { kind: 'redeem', ref_type: 'redeem_code', ref_id: hash } },
    async () => {
      const { rows } = await t.query(
        `UPDATE redeem_codes SET used_by = $1, used_at = now()
          WHERE code_hash = $2 AND used_by IS NULL AND (expires_at IS NULL OR expires_at > now())
          RETURNING amount_fen`,
        [userId, hash],
      );
      if (!rows.length) throw appError('VALIDATION_FAILED', '兑换码无效或已被使用');
      await t.query(
        `UPDATE wallets SET available_fen = available_fen + $2, updated_at = now() WHERE user_id = $1`,
        [userId, rows[0].amount_fen],
      );
      const entry = await insertLedger(t, { userId, kind: 'redeem', amountFen: rows[0].amount_fen, frozenDeltaFen: 0, title: '兑换码充值', refType: 'redeem_code', refId: hash, idempotencyKey });
      return { replayed: false, entry };
    },
  );
  return { ...result, amountFen: result.entry.amount_fen };
}

export async function getWallet(db, userId) {
  await db.query(`INSERT INTO wallets (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`, [userId]);
  const { rows } = await db.query(`SELECT available_fen, frozen_fen FROM wallets WHERE user_id = $1`, [userId]);
  return { availableFen: rows[0].available_fen, frozenFen: rows[0].frozen_fen };
}

function serializeEntry(row) {
  return { id: row.id, kind: row.kind, amountFen: row.amount_fen, title: row.title, createdAt: row.created_at.toISOString() };
}

/** 流水分页：keyset（created_at DESC, id DESC），cursor 为 `ISO~led_xxx`。 */
export async function listLedger(db, { userId, cursor, limit }) {
  const values = [userId, limit + 1];
  let where = 'user_id = $1';
  if (cursor) {
    const sep = cursor.lastIndexOf('~');
    const createdAt = sep > 0 ? new Date(cursor.slice(0, sep)) : null;
    const id = sep > 0 ? cursor.slice(sep + 1) : '';
    if (!createdAt || Number.isNaN(createdAt.getTime()) || !id) throw appError('VALIDATION_FAILED', undefined, { fields: { cursor: '格式不正确' } });
    values.push(createdAt, id);
    where += ' AND (created_at, id) < ($3, $4)';
  }
  const { rows } = await db.query(
    `SELECT id, kind, amount_fen, title, created_at FROM ledger WHERE ${where}
      ORDER BY created_at DESC, id DESC LIMIT $2`,
    values,
  );
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit).map(serializeEntry);
  const last = items.at(-1);
  return { items, nextCursor: hasMore && last ? `${last.createdAt}~${last.id}` : null };
}
