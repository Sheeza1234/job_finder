import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The build lands in dist (deploy this folder to Vercel). In dev, /api and /healthz go to the running server.
export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false },
  server: { proxy: { '/api': 'http://127.0.0.1:3000', '/healthz': 'http://127.0.0.1:3000' } },
});
