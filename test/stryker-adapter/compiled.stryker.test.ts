import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { scopeDiff } from '../../src/diff-scoper/index.js';
import type { MutationResult } from '../../src/stryker-adapter/index.js';
import { createSampleApp, history, type SampleApp } from '../helpers/sample-app.js';
import { repoRoot } from '../helpers/temp-repo.js';

const runner = fileURLToPath(new URL('../fixtures/run-compiled-adapter.mjs', import.meta.url));
const distDir = path.join(repoRoot, 'dist');

let app: SampleApp | undefined;

afterEach(() => {
  app?.cleanup();
  app = undefined;
});

it(
  'runs a real batch through the compiled adapter and worker',
  async () => {
    execFileSync(process.execPath, [path.join(repoRoot, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.build.json'], {
      cwd: repoRoot,
      stdio: 'pipe',
    });
    expect(fs.existsSync(path.join(distDir, 'stryker-adapter/worker.js'))).toBe(true);

    app = createSampleApp();
    history.boundaryChange(app);
    const scope = await scopeDiff({ repoRoot: app.dir, mode: 'changed-lines' });

    const output = execFileSync(process.execPath, [runner, distDir, app.dir, JSON.stringify(scope.ranges)], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const result = JSON.parse(output) as MutationResult;

    expect(result.batches).toMatchObject([{ outcome: 'completed', planned: 4, tested: 4, error: null }]);
    expect(
      result.mutants.filter((mutant) => mutant.status === 'Survived').map((mutant) => mutant.replacement),
    ).toEqual(['orderTotal > 120']);
    expect(app.git('status', '--porcelain')).toBe('');
  },
  240_000,
);
