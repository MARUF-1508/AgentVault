import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev only: proxy /api to the wallet server (`npm run cli -- serve`, port 5174).
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { '/api': 'http://127.0.0.1:5174' } },
});
