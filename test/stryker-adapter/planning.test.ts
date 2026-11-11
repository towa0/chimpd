import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PRESETS, type ScopeRange } from '../../src/core/index.js';
import {
  buildStrykerOptions,
  decideChecker,
  mutatePatterns,
  planBatches,
  resolveCheckerTypeScript,
  resolveOutcomes,
  type WireMutant,
} from '../../src/stryker-adapter/index.js';
import { repoNodeModules, repoRoot } from '../helpers/temp-repo.js';

function range(file: string, startLine: number, endLine: number, kind: ScopeRange['kind'] = 'changed'): ScopeRange {
  return { file, startLine, endLine, kind, staticRegion: false };
}

describe('batch planning', () => {
  const ranges = [
    range('src/zebra.ts', 1, 10),
    range('src/payments/refund.ts', 1, 10),
    range('src/alpha.ts', 1, 10),
    range('src/db/save.ts', 1, 10),
    range('src/beta.ts', 1, 10),
    range('src/auth/token.ts', 1, 10),
  ];
  const order = ['src/auth/token.ts', 'src/payments/refund.ts', 'src/db/save.ts', 'src/alpha.ts', 'src/beta.ts', 'src/zebra.ts'];

  it('orders files by prior, then path, in one batch at Poke', () => {
    const batches = planBatches(ranges, PRESETS[1].maxBatches);
    expect(batches.map((batch) => batch.files.map((entry) => entry.file))).toEqual([order]);
  });

  it('cuts that order into contiguous groups', () => {
    const two = planBatches(ranges, 2).map((batch) => batch.files.map((entry) => entry.file));
    expect(two).toEqual([order.slice(0, 3), order.slice(3)]);
    const three = planBatches(ranges, 3).map((batch) => batch.files.map((entry) => entry.file));
    expect(three).toEqual([order.slice(0, 2), order.slice(2, 4), order.slice(4)]);
  });

  it('balances groups by scoped lines and never makes an empty batch', () => {
    const uneven = [range('src/a.ts', 1, 100), range('src/b.ts', 1, 5), range('src/c.ts', 1, 5)];
    expect(planBatches(uneven, 2).map((batch) => batch.files.map((entry) => entry.file))).toEqual([
      ['src/a.ts'],
      ['src/b.ts', 'src/c.ts'],
    ]);
    expect(planBatches([range('src/a.ts', 1, 3)], 3)).toHaveLength(1);
    expect(planBatches([], 3)).toEqual([]);
  });

  it('lists every scoped line once in the mutate patterns', () => {
    const [batch] = planBatches(
      [
        range('src/discount.ts', 1, 6, 'enclosing-function'),
        range('src/discount.ts', 2, 2),
        range('src/discount.ts', 9, 9),
        range('src/price list.ts', 3, 4),
      ],
      1,
    );
    expect(batch && mutatePatterns(batch)).toEqual(['src/price list.ts:3-4', 'src/discount.ts:1-6', 'src/discount.ts:9-9']);
  });
});

describe('stryker options', () => {
  const [batch] = planBatches([range('src/discount.ts', 2, 2)], 1);
  if (batch === undefined) throw new Error('expected one batch');
  const input = { batch, ignoreStatic: true, checkerEnabled: true, pluginPath: '/plugin.js' };

  it('keeps every Stryker artifact inside .chimpd and writes no reports', () => {
    const options = buildStrykerOptions({ ...input, preset: PRESETS[1] });
    expect(options).toMatchObject({
      tempDirName: '.chimpd/stryker-tmp',
      cleanTempDir: 'always',
      ignorePatterns: ['.chimpd'],
      reporters: ['chimpd-stream'],
      incremental: false,
      logLevel: 'off',
      fileLogLevel: 'off',
      coverageAnalysis: 'perTest',
      testRunner: 'vitest',
      checkers: ['typescript'],
      ignoreStatic: true,
      mutate: ['src/discount.ts:2-2'],
    });
  });

  it('excludes mutators per preset and drops the checker when disabled', () => {
    expect(buildStrykerOptions({ ...input, preset: PRESETS[3] }).mutator).toEqual({ excludedMutations: [] });
    expect(buildStrykerOptions({ ...input, preset: PRESETS[2] }).mutator?.excludedMutations).toContain('StringLiteral');
    expect(buildStrykerOptions({ ...input, preset: PRESETS[1], checkerEnabled: false }).checkers).toEqual([]);
  });
});

describe('type checker decision', () => {
  const fixture = path.join(repoRoot, 'fixtures/sample-app');

  it('loads the typescript copy that resolves from the checker, which is chimpd 6.0.3 here', () => {
    expect(resolveCheckerTypeScript()).toEqual({ version: '6.0.3', path: path.join(repoNodeModules, 'typescript') });
    expect(decideChecker(fixture)).toMatchObject({ enabled: true, reason: null, typescriptVersion: '6.0.3' });
  });

  it('is disabled, not fatal, when that copy is TypeScript 7', () => {
    expect(decideChecker(fixture, { version: '7.0.2', path: '/somewhere/typescript' })).toEqual({
      enabled: false,
      reason: 'type checker disabled: target uses TypeScript 7',
      typescriptVersion: '7.0.2',
      typescriptPath: '/somewhere/typescript',
    });
  });

  it('is disabled when the target has no tsconfig.json or typescript cannot be resolved', () => {
    expect(decideChecker(os.tmpdir()).reason).toBe('type checker disabled: tsconfig.json not found');
    expect(decideChecker(fixture, null).reason).toBe('type checker disabled: typescript could not be resolved');
    expect(fs.existsSync(path.join(fixture, 'tsconfig.json'))).toBe(true);
  });
});

describe('outcome resolution', () => {
  const mutant = (id: string, status: string | null): WireMutant => ({
    id,
    fileName: 'src/a.ts',
    start: { line: 1, column: 1 },
    end: { line: 1, column: 2 },
    mutatorName: 'BooleanLiteral',
    replacement: 'false',
    status,
    statusReason: status === 'Ignored' ? 'ignored early' : null,
    coveredBy: [],
    killedBy: [],
    static: false,
  });

  it('keeps streamed results and marks the rest as not tested for budget', () => {
    const planned = new Map([
      ['1', mutant('1', null)],
      ['2', mutant('2', null)],
      ['3', mutant('3', 'Ignored')],
      ['4', mutant('4', 'Pending')],
    ]);
    const tested = new Map([['1', mutant('1', 'Survived')]]);
    expect(resolveOutcomes(planned, tested).map((outcome) => [outcome.mutant.id, outcome.status, outcome.statusReason])).toEqual([
      ['1', 'Survived', null],
      ['2', 'NotTested', 'not tested: budget'],
      ['3', 'Ignored', 'ignored early'],
      ['4', 'NotTested', 'not tested: budget'],
    ]);
  });

  it('accepts a result for a mutant that was never in the plan', () => {
    expect(resolveOutcomes(new Map(), new Map([['9', mutant('9', 'Killed')]]))).toHaveLength(1);
  });
});
