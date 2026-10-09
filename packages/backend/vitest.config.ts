import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    maxWorkers: 3,
    setupFiles: ['./src/testSetupDb.ts', './src/bootstrap.ts'],
  },
});
