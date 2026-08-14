import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./src/testSetupDb.ts', './src/bootstrap.ts'],
    // Capped rather than the default (one fork per CPU core) — on a
    // memory-constrained/shared host, running the full suite's worker forks
    // fully in parallel exhausts the V8 heap before any file finishes (each
    // fork's own heap ceiling, times core count, exceeds available RAM).
    // Bounding concurrency trades wall-clock time for a suite that actually
    // completes.
    poolOptions: {
      forks: {
        maxForks: 4,
      },
    },
  },
});
