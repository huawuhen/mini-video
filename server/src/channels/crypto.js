// 渠道凭证加密（ARCHITECTURE §5.5）：AES-256-GCM，主密钥来自环境变量 CHANNEL_SECRET_KEY（32 字节）。
// 密文格式 `v1:<iv hex>:<authTag hex>:<cipher hex>`；任何接口不回传明文，只返回后 4 位掩码。
// 日志脱敏由 logger 的 SECRET_KEYS 兜底；凭证字段名（credential）不进任何日志。
import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';

const KEY_LENGTH = 32;

/** 校验/派生主密钥：CHANNEL_SECRET_KEY 至少 32 字节；长于 32 用 scrypt 派生固定长度密钥。 */
export function deriveSecretKey(secretKey) {
  if (!secretKey || typeof secretKey !== 'string') {
    throw new Error('缺少 CHANNEL_SECRET_KEY（渠道凭证主密钥，至少 32 字节）');
  }
  if (secretKey.length < 32) throw new Error('CHANNEL_SECRET_KEY 至少 32 字节');
  if (Buffer.byteLength(secretKey) === KEY_LENGTH) return Buffer.from(secretKey);
  return scryptSync(secretKey, 'miv-channel-secret-v1', KEY_LENGTH);
}

/** 加密渠道凭证；返回 `v1:<iv>:<tag>:<cipher>`。 */
export function encryptCredential(secretKey, plaintext) {
  const key = deriveSecretKey(secretKey);
  if (typeof plaintext !== 'string' || !plaintext) throw new Error('渠道凭证不能为空');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return `v1:${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${encrypted.toString('hex')}`;
}

/** 解密；格式不合法或解密失败抛错（凭证从此只来自数据库密文）。 */
export function decryptCredential(secretKey, payload) {
  const key = deriveSecretKey(secretKey);
  const match = /^v1:([0-9a-f]{24}):([0-9a-f]{32}):([0-9a-f]+)$/.exec(String(payload ?? ''));
  if (!match) throw new Error('渠道凭证密文格式不合法');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(match[1], 'hex'));
  decipher.setAuthTag(Buffer.from(match[2], 'hex'));
  try {
    return Buffer.concat([decipher.update(Buffer.from(match[3], 'hex')), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('渠道凭证解密失败（CHANNEL_SECRET_KEY 与加密时不一致？）');
  }
}

/** 接口回传用掩码：只给后 4 位。 */
export function credentialMask(credential) {
  const text = String(credential ?? '');
  return text.length <= 4 ? '****' : `****${text.slice(-4)}`;
}

/** 管理员口令哈希（scrypt）：<hex salt>$<hex hash>；校验用 timingSafeEqual 防时序侧信道。 */
export function hashAdminPassword(password) {
  if (typeof password !== 'string' || password.length < 12) {
    throw new Error('管理员密码至少 12 位');
  }
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32);
  return `${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyAdminPassword(passwordHash, password) {
  const [saltHex, hashHex] = String(passwordHash ?? '').split('$');
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(String(password ?? ''), Buffer.from(saltHex, 'hex'), expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** 管理员会话令牌：返回 { token（只出现一次）, tokenHash（入库） }。 */
export function newAdminSessionToken() {
  const token = randomBytes(32).toString('base64url');
  return { token, tokenHash: createHash('sha256').update(token).digest('hex') };
}
