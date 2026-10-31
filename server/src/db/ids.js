import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
const PREFIXES = new Set(['usr', 'chr', 'cph', 'look', 'lkv', 'vc', 'upl', 'prj', 'cast', 'seg', 'take', 'rnd', 'qt', 'led', 'gt', 'sku', 'tm', 'pch', 'adm', 'po']);

const LENGTH = 16;

/** 带前缀的随机 ID（docs/API.md §0），如 prj_k3x9…，16 位 base36，约 82 bit 熵。 */
export function newId(prefix) {
  if (!PREFIXES.has(prefix)) throw new Error(`未登记的 ID 前缀：${prefix}`);
  let out = '';
  while (out.length < LENGTH) {
    for (const b of randomBytes(LENGTH)) {
      if (b >= 252) continue; // 252 = 36×7，丢弃余数部分避免取模偏差
      out += ALPHABET[b % 36];
      if (out.length === LENGTH) break;
    }
  }
  return `${prefix}_${out}`;
}
