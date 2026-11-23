import { afterEach, expect, it } from 'vitest';
import { LEVELS, type Level } from '../../src/orchestrator/index.js';
import { scopeDiff } from '../../src/diff-scoper/index.js';
import { PRESETS } from '../../src/core/index.js';
import { planRun } from '../../src/plan/index.js';
import { runMutation } from '../../src/stryker-adapter/index.js';
import { createSampleApp, history, type SampleApp } from '../helpers/sample-app.js';

const RUN_TIMEOUT_MS = 600_000;

let app: SampleApp | undefined;

afterEach(() => {
  app?.cleanup();
  app = undefined;
});

it.each(['poke', 'shake'] satisfies Level[])(
  'plans as many mutants per file as a %s mutation run then generates',
  async (level) => {
    app = createSampleApp();
    history.boundaryChange(app);
    history.clientChanges(app);
    const before = app.git('status', '--porcelain', '--ignored');
    const plan = await planRun({ cwd: app.dir, level, seed: 1 });
    expect(app.git('status', '--porcelain', '--ignored')).toBe(before);

    const intensity = LEVELS[level];
    const scope = await scopeDiff({ repoRoot: app.dir, mode: PRESETS[intensity].scopeMode });
    const run = await runMutation({ targetRoot: app.dir, ranges: scope.ranges, intensity, ignoreStatic: true, budgetMs: RUN_TIMEOUT_MS, seed: 1 });
    expect(run.notTested).toMatchObject({ mutants: 0, unplannedFiles: [] });

    const generated = new Map<string, number>();
    for (const mutant of run.mutants) generated.set(mutant.file, (generated.get(mutant.file) ?? 0) + 1);
    const planned = new Map((plan.mutation?.files ?? []).filter((entry) => (entry.mutants ?? 0) > 0).map((entry) => [entry.file, entry.mutants]));
    expect(planned).toEqual(generated);
    expect(plan.mutation?.total).toBe(run.mutants.length);
  },
  RUN_TIMEOUT_MS,
);
