import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    globalSetup: ['./test/global-setup.ts'],
    setupFiles: ['./test/env.ts'],
    testTimeout: 60000,
    hookTimeout: 120000,
    fileParallelism: false,
    pool: 'forks',
  },
});
