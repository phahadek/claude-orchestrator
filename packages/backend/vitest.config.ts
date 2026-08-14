import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./src/testSetupDb.ts', './src/bootstrap.ts'],
  },
});
