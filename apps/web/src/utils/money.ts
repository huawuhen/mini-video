/** 分 → 元字符串（两位小数）。金额全程使用整数分，只在展示时转换。 */
export function formatFen(fen: number): string {
  const sign = fen < 0 ? '-' : '';
  const abs = Math.abs(Math.trunc(fen));
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}
