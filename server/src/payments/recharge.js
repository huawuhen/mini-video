// 充值订单服务与微信支付回调/对账（M3-PAY-02，docs/API.md §3.1、ARCHITECTURE「支付（M3）」）。
// 到账只由三处完成：支付通知（验签解密 + 查单核验后入账）、对账任务（补入账/关单）——
// 前端没有「确认已支付」接口；GET 只轮询。
// 带入 M3-PAY-01 审查建议 4：对用户只抛固定中文（PAYMENT_UNAVAILABLE 等），
// 上游原文只进日志。幂等口径：入账事务 = 条件 UPDATE(status IN created,expired) +
// 账本 recharge（幂等键 recharge:<orderId>），重复/并发通知只入账一次。
import { createHmac, timingSafeEqual } from 'node:crypto';
import { newId } from '../db/ids.js';
import { appError } from '../http/errors.js';
import { hitRateLimit } from '../auth/ratelimit.js';
import { recharge } from '../wallet/service.js';

/** 订单有效期（微信 time_expire 上限 2 小时；30 分钟给用户足够操作时间，过期由对账关单）。 */
export const ORDER_TTL_MS = 30 * 60 * 1000;
const MAX_ACTIVE_ORDERS = 3;      // 每用户同时待支付订单上限（API §3.1）
const CREATE_PER_HOUR = 10;       // 每用户每小时创建上限
const RECONCILE_GRACE_MS = 5 * 60 * 1000; // 过期后宽限：避免与在途通知竞争
const OAUTH_STATE_TTL_SECONDS = 600;

/** 回调处理失败：路由层转 HTTP 状态 + {"code":"FAIL"}（API §3.1 回调契约）。 */
export class NotifyFailure extends Error {
  constructor(httpStatus, message) {
    super(message);
    this.name = 'NotifyFailure';
    this.httpStatus = httpStatus;
  }
}

// ───────────── 充值选项 / 下单 / 查询 ─────────────

export function getRechargeOptions(db, { userId, scenes, mpAppid }, { amountsFen, maxAmountFen }) {
  return (async () => {
    let wechatOpenidReady = false;
    if (mpAppid) {
      const { rows } = await db.query(`SELECT 1 FROM user_wechat WHERE user_id = $1 AND appid = $2`,
        [userId, mpAppid]);
      wechatOpenidReady = rows.length > 0;
    }
    return { amountsFen, maxAmountFen, scenes, wechatOpenidReady };
  })();
}

/**
 * 创建充值订单。顺序刻意为「幂等查 → 限流 → 微信下单（事务外）→ INSERT」：
 * 微信下单失败不落任何 created 订单；并发同键以 (user_id, idempotency_key) 唯一索引兜底
 * （输掉的一方读回已有订单，微信侧多出的预付单 2 小时自动作废，无害）。
 */
export async function createRechargeOrder(db, { userId, amountFen, scene, idempotencyKey, clientIp }, deps) {
  const { payClient, scenes, config, logger, now = () => Date.now() } = deps;
  const amountsFen = config.payments.amountsFen;
  if (!payClient || !scenes.length) throw appError('PAYMENT_UNAVAILABLE', '在线充值暂不可用，可使用兑换码');
  if (!amountsFen.includes(amountFen)) {
    throw appError('VALIDATION_FAILED', undefined, { fields: { amountFen: '金额不在可选档位' } });
  }
  if (!scenes.includes(scene)) {
    throw appError('VALIDATION_FAILED', undefined, { fields: { scene: '该支付方式未开通' } });
  }
  const { rows: existing } = await db.query(
    `SELECT * FROM payment_orders WHERE user_id = $1 AND idempotency_key = $2`, [userId, idempotencyKey]);
  if (existing.length) return { replayed: true, order: existing[0] };

  await hitRateLimit(db, { key: `recharge:create:${userId}`, windowSeconds: 3_600, max: CREATE_PER_HOUR,
    message: `创建充值订单太频繁，一小时最多 ${CREATE_PER_HOUR} 笔` });
  const { rows: active } = await db.query(
    `SELECT count(*)::int AS n FROM payment_orders WHERE user_id = $1 AND status = 'created'`, [userId]);
  if (active[0].n >= MAX_ACTIVE_ORDERS) {
    throw appError('RATE_LIMITED', `待支付订单最多 ${MAX_ACTIVE_ORDERS} 笔，请先完成支付或等待过期`);
  }

  let openid = null;
  if (scene === 'jsapi') {
    // 复审必改 3：按当前公众号过滤——换服务号后旧 openid 不再拿来下单（options 与下单口径一致）
    const { rows } = await db.query(
      `SELECT openid FROM user_wechat WHERE user_id = $1 AND appid = $2`, [userId, deps.appid]);
    if (!rows.length) throw appError('WECHAT_OPENID_REQUIRED', '请在微信中完成授权后充值');
    openid = rows[0].openid;
  }

  const orderId = newId('po');
  const expiresAt = new Date(now() + ORDER_TTL_MS);
  const order = { description: '余额充值', outTradeNo: orderId, amountFen,
    notifyUrl: config.payments.notifyUrl, expiresAt };
  let providerData;
  try {
    if (scene === 'jsapi') {
      const r = await payClient.jsapi({ ...order, openid });
      providerData = { prepayId: r.prepayId };
    } else if (scene === 'h5') {
      const r = await payClient.h5({ ...order, clientIp: clientIp ?? '127.0.0.1' });
      providerData = { h5Url: r.h5Url };
    } else {
      const r = await payClient.native(order);
      providerData = { codeUrl: r.codeUrl };
    }
  } catch (err) {
    // 建议 4：固定中文给用户；上游错误码/原文只进日志
    logger?.warn?.('recharge_create_failed', { userId, scene, code: err?.code,
      message: String(err?.message ?? err).slice(0, 200) });
    throw appError('PAYMENT_UNAVAILABLE', '支付通道暂时不可用，请稍后重试');
  }

  try {
    await db.query(
      `INSERT INTO payment_orders (id, user_id, out_trade_no, amount_fen, scene, status, client_ip,
         expires_at, idempotency_key, provider_data)
       VALUES ($1, $2, $1, $3, $4, 'created', $5, $6, $7, $8)`,
      [orderId, userId, amountFen, scene, clientIp ?? null, expiresAt.toISOString(), idempotencyKey,
        JSON.stringify(providerData)]);
  } catch (err) {
    if (err?.code === '23505') { // 幂等竞争：另一并发请求先落库
      const { rows } = await db.query(
        `SELECT * FROM payment_orders WHERE user_id = $1 AND idempotency_key = $2`, [userId, idempotencyKey]);
      if (rows.length) return { replayed: true, order: rows[0] };
    }
    throw err;
  }
  const { rows } = await db.query(`SELECT * FROM payment_orders WHERE id = $1`, [orderId]);
  return { replayed: false, order: rows[0] };
}

/** RechargeOrder 序列化（API §3.1）：pay 仅 created 返回（jsapi 的 paySign 每次现算，参数永新鲜）。 */
export function serializeOrder(row, { payClient } = {}) {
  const pay = row.status === 'created' ? buildPay(row, payClient) : undefined;
  return {
    id: row.id, status: row.status, amountFen: row.amount_fen, scene: row.scene,
    createdAt: row.created_at.toISOString(), expiresAt: row.expires_at.toISOString(),
    ...(row.paid_at ? { paidAt: row.paid_at.toISOString() } : {}),
    ...(pay ? { pay } : {}),
  };
}

function buildPay(row, payClient) {
  const data = row.provider_data ?? {};
  if (row.scene === 'jsapi') {
    if (!data.prepayId || !payClient) return undefined;
    return { type: 'jsapi', params: payClient.jsapiPayParams(data.prepayId) };
  }
  if (row.scene === 'h5') return data.h5Url ? { type: 'h5', url: data.h5Url } : undefined;
  if (row.scene === 'native') return data.codeUrl ? { type: 'native', codeUrl: data.codeUrl } : undefined;
  return undefined;
}

/** GET 轮询的主动查单节流（进程内 Map；多实例各自节流，总量仍是每单每 10 秒至多 N 实例次）。 */
const pollQueryAt = new Map(); // orderId → last query ms

export async function getRechargeOrder(db, { userId, orderId }, deps) {
  if (typeof orderId !== 'string' || !orderId.startsWith('po_')) throw appError('NOT_FOUND');
  let { rows } = await db.query(
    `SELECT * FROM payment_orders WHERE id = $1 AND user_id = $2`, [orderId, userId]);
  if (!rows.length) throw appError('NOT_FOUND');
  let row = rows[0];
  // 建议 7：结果页轮询兜底——回调延迟/丢失时，created 且下单已 >10s 的单节流地主动查一次
  //（每单每 10 秒最多一次），已支付就地入账，用户不必等 ~35 分钟后的对账
  if (row.status === 'created' && deps.payClient && Date.now() - row.created_at.getTime() > 10_000) {
    const last = pollQueryAt.get(orderId) ?? 0;
    if (Date.now() - last > 10_000) {
      pollQueryAt.set(orderId, Date.now());
      if (pollQueryAt.size > 10_000) { // 防泄漏：清掉老记录（长期未轮询的订单）
        for (const [key, ts] of pollQueryAt) {
          if (Date.now() - ts > 600_000) pollQueryAt.delete(key);
        }
      }
      try {
        const remote = await deps.payClient.query(row.out_trade_no);
        if (remote.trade_state === 'SUCCESS' && remote.amount?.total === row.amount_fen) {
          await creditPaidOrder(db, { order: row, transactionId: remote.transaction_id,
            payerOpenid: remote.payer?.openid, notify: { eventType: 'poll-query', tradeState: 'SUCCESS' } });
          ({ rows } = await db.query(
            `SELECT * FROM payment_orders WHERE id = $1 AND user_id = $2`, [orderId, userId]));
          row = rows[0];
        }
      } catch { /* 查单失败：本次仍按 created 返回，等回调/对账 */ }
    }
  }
  const serialized = serializeOrder(row, deps);
  if (row.status === 'paid') {
    const { rows: wallet } = await db.query(
      `SELECT available_fen, frozen_fen FROM wallets WHERE user_id = $1`, [userId]);
    if (wallet.length) serialized.wallet = { availableFen: wallet[0].available_fen, frozenFen: wallet[0].frozen_fen };
  }
  return serialized;
}

export async function listRechargeOrders(db, { userId, cursor, limit }) {
  const values = [userId, limit + 1];
  let where = 'user_id = $1';
  if (cursor) {
    const sep = cursor.lastIndexOf('~');
    const createdUs = sep > 0 ? Number(cursor.slice(0, sep)) : NaN;
    const id = sep > 0 ? cursor.slice(sep + 1) : '';
    if (!Number.isSafeInteger(createdUs) || createdUs < 0 || !id) {
      throw appError('VALIDATION_FAILED', undefined, { fields: { cursor: '格式不正确' } });
    }
    values.push(createdUs, id);
    where += ` AND ((extract(epoch FROM created_at) * 1000000)::bigint, id) < ($3, $4)`;
  }
  const { rows } = await db.query(
    `SELECT *, (extract(epoch FROM created_at) * 1000000)::bigint AS created_us
       FROM payment_orders WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT $2`, values);
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    items: page.map((row) => serializeOrder(row)),
    nextCursor: hasMore && last ? `${last.created_us}~${last.id}` : null,
  };
}

// ───────────── 入账（通知与对账共用） ─────────────

/** 条件置 paid + 账本 recharge（幂等键 recharge:<orderId>）同事务；命中 0 行返回 false（重复/已终态）。
 * notify_count 对重放/并发通知同样累加（收到即计数，与是否入账无关）。 */
async function creditPaidOrder(db, { order, transactionId, payerOpenid, notify }) {
  return db.tx(async (t) => {
    await t.query(
      `UPDATE payment_orders SET notify_count = notify_count + 1, last_notify = $2, updated_at = now()
        WHERE id = $1 AND status IN ('created', 'expired', 'paid')`,
      [order.id, JSON.stringify(notify ?? {})]); // 只记事件口径，不含签名/openid 明文
    const { rows } = await t.query(
      `UPDATE payment_orders SET status = 'paid', paid_at = now(), transaction_id = COALESCE($2, transaction_id),
          payer_openid = COALESCE($3, payer_openid), updated_at = now()
        WHERE id = $1 AND status IN ('created', 'expired') RETURNING user_id`,
      [order.id, transactionId ?? null, payerOpenid ?? null]);
    if (!rows.length) return false;
    const entry = await recharge(t, { userId: order.user_id, amountFen: order.amount_fen,
      idempotencyKey: `recharge:${order.id}`, refId: order.id });
    await t.query(`UPDATE payment_orders SET credited_ledger_id = $2 WHERE id = $1`, [order.id, entry.entry.id]);
    return true;
  });
}

/**
 * 微信支付回调（API §3.1）：验签解密 → mchid/appid/金额核对 → 查单核验 → 入账。
 * 不入账但通知本身合法的场景（非 SUCCESS 事件、查单未支付）返回 success，避免微信重试轰炸；
 * 验签失败/解密失败/身份或金额不符抛 NotifyFailure（4XX，微信按失败重试）。
 */
export async function handleWechatNotify(db, { headers, rawBody }, deps) {
  const { payClient, config, logger } = deps;
  if (!payClient) throw new NotifyFailure(503, '支付未配置');
  let parsed;
  try {
    parsed = payClient.verifyAndDecryptNotify({ headers, rawBody });
  } catch (err) {
    logger?.warn?.('notify_verify_failed', { code: err?.code, message: String(err?.message ?? err).slice(0, 200) });
    throw new NotifyFailure(400, '验签失败');
  }
  const tx = parsed.decrypted;
  if (parsed.event_type !== 'TRANSACTION.SUCCESS') {
    await recordNotify(db, tx?.out_trade_no, { eventType: parsed.event_type, tradeState: tx?.trade_state });
    return { ok: true, credited: false };
  }
  if (tx.mchid !== config.payments.mchid || tx.appid !== deps.appid) {
    logger?.error?.('notify_identity_mismatch', { outTradeNo: tx.out_trade_no });
    throw new NotifyFailure(400, '商户或应用身份不符');
  }
  const { rows } = await db.query(`SELECT * FROM payment_orders WHERE out_trade_no = $1`, [tx.out_trade_no]);
  const order = rows[0];
  if (!order) throw new NotifyFailure(400, '订单不存在');
  if (tx.amount?.total !== order.amount_fen) {
    logger?.error?.('notify_amount_mismatch', { orderId: order.id,
      notifyTotal: tx.amount?.total, orderFen: order.amount_fen });
    throw new NotifyFailure(400, '金额不符');
  }
  // 查单核验（API §3.1：到账只由通知 + 主动查单核验完成）
  let remote;
  try {
    remote = await payClient.query(order.out_trade_no);
  } catch (err) {
    logger?.warn?.('notify_query_failed', { orderId: order.id, code: err?.code,
      message: String(err?.message ?? err).slice(0, 200) });
    throw new NotifyFailure(502, '查单暂时不可用'); // 微信会重试通知
  }
  if (remote.trade_state !== 'SUCCESS' || remote.amount?.total !== order.amount_fen) {
    await recordNotify(db, order.id, { eventType: parsed.event_type, tradeState: remote.trade_state });
    return { ok: true, credited: false, remoteState: remote.trade_state };
  }
  const credited = await creditPaidOrder(db, { order, transactionId: tx.transaction_id,
    payerOpenid: tx.payer?.openid, notify: { eventType: parsed.event_type, tradeState: 'SUCCESS',
    transactionId: tx.transaction_id } });
  return { ok: true, credited };
}

async function recordNotify(db, orderId, notify) {
  if (!orderId) return;
  await db.query(
    `UPDATE payment_orders SET notify_count = notify_count + 1, last_notify = $2, updated_at = now()
      WHERE id = $1`, [orderId, JSON.stringify(notify ?? {})]);
}

// ───────────── 对账任务（payments.reconcile） ─────────────

/** 过期 +5 分钟仍 created 的订单：查单已支付 → 补入账；否则微信关单 + 本地置 expired。 */
export async function runPaymentsReconcile(db, deps) {
  const { payClient, config, logger } = deps;
  if (!payClient) return { skipped: true, scanned: 0, credited: 0, closed: 0 };
  const { rows } = await db.query(
    `SELECT * FROM payment_orders WHERE status = 'created' AND expires_at < now() - make_interval(secs => $1)
      ORDER BY expires_at LIMIT 100`, [RECONCILE_GRACE_MS / 1000]);
  let credited = 0;
  let closed = 0;
  for (const order of rows) {
    try {
      const remote = await payClient.query(order.out_trade_no);
      if (remote.trade_state === 'SUCCESS' && remote.amount?.total === order.amount_fen) {
        if (await creditPaidOrder(db, { order, transactionId: remote.transaction_id,
          payerOpenid: remote.payer?.openid, notify: { eventType: 'reconcile', tradeState: 'SUCCESS' } })) {
          credited += 1;
          logger?.info?.('reconcile_credited', { orderId: order.id });
        }
      } else {
        // 建议 6：关单失败若是「订单已支付」类错误（查单与关单之间用户恰好付款），
        // 保持 created 等下一轮对账（后续通知或下轮查单会入账）；其他错误也不置 expired
        let closeRejected = false;
        try {
          await payClient.close(order.out_trade_no);
        } catch (err) {
          closeRejected = true;
          logger?.warn?.('reconcile_close_failed', { orderId: order.id, code: err?.code,
            message: String(err?.message ?? err).slice(0, 200) });
        }
        if (!closeRejected) {
          const { rowCount } = await db.query(
            `UPDATE payment_orders SET status = 'expired', updated_at = now() WHERE id = $1 AND status = 'created'`,
            [order.id]);
          if (rowCount) closed += 1;
        }
      }
    } catch (err) {
      logger?.warn?.('reconcile_order_failed', { orderId: order.id, code: err?.code,
        message: String(err?.message ?? err).slice(0, 200) });
    }
  }
  return { skipped: false, scanned: rows.length, credited, closed };
}

// ───────────── 公众号静默授权（OAuth） ─────────────

/** returnTo 只允许站内相对路径（/ 开头、非协议相对 //、无反斜杠），缺省回钱包页。 */
export function safeReturnTo(value) {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') && !value.includes('\\')
    ? value : '/wallet';
}

/** state 签名密钥：从 APIv3 密钥派生（建议 5：一把密钥一种用途，避免 apiV3Key 直接双用途）。 */
const oauthStateKey = (apiV3Key) => createHmac('sha256', apiV3Key).update('oauth-state').digest();

/** 无状态签名 state：`ts.returnTo(base64url).HMAC(派生密钥, userId.ts.returnTo)`——防 CSRF 且不落存储。 */
export function buildOauthState({ userId, returnTo }, { apiV3Key, now = () => Date.now() }) {
  const ts = Math.floor(now() / 1000);
  const ret = Buffer.from(returnTo, 'utf8').toString('base64url');
  const mac = createHmac('sha256', oauthStateKey(apiV3Key)).update(`${userId}.${ts}.${returnTo}`).digest('base64url');
  return `${ts}.${ret}.${mac}`;
}

export function verifyOauthState(state, { userId }, { apiV3Key, now = () => Date.now() }) {
  const parts = typeof state === 'string' ? state.split('.') : [];
  if (parts.length !== 3) return null;
  const [tsRaw, ret, mac] = parts;
  const ts = Number(tsRaw);
  if (!Number.isSafeInteger(ts) || Math.abs(Math.floor(now() / 1000) - ts) > OAUTH_STATE_TTL_SECONDS) return null;
  let returnTo;
  try { returnTo = Buffer.from(ret, 'base64url').toString('utf8'); } catch { return null; }
  const expected = createHmac('sha256', oauthStateKey(apiV3Key)).update(`${userId}.${tsRaw}.${returnTo}`).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return safeReturnTo(returnTo);
}

/** code 换 openid 并绑定当前用户（每用户一条 upsert；同一微信可绑多个账号——
 * openid 只用于付款、不是账号身份，复审必改 1 已去掉 UNIQUE(appid, openid)）。
 * 换 code 失败抛错由回调路由统一 302 处理（原因只进日志，不给用户看 JSON）。 */
export async function bindWechatOpenid(db, { oauth, code, userId }) {
  const { openid } = await oauth.openidByCode(code);
  await db.query(
    `INSERT INTO user_wechat (user_id, appid, openid) VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO UPDATE SET appid = $2, openid = $3`,
    [userId, oauth.appid, openid]);
  return { openid };
}
