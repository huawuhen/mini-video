const DAY = 86_400_000;

/** 距到期还有几天（向上取整，已过期为 0）。 */
export function daysLeft(iso: string, now = Date.now()): number {
  return Math.max(0, Math.ceil((Date.parse(iso) - now) / DAY));
}
export const formatDate = (iso: string) => new Date(iso).toLocaleDateString('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric' });
export const formatDateTime = (iso: string) => new Date(iso).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
