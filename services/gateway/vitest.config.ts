import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Every file truncates the same tables, so they must not overlap in time.
    fileParallelism: false,
    // argon2 is deliberately slow; a suite that registers a handful of users per test
    // needs more headroom than the 5s default.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
