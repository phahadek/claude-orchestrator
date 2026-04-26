/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@claude-orchestrator/backend': resolve(__dirname, '../backend'),
    },
  },
  server: {
    host: true,
    proxy: {
      '/api': 'http://localhost:3000',
      '/ws': { target: 'http://localhost:3000', ws: true },
    },
  },
  build: {
    outDir: '../backend/dist/public',
    emptyOutDir: true,
  },
  test: {
    globals: true,
    environment: 'jsdom',
  },
});
