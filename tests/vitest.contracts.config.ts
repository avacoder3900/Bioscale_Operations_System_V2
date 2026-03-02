import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/contracts/**/*.test.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
    setupFiles: ['tests/setup.ts'],
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
