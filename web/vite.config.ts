import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig(({ mode }) => {
  // Ports come from the studio's root .env (ASF_PORT for the API, ASF_WEB_PORT for this dev server), so a second
  // checkout (the V2 worktree) can run next to the owner's V1 without clashing. No .env = V1 defaults.
  const env = { ...loadEnv(mode, fileURLToPath(new URL('..', import.meta.url)), 'ASF_'), ...process.env };
  const apiTarget = env.ASF_API_URL ?? `http://127.0.0.1:${env.ASF_PORT ?? 4317}`;
  const webPort = Number(env.ASF_WEB_PORT ?? 5317);
  return {
    plugins: [react(), tailwindcss()],
    resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
    server: {
      host: '127.0.0.1',
      port: webPort,
      strictPort: true,
      proxy: { '/api': { target: apiTarget, changeOrigin: false } },
    },
    preview: { host: '127.0.0.1', port: webPort + 1 },
  };
});
