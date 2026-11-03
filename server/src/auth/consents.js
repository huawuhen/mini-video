// 用户同意记录（M3-LEGAL-01，API.md §1「同意记录」）：只追加、不覆盖。
// 「当前是否已同意」= 该 kind 最新一条 version 是否等于服务端当前版本。
import { newId } from '../db/ids.js';
import { appError } from '../http/errors.js';

// ⚠️ 版本号与三处保持同步：docs/legal/*.md 头部的版本行、前端常量
//（apps/web/src/utils/legal.ts 的 TERMS_VERSION / PHOTO_CONSENT_VERSION）。
// 协议正文变更时：先由 Lead 更新 docs/legal/*.md，再同步改这里与前端常量。
export const TERMS_VERSION = 'terms-v1';
export const PHOTO_CONSENT_VERSION = 'photo-v1';

/** 追加一条同意记录（每次同意都新增，不更新历史）。 */
export async function recordConsent(t, { userId, kind, version, ip }) {
  await t.query(
    `INSERT INTO user_consents (id, user_id, kind, version, ip) VALUES ($1, $2, $3, $4, $5)`,
    [newId('cns'), userId, kind, version, ip ?? null],
  );
}

/** 各 kind 最新一条的版本 + 服务端当前版本（API.md §1：`current` 供前端判断是否需再同意——
 * 前端不得自带版本常量，避免与服务端/正文三处不同步，M3-LEGAL-01 复审必改④）。 */
export async function getConsents(db, userId) {
  const { rows } = await db.query(
    `SELECT DISTINCT ON (kind) kind, version FROM user_consents
      WHERE user_id = $1 ORDER BY kind, created_at DESC, id DESC`, [userId]);
  const found = Object.fromEntries(rows.map((r) => [r.kind, r.version]));
  return { terms: found.terms ?? null, photo: found.photo ?? null,
    current: { terms: TERMS_VERSION, photo: PHOTO_CONSENT_VERSION } };
}

/** 照片同意写入（POST /me/consents）：版本必须等于服务端当前版本。 */
export async function consentPhoto(db, { userId, version, ip }) {
  if (version !== PHOTO_CONSENT_VERSION) {
    throw appError('VALIDATION_FAILED', '同意版本已更新，请重新阅读后同意');
  }
  await db.tx((t) => recordConsent(t, { userId, kind: 'photo', version, ip }));
  return getConsents(db, userId);
}
