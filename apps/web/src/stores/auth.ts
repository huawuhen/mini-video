import { defineStore } from 'pinia';
import { api, type Onboarding, type User } from '@/api';

export const useAuthStore = defineStore('auth', {
  state: () => ({ user: null as User | null, checked: false }),
  getters: { loggedIn: (s) => !!s.user },
  actions: {
    async check() {
      try { this.user = (await api.me()).user; } catch { this.user = null; }
      this.checked = true;
    },
    async login(phone: string, code: string) {
      const result = await api.login(phone, code);
      this.user = result.user;
      return result;
    },
    async logout() { try { await api.logout(); } finally { this.user = null; } },
    setOnboarding(onboarding: Onboarding) { if (this.user) this.user.onboarding = onboarding; },
  },
});
