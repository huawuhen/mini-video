import { showConfirmDialog } from 'vant';
import { useRouter } from 'vue-router';
import { api, type Quote, type QuoteRequest } from '@/api';
import { useWalletStore } from '@/stores/wallet';
import { formatFen } from '@/utils/money';

/**
 * 所有收费操作的统一入口（docs/UI.md §6）：取报价 → 弹窗展示金额与余额 → 用户确认后返回报价。
 * 余额不足时引导去钱包；用户取消返回 null。调用方拿到报价后再带 quoteId 提交。
 */
export function useCharge() {
  const router = useRouter();
  const walletStore = useWalletStore();

  async function confirmCharge(request: QuoteRequest, title: string): Promise<Quote | null> {
    const [quote, wallet] = await Promise.all([api.quote(request), walletStore.refresh()]);
    const lines = quote.breakdown.map((b) => `${b.label}：¥${formatFen(b.amountFen)}`).join('\n');
    const enough = wallet.availableFen >= quote.amountFen;
    try {
      await showConfirmDialog({
        title,
        message: `${lines}\n\n合计 ¥${formatFen(quote.amountFen)}\n当前余额 ¥${formatFen(wallet.availableFen)}${enough ? '' : '（余额不足）'}`,
        confirmButtonText: enough ? '确认并开始' : '去充值',
        messageAlign: 'left',
      });
    } catch {
      return null;
    }
    if (!enough) { await router.push('/wallet'); return null; }
    return quote;
  }
  return { confirmCharge };
}
