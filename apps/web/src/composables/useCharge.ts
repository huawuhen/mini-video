import { showConfirmDialog } from 'vant';
import { useRoute, useRouter } from 'vue-router';
import { api, type Quote, type QuoteRequest } from '@/api';
import { useWalletStore } from '@/stores/wallet';
import { formatFen } from '@/utils/money';

/**
 * 所有收费操作的统一入口（docs/UI.md §8）：取报价 → 弹窗展示明细、合计与余额 → 用户确认后返回报价。
 * 余额不足时引导去钱包（充值后可返回原页面）；用户取消返回 null。调用方拿到报价后再带 quoteId 提交。
 */
export function useCharge() {
  const router = useRouter();
  const route = useRoute();
  const walletStore = useWalletStore();

  async function confirmCharge(request: QuoteRequest, title: string, confirmText = '确认并开始'): Promise<Quote | null> {
    const [quote, wallet] = await Promise.all([api.quote(request), walletStore.refresh()]);
    const lines = quote.breakdown.map((b) => `${b.label}：¥${formatFen(b.amountFen)}`).join('\n');
    const enough = wallet.availableFen >= quote.amountFen;
    try {
      await showConfirmDialog({
        title,
        message: `${lines}\n\n合计 ¥${formatFen(quote.amountFen)}\n当前余额 ¥${formatFen(wallet.availableFen)}${enough ? '' : '（余额不足）'}`,
        confirmButtonText: enough ? confirmText : '去充值',
        messageAlign: 'left',
      });
    } catch {
      return null;
    }
    if (!enough) { await router.push({ path: '/wallet', query: { back: route.fullPath } }); return null; }
    return quote;
  }
  return { confirmCharge };
}
