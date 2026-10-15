import { defineStore } from 'pinia';
import { api, type User } from '@/api';

export const useAuthStore = defineStore('auth', {
  state: () => ({ user: null as User | null, checked: false }),
  getters: { loggedIn: (s) => !!s.user },
  actions: {
    async check() {
      try { this.user = (await api.me()).user; } catch { this.user = null; }
      this.checked = true;
    },
    async login(phone: string, code: string) { this.user = (await api.login(phone, code)).user; },
    async logout() { try { await api.logout(); } finally { this.user = null; } },
  },
});
