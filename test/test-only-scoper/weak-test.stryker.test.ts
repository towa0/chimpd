import { afterEach, expect, it } from 'vitest';
import { PRESETS } from '../../src/core/index.js';
import { scopeDiff } from '../../src/diff-scoper/index.js';
import { runMutation } from '../../src/stryker-adapter/index.js';
import { boundaryRanges, computeBoundary, summarizeTestOnly } from '../../src/test-only-scoper/index.js';
import { createSampleApp, history, type SampleApp } from '../helpers/sample-app.js';

let app: SampleApp | undefined;

afterEach(() => {
  app?.cleanup();
  app = undefined;
});

it(
  'reports what a weak new test covers against what it kills',
  async () => {
    app = createSampleApp();
    history.weakTest(app);
    const preset = PRESETS[1];

    const scope = await scopeDiff({ repoRoot: app.dir, mode: preset.scopeMode });
    expect(scope.changedSourceFiles).toEqual([]);
    expect(scope.changedTestFiles).toEqual(['test/refund-cap.test.ts']);

    const boundary = computeBoundary({
      targetRoot: app.dir,
      changedTestFiles: scope.changedTestFiles,
      depth: preset.testOnlyDepth,
      fileCap: preset.testOnlyFileCap,
    });
    expect(boundary.files).toEqual([{ file: 'src/payments/refund.ts', distance: 1 }]);
    expect(boundary.truncated).toBe(0);

    const result = await runMutation({
      targetRoot: app.dir,
      ranges: [...scope.ranges, ...boundaryRanges(app.dir, boundary)],
      intensity: 1,
      ignoreStatic: true,
      budgetMs: 150_000,
    });
    expect(result.batches).toMatchObject([{ outcome: 'completed', files: ['src/payments/refund.ts'] }]);

    const report = summarizeTestOnly(result.mutants, result.tests, scope.changedTestFiles);

    expect(report.droppedUncovered).toBe(0);
    expect(report.mutants.every((mutant) => mutant.scopeKind === 'test-boundary')).toBe(true);
    expect(report.perTestFile).toEqual([
      { testFile: 'test/refund-cap.test.ts', covered: report.total.covered, killed: 0 },
    ]);
    expect(report.total.covered).toBe(report.mutants.length);
    expect(report.total.covered).toBeGreaterThan(report.coveredNotKilled.length);
    expect(report.total.killed).toBe(0);

    const survivors = report.coveredNotKilled.map((mutant) => [mutant.start.line, mutant.mutatorName, mutant.replacement]);
    const branch = app.lineOf('src/payments/refund.ts', 'if (requested > remaining)');
    expect(survivors).toContainEqual([branch, 'ConditionalExpression', 'false']);
    expect(survivors).toContainEqual([branch, 'EqualityOperator', 'requested >= remaining']);
    expect(report.coveredNotKilled.every((mutant) => mutant.status === 'Survived')).toBe(true);
    expect(report.coveredNotKilled.every((mutant) => mutant.coveredBy.some((id) => id.startsWith('test/refund-cap.test.ts#')))).toBe(true);
    expect(app.git('status', '--porcelain')).toBe('');
  },
  180_000,
);
