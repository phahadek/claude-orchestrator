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
    host: process.env.ORCHESTRATOR_BIND_HOST ?? 'localhost',
    strictPort: true,
    watch: {
      ignored: ['**/.claude/worktrees/**'],
    },
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
    // Force NODE_ENV=test for the test run regardless of the ambient env (some
    // sandboxes inherit NODE_ENV=production), so React resolves its test build —
    // the production react-dom/test-utils build removes `act`.
    env: {
      NODE_ENV: 'test',
    },
  },
});
