import { defineStore } from 'pinia';
import { api, type Wallet } from '@/api';

export const useWalletStore = defineStore('wallet', {
  state: () => ({ wallet: null as Wallet | null }),
  actions: {
    async refresh() { this.wallet = await api.wallet(); return this.wallet; },
  },
});
