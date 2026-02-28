import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Every file truncates the same tables, so they must not overlap in time.
    fileParallelism: false,
    // argon2 is deliberately slow.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
