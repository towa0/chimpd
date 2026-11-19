import { defineConfig } from 'vitest/config';

const EXCLUDED = ['test/fixtures/**', 'test/compat/**', 'node_modules/**'];
const HEAVY = 'test/**/*.stryker.test.ts';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['test/**/*.test.ts'],
          exclude: [...EXCLUDED, HEAVY],
          testTimeout: 30_000,
        },
      },
      {
        // Each file starts real Stryker and Vitest processes; running them side by side starves the machine.
        test: {
          name: 'e2e',
          include: [HEAVY],
          exclude: EXCLUDED,
          testTimeout: 30_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
