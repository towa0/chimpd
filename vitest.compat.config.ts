import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/compat/*.test.ts'],
    testTimeout: 30_000,
  },
});
