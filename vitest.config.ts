import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'client/src/**/*.test.ts', 'shared/src/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20_000,
    pool: 'forks',
  },
});
