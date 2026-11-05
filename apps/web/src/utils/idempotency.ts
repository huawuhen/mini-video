/**
 * 幂等键生成（复审必改①）：crypto.randomUUID 只在 HTTPS / localhost 安全上下文可用，
 * 局域网 http 预览下是 undefined——不可用时用 getRandomValues 兜底拼一个 UUID v4 形态的字符串。
 */
export function newIdempotencyKey(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  if (!c || typeof c.getRandomValues !== 'function') {
    // 极端环境（无 Web Crypto）：退化为时间戳 + Math.random，仍保证单客户端内不重复
    return `idem-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  }
  const bytes = c.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10x
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
