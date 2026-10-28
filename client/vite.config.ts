import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Dev: `vite` serves the UI on :5173 and proxies signaling to the Node server on :7420.
// Prod: `vite build` output (client/dist) is served by the Node server itself.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/socket.io': { target: 'http://localhost:7420', ws: true },
      '/api': 'http://localhost:7420',
    },
  },
  worker: { format: 'es' },
  build: { target: 'es2022', sourcemap: false, chunkSizeWarningLimit: 900 },
});
