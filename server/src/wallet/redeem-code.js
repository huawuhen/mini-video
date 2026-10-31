// 兑换码规范形式与哈希（M2-OPS-03 复审必改 2）：生成（scripts/redeem-create.js）与
// 兑换（wallet/service.js）两侧共用一套口径，杜绝「合法码因大小写/空格/横线/易混字符
// 被误判无效还烧尝试额度」。规范形式：MIV-XXXXX-XXXXX，字符集为 Crockford base32
// （生成端去 I L O U，见 ALPHABET）；输入端额外宽容 O→0、I/L→1（手机上口误/看错的
// 高频错字——映射不会破坏任何合法码，因为生成字符集不含这三个字母）。
import { createHash } from 'node:crypto';

export const REDEEM_CODE_PREFIX = 'MIV';
export const REDEEM_BODY_LENGTH = 10;
// Crockford base32（去 I L O U，避免手机上手抄/口误）
export const REDEEM_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * 规范化用户/运营输入：去所有空白（含全角空格）与横线（含全角长横线）→ 大写 →
 * 易混字符映射（只作用于前缀后的主体，避免把前缀 MIV 的 I 也换成 1）→
 * 按 MIV-XXXXX-XXXXX 重组横线。结构不合（长度/字符集不对）返回 null，
 * 由调用方按「兑换码无效」处理。
 */
export function normalizeRedeemCode(input) {
  if (typeof input !== 'string') return null;
  const compact = input.replace(/[\s\p{Zs}\p{Pd}-]+/gu, '').toUpperCase();
  if (!compact.startsWith(REDEEM_CODE_PREFIX)) return null;
  const body = compact.slice(REDEEM_CODE_PREFIX.length)
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  if (body.length !== REDEEM_BODY_LENGTH || ![...body].every((ch) => REDEEM_ALPHABET.includes(ch))) return null;
  return `${REDEEM_CODE_PREFIX}-${body.slice(0, 5)}-${body.slice(5)}`;
}

/** 统一哈希入口：规范化后 sha256（hex）。生成端产出的码即规范形式，历史码哈希不变。 */
export function redeemCodeHash(input) {
  const normalized = normalizeRedeemCode(input);
  if (!normalized) throw new Error('兑换码格式不正确（normalizeRedeemCode 返回 null）');
  return createHash('sha256').update(normalized).digest('hex');
}
