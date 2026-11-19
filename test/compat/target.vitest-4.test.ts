import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { loadTargetVitest } from '../../src/orchestrator/target.js';

const here = dirname(fileURLToPath(import.meta.url));

it('loads Vitest 4 from a target that has it', async () => {
  const loaded = await loadTargetVitest(resolve(here, 'vitest-4'));
  expect(loaded.version).toBe('4.1.12');
  expect(typeof loaded.node.createVitest).toBe('function');
});
