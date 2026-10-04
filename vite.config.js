import { defineConfig } from 'vite';
import { parsePublicOrigin } from './server/public-origin.js';

export function devServerConfig(env = process.env) {
  const origin = parsePublicOrigin(env.AGENT_CANVAS_PUBLIC_ORIGIN);
  const port = env.PORT || '3001';
  if (!/^\d+$/.test(String(port)) || Number(port) < 1 || Number(port) > 65535) throw new Error('PORT must be a backend port between 1 and 65535');
  return {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    // Exact hostname only; Vite retains its built-in localhost/IP allowances.
    allowedHosts: origin ? [new URL(origin).hostname] : [],
    // Leave HMR URL detection automatic: local ws:// and proxied wss:// both
    // use the browser-facing Vite client URL, not a forced localhost socket.
    proxy: {
      '/api': { target: 'http://127.0.0.1:' + Number(port), ws: true },
    },
  };
}

export default defineConfig(() => ({ server: devServerConfig() }));
