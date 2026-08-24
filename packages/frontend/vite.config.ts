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
    // Force a single resolved instance of react/react-dom across the module
    // graph. Without this, Vitest's SSR module runner can end up loading two
    // separate module records for the same on-disk package (one through the
    // transformed/inlined graph, one through a plain Node require some
    // dependency issues directly) — each gets its own internal dispatcher
    // state, so a component's useState sees a null dispatcher even though
    // both copies are otherwise identical. Symptom: "Invalid hook call ...
    // you might have more than one copy of React" across every test file.
    dedupe: ['react', 'react-dom'],
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
