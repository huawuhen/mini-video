import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: {
    host: true,
    port: 5173,
    // 真实后端联调时设置 VITE_USE_MOCK=false，并把 /api 代理到 server（默认 127.0.0.1:3000）。
    proxy: { '/api': { target: process.env.VITE_API_TARGET || 'http://127.0.0.1:3000', changeOrigin: true } },
  },
});
