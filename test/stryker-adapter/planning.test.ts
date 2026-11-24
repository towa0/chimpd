import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PRESETS, type ScopeRange } from '../../src/core/index.js';
import {
  buildStrykerOptions,
  decideChecker,
  escapeGlob,
  findTargetConfig,
  mutatePatterns,
  planBatches,
  reclassifyUncovered,
  resolveCheckerTypeScript,
  resolveOutcomes,
  type WireMutant,
  cappedConcurrency,
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

  it('orders files of equal prior by the seed, and the same way for the same seed', () => {
    const plain = Array.from({ length: 8 }, (_, index) => range(`src/plain-${index}.ts`, 1, 10));
    const planned = (seed: number, input: readonly ScopeRange[] = plain): string =>
      planBatches(input, 1, seed)
        .flatMap((batch) => batch.files.map((entry) => entry.file))
        .join(',');
    expect(planned(8)).toBe(planned(8));
    expect(planned(8, plain.toReversed())).toBe(planned(8));
    expect(new Set([0, 1, 2, 3, 4, 5].map((seed) => planned(seed))).size).toBeGreaterThan(1);
  });

  it('keeps more sensitive files ahead of less sensitive ones, whatever the seed', () => {
    for (let seed = 0; seed < 30; seed += 1) {
      const files = planBatches(ranges, 3, seed).flatMap((batch) => batch.files.map((entry) => entry.file));
      expect(files.slice(0, 2).toSorted()).toEqual(['src/auth/token.ts', 'src/payments/refund.ts']);
      expect(files[2]).toBe('src/db/save.ts');
      expect(files.slice(3).toSorted()).toEqual(['src/alpha.ts', 'src/beta.ts', 'src/zebra.ts']);
    }
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

describe('glob escaping', () => {
  it('wraps each glob metacharacter in a bracket class and leaves plain paths alone', () => {
    expect(escapeGlob('src/plain-file.ts')).toBe('src/plain-file.ts');
    expect(escapeGlob('src/prijsberekening-é.ts')).toBe('src/prijsberekening-é.ts');
    expect(escapeGlob('src/[id] (copy) {x}.ts')).toBe('src/[[]id[]] [(]copy[)] [{]x[}].ts');
    expect(escapeGlob('src/what?*.ts')).toBe('src/what[?][*].ts');
  });
});

describe('target Stryker config', () => {
  it('is found under every name Stryker would load', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chimpd-config-'));
    try {
      expect(findTargetConfig(dir)).toBeNull();
      for (const name of ['.stryker.conf.cjs', 'stryker.config.mjs', 'stryker.conf.json']) {
        fs.writeFileSync(path.join(dir, name), '');
      }
      expect(findTargetConfig(dir)).toBe('stryker.conf.json');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('stryker options', () => {
  const [batch] = planBatches([range('src/discount.ts', 2, 2)], 1);
  if (batch === undefined) throw new Error('expected one batch');
  const input = { batch, ignoreStatic: true, checkerEnabled: true, pluginPath: '/plugin.js', configFile: '/target/.chimpd/stryker.config.json' };

  it('keeps every Stryker artifact inside .chimpd and writes no reports', () => {
    const options = buildStrykerOptions({ ...input, preset: PRESETS[1] });
    expect(options).toMatchObject({
      configFile: '/target/.chimpd/stryker.config.json',
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
      disableBail: true,
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
      reason: "type checker disabled: chimpd's own TypeScript copy, which the checker loads, is 7.0.2; the checker needs TypeScript below 7",
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
    testsCompleted: null,
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

  it('reports a survivor as uncovered when the dry run reported no coverage and no mutant of the batch was killed', () => {
    const outcomes = resolveOutcomes(new Map(), new Map([['1', mutant('1', 'Survived')], ['2', mutant('2', 'CompileError')]]));
    expect(reclassifyUncovered(outcomes, false).map((outcome) => [outcome.mutant.id, outcome.status, outcome.statusReason])).toEqual([
      ['1', 'NoCoverage', 'no test runs this mutant: Stryker reported no coverage for its batch'],
      ['2', 'CompileError', null],
    ]);
  });

  it('keeps survivors when coverage was reported, unknown, or broken because a mutant was killed without it', () => {
    const outcomes = resolveOutcomes(new Map(), new Map([['1', mutant('1', 'Survived')]]));
    expect(reclassifyUncovered(outcomes, true).map((outcome) => outcome.status)).toEqual(['Survived']);
    expect(reclassifyUncovered(outcomes, null).map((outcome) => outcome.status)).toEqual(['Survived']);
    const withKill = resolveOutcomes(new Map(), new Map([['1', mutant('1', 'Survived')], ['2', mutant('2', 'Killed')]]));
    expect(reclassifyUncovered(withKill, false).map((outcome) => outcome.status)).toEqual(['Survived', 'Killed']);
  });
});

describe('cappedConcurrency', () => {
  it('takes the smallest of the mutant count, half the cores and 4, and never goes below 1', () => {
    expect(cappedConcurrency(10, 16)).toBe(4);
    expect(cappedConcurrency(3, 16)).toBe(3);
    expect(cappedConcurrency(10, 6)).toBe(3);
    expect(cappedConcurrency(0, 16)).toBe(1);
    expect(cappedConcurrency(10, 1)).toBe(1);
  });

  it('falls back to half the cores, at most 4, when the mutant count is unknown', () => {
    expect(cappedConcurrency(null, 16)).toBe(4);
    expect(cappedConcurrency(null, 4)).toBe(2);
  });
});
