// 运营后台·用户与余额业务逻辑（M3-ADM-02，docs/API.md §8.1）。
// 路由层只做校验与编排（同 api/admin.js 约定）；手机号一律掩码出参，只支持完整号码精确搜索；
// 余额调整走账本（wallet/service.js adjust）；停用删会话；注销不可恢复（匿名保留记录、删除媒体对象）。
import { maskPhone } from '../auth/sms.js';
import { getConsents } from '../auth/consents.js';
import { appError } from '../http/errors.js';
import { adjust } from '../wallet/service.js';

/** keyset 游标（口径与 wallet.listLedger 一致）：微秒时间戳~id，避免同毫秒整段跳过。 */
const CURSOR_NS = '(extract(epoch FROM created_at) * 1000000)::bigint';

function decodeCursor(cursor) {
  const sep = cursor.lastIndexOf('~');
  const createdUs = sep > 0 ? Number(cursor.slice(0, sep)) : NaN;
  const id = sep > 0 ? cursor.slice(sep + 1) : '';
  if (!Number.isSafeInteger(createdUs) || createdUs < 0 || !id) {
    throw appError('VALIDATION_FAILED', undefined, { fields: { cursor: '格式不正确' } });
  }
  return [createdUs, id];
}

function serializeUser(row) {
  return {
    id: row.id,
    // 注销账号的 phone 已改为占位值（非手机号），掩码列直接显示「已注销」
    phoneMasked: row.status === 'deactivated' ? '已注销' : maskPhone(row.phone),
    nickname: row.nickname,
    status: row.status,
    balanceFen: Number(row.balance_fen ?? 0),
    frozenFen: Number(row.frozen_fen ?? 0),
    createdAt: row.created_at.toISOString(),
    lastLoginAt: row.last_login_at ? row.last_login_at.toISOString() : null,
  };
}

/**
 * 用户列表（§8.1）：不带条件按注册时间倒序；phone/userId 为完整值精确匹配（不做模糊），
 * status 过滤。命中 0 行正常返回空列表（搜索行为本身在路由层记审计）。
 */
export async function listUsers(db, { phone, userId, status, cursor, limit }) {
  const values = [limit + 1];
  const conditions = [];
  if (phone) { values.push(phone); conditions.push(`u.phone = $${values.length}`); }
  if (userId) { values.push(userId); conditions.push(`u.id = $${values.length}`); }
  if (status) { values.push(status); conditions.push(`u.status = $${values.length}`); }
  if (cursor) {
    const [createdUs, id] = decodeCursor(cursor);
    values.push(createdUs, id);
    conditions.push(`(${CURSOR_NS}, u.id) < ($${values.length - 1}, $${values.length})`);
  }
  const { rows } = await db.query(
    `SELECT u.*, COALESCE(w.available_fen, 0) AS balance_fen, COALESCE(w.frozen_fen, 0) AS frozen_fen, ${CURSOR_NS} AS created_us
       FROM users u LEFT JOIN wallets w ON w.user_id = u.id
      ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
      ORDER BY u.created_at DESC, u.id DESC LIMIT $1`,
    values,
  );
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return { items: page.map(serializeUser), nextCursor: hasMore && last ? `${last.created_us}~${last.id}` : null };
}

/** 用户详情（§8.1 AdminUserDetail）：消费统计 + 同意记录 + 微信绑定。 */
export async function getUserDetail(db, { userId }) {
  const { rows } = await db.query(
    `SELECT u.*, COALESCE(w.available_fen, 0) AS balance_fen, COALESCE(w.frozen_fen, 0) AS frozen_fen
       FROM users u LEFT JOIN wallets w ON w.user_id = u.id WHERE u.id = $1`, [userId]);
  if (!rows.length) throw appError('USER_NOT_FOUND');
  const user = rows[0];
  const [stats] = (await db.query(
    `SELECT
       (SELECT count(*)::int FROM projects WHERE user_id = $1) AS projects,
       (SELECT count(*)::int FROM projects WHERE user_id = $1 AND status = 'delivered') AS delivered,
       (SELECT count(*)::int FROM characters WHERE user_id = $1 AND deleted_at IS NULL) AS characters,
       (SELECT COALESCE(SUM(amount_fen), 0)::bigint FROM ledger WHERE user_id = $1 AND kind IN ('recharge', 'redeem')) AS recharged_fen,
       (SELECT COALESCE(SUM(CASE WHEN kind = 'settle' THEN -frozen_delta_fen WHEN kind = 'charge' THEN -amount_fen ELSE 0 END), 0)::bigint
          FROM ledger WHERE user_id = $1) AS spent_fen`, [userId])).rows;
  const [consents, wechat] = await Promise.all([
    getConsents(db, userId),
    db.query(`SELECT 1 FROM user_wechat WHERE user_id = $1 LIMIT 1`, [userId]),
  ]);
  return {
    ...serializeUser(user),
    stats: {
      projects: stats.projects, delivered: stats.delivered, characters: stats.characters,
      rechargedFen: Number(stats.recharged_fen), spentFen: Number(stats.spent_fen),
    },
    consents: { terms: consents.terms, photo: consents.photo },
    wechatBound: wechat.rowCount > 0,
  };
}

/** 后台流水（§8.1 AdminLedgerItem）：比用户侧多 reason / adminUsername / ref；用户侧接口不含这些。 */
export async function listUserLedger(db, { userId, cursor, limit }) {
  const values = [userId, limit + 1];
  let where = 'l.user_id = $1';
  if (cursor) {
    const [createdUs, id] = decodeCursor(cursor);
    values.push(createdUs, id);
    where += ` AND ((extract(epoch FROM l.created_at) * 1000000)::bigint, l.id) < ($${values.length - 1}, $${values.length})`;
  }
  const { rows } = await db.query(
    `SELECT l.*, a.username AS admin_username,
            (extract(epoch FROM l.created_at) * 1000000)::bigint AS created_us
       FROM ledger l LEFT JOIN admin_users a ON a.id = l.admin_id
      WHERE ${where}
      ORDER BY l.created_at DESC, l.id DESC LIMIT $2`,
    values,
  );
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    items: page.map((row) => ({
      id: row.id, kind: row.kind, amountFen: Number(row.amount_fen), frozenDeltaFen: Number(row.frozen_delta_fen ?? 0),
      title: row.title, refType: row.ref_type, refId: row.ref_id,
      ...(row.reason ? { reason: row.reason } : {}),
      ...(row.admin_username ? { adminUsername: row.admin_username } : {}),
      createdAt: row.created_at.toISOString(),
    })),
    nextCursor: hasMore && last ? `${last.created_us}~${last.id}` : null,
  };
}

/** 客服调整余额：原因必填；返回 { wallet, entry }（entry 为 AdminLedgerItem）。 */
export async function adjustBalance(db, { userId, amountFen, reason, idempotencyKey, adminId }) {
  const detail = await getUserDetail(db, { userId }); // 不存在 → 404 USER_NOT_FOUND
  const { entry } = await db.tx((t) => adjust(t, { userId, amountFen, idempotencyKey, reason, adminId }));
  const { rows } = await db.query(`SELECT available_fen, frozen_fen FROM wallets WHERE user_id = $1`, [userId]);
  return {
    wallet: { availableFen: Number(rows[0].available_fen), frozenFen: Number(rows[0].frozen_fen) },
    entry: {
      id: entry.id, kind: entry.kind, amountFen: Number(entry.amount_fen), frozenDeltaFen: 0,
      title: entry.title, refType: null, refId: null, reason,
      createdAt: entry.created_at.toISOString(),
    },
    userNickname: detail.nickname,
  };
}

/** 停用：立即删除全部会话（在途作品由 Worker 继续跑完，与作品状态无关）。 */
export async function disableUser(db, { userId }) {
  const detail = await getUserDetail(db, { userId });
  if (detail.status === 'deactivated') throw appError('VALIDATION_FAILED', '该账号已注销，不能变更状态');
  const { rowCount } = await db.query(
    `UPDATE users SET status = 'disabled', updated_at = now() WHERE id = $1 AND status = 'active'`, [userId]);
  if (rowCount === 0) throw appError('VALIDATION_FAILED', '账号状态已变化，请刷新后重试');
  await db.query(`DELETE FROM sessions WHERE user_id = $1`, [userId]);
  return getUserDetail(db, { userId });
}

/** 启用：仅停用（disabled）可恢复；注销（deactivated）不可恢复。 */
export async function enableUser(db, { userId }) {
  const detail = await getUserDetail(db, { userId });
  if (detail.status === 'deactivated') throw appError('VALIDATION_FAILED', '已注销账号不能恢复使用');
  const { rowCount } = await db.query(
    `UPDATE users SET status = 'active', updated_at = now() WHERE id = $1 AND status = 'disabled'`, [userId]);
  if (rowCount === 0) throw appError('VALIDATION_FAILED', '账号状态已变化，请刷新后重试');
  return getUserDetail(db, { userId });
}

/** 注销前检查的在途作品状态（active + review 两组：未到终态都算在途）。 */
const IN_FLIGHT = ['understanding', 'story_review', 'casting', 'cast_review', 'rendering', 'composing', 'paused'];

/**
 * 注销（§8.1，不可恢复）：无在途作品（否则 409 USER_HAS_ACTIVE_PROJECTS）；剩余可用余额记一条
 * adjust 清零流水（原因必填）；删除全部会话与微信绑定；手机号改占位（原号可重新注册为新用户）；
 * 作品与角色记录匿名保留（清掉用户自由输入文本，AI 生成的片段剧情保留）；媒体对象（上传图片、
 * 形象图、片段视频/海报、成片/封面、头像）在**事务外**尽力删除（AGENTS §5：事务内不等上游/网络），
 * 失败只记日志，key 留在库里供排查（对象已删时 key 是惰性数据，签名链接访问只会 404）；
 * 账务流水与支付订单保留（法定保存）。重复调用按幂等返回当前状态。
 */
export async function deactivateUser(db, { userId, reason, adminId, storage, logger }) {
  const detail = await getUserDetail(db, { userId });
  if (detail.status === 'deactivated') return { user: detail, filesFailed: 0 };
  const { rows: inflight } = await db.query(
    `SELECT count(*)::int AS n FROM projects WHERE user_id = $1 AND status = ANY($2)`, [userId, IN_FLIGHT]);
  if (inflight[0].n > 0) throw appError('USER_HAS_ACTIVE_PROJECTS');

  const { rows: media } = await db.query(
    `SELECT storage_key AS key FROM uploads WHERE user_id = $1 AND storage_key IS NOT NULL
       UNION
     SELECT lv.image_key FROM look_versions lv
       JOIN character_looks cl ON cl.id = lv.look_id JOIN characters c ON c.id = cl.character_id
      WHERE c.user_id = $1 AND lv.image_key IS NOT NULL
       UNION
     SELECT st.video_key FROM segment_takes st JOIN segments sg ON sg.id = st.segment_id
       JOIN projects p ON p.id = sg.project_id WHERE p.user_id = $1 AND st.video_key IS NOT NULL
       UNION
     SELECT st.poster_key FROM segment_takes st JOIN segments sg ON sg.id = st.segment_id
       JOIN projects p ON p.id = sg.project_id WHERE p.user_id = $1 AND st.poster_key IS NOT NULL
       UNION
     SELECT r.video_key FROM renders r JOIN projects p ON p.id = r.project_id
      WHERE p.user_id = $1 AND r.video_key IS NOT NULL
       UNION
     SELECT r.cover_key FROM renders r JOIN projects p ON p.id = r.project_id
      WHERE p.user_id = $1 AND r.cover_key IS NOT NULL
       UNION
     SELECT u.avatar_key FROM users u WHERE u.id = $1 AND u.avatar_key IS NOT NULL`,
    [userId],
  );
  const keys = [...new Set(media.map((row) => row.key))];

  await db.tx(async (t) => {
    const { rows } = await t.query(
      `SELECT available_fen FROM wallets WHERE user_id = $1 FOR UPDATE`, [userId]);
    const available = Number(rows[0]?.available_fen ?? 0);
    if (available > 0) {
      await adjust(t, { userId, amountFen: -available, title: '客服调整',
        idempotencyKey: `deactivate:${userId}`, reason, adminId });
    }
    await t.query(
      `UPDATE users SET status = 'deactivated', phone = $2, nickname = '已注销用户', avatar_key = NULL, updated_at = now()
        WHERE id = $1`, [userId, `deactivated:${userId}`]);
    await t.query(`DELETE FROM sessions WHERE user_id = $1`, [userId]);
    await t.query(`DELETE FROM user_wechat WHERE user_id = $1`, [userId]);
    await t.query(`UPDATE projects SET title = '已注销作品', story_text = '（用户已注销，内容已删除）', updated_at = now()
       WHERE user_id = $1`, [userId]);
    await t.query(`UPDATE characters SET name = '已注销角色', description = '', tags = '{}', updated_at = now()
       WHERE user_id = $1`, [userId]);
  });

  let filesFailed = 0;
  if (keys.length) {
    try {
      await storage.remove(keys);
    } catch (err) {
      filesFailed = keys.length;
      logger?.warn?.('user_deactivate_remove_failed', { userId, count: keys.length,
        message: String(err?.message ?? err).slice(0, 200) });
    }
  }
  return { user: await getUserDetail(db, { userId }), filesFailed };
}
