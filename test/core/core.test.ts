import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  countLines,
  decideIgnoreStatic,
  ensureWorkDir,
  excludedMutators,
  mergeRangesByFile,
  PRESETS,
  priorOf,
  rangeForLine,
  removeTree,
  startBudget,
  STRYKER_MUTATORS,
  tokenize,
  type ScopeRange,
} from '../../src/core/index.js';

const temps: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'chimpd-core-'));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of temps.splice(0)) removeTree(dir);
});

function range(file: string, startLine: number, endLine: number, kind: ScopeRange['kind'] = 'changed'): ScopeRange {
  return { file, startLine, endLine, kind, staticRegion: false };
}

describe('scope ranges', () => {
  it('merges overlapping and adjacent ranges so no line is listed twice', () => {
    const merged = mergeRangesByFile([
      range('b.ts', 10, 12),
      range('a.ts', 4, 9, 'enclosing-function'),
      range('a.ts', 8, 8),
      range('a.ts', 10, 11),
      range('a.ts', 20, 22, 'deletion-expanded'),
      range('a.ts', 4, 9, 'enclosing-function'),
    ]);
    expect([...merged]).toEqual([
      ['a.ts', [{ startLine: 4, endLine: 11 }, { startLine: 20, endLine: 22 }]],
      ['b.ts', [{ startLine: 10, endLine: 12 }]],
    ]);
    expect(countLines(merged.get('a.ts') ?? [])).toBe(11);
  });

  it('classifies a line by the narrowest range, changed first', () => {
    const ranges = [
      range('a.ts', 4, 9, 'enclosing-function'),
      range('a.ts', 8, 8),
      range('a.ts', 1, 30, 'deletion-expanded'),
      range('a.ts', 6, 7, 'enclosing-function'),
    ];
    expect(rangeForLine(ranges, 'a.ts', 8)?.kind).toBe('changed');
    expect(rangeForLine(ranges, 'a.ts', 6)).toMatchObject({ kind: 'enclosing-function', startLine: 6 });
    expect(rangeForLine(ranges, 'a.ts', 5)).toMatchObject({ kind: 'enclosing-function', startLine: 4 });
    expect(rangeForLine(ranges, 'a.ts', 20)?.kind).toBe('deletion-expanded');
    expect(rangeForLine(ranges, 'a.ts', 31)).toBeNull();
    expect(rangeForLine(ranges, 'b.ts', 8)).toBeNull();
  });
});

describe('presets', () => {
  it('exclude every mutator outside the preset', () => {
    expect(excludedMutators(PRESETS[1])).toEqual([
      'ArithmeticOperator',
      'ArrayDeclaration',
      'ArrowFunction',
      'AssignmentOperator',
      'CallExpression',
      'MethodExpression',
      'ObjectLiteral',
      'OptionalChaining',
      'Regex',
      'StringLiteral',
      'UpdateOperator',
    ]);
    expect(excludedMutators(PRESETS[2])).toEqual([
      'ArrayDeclaration',
      'ArrowFunction',
      'CallExpression',
      'ObjectLiteral',
      'Regex',
      'StringLiteral',
    ]);
    expect(excludedMutators(PRESETS[3])).toEqual([]);
  });

  it('carry the budgets, splits, and caps of the spec table', () => {
    expect(Object.values(PRESETS).map((preset) => [preset.name, preset.budgetMs, preset.mutationShare])).toEqual([
      ['Poke', 120_000, 0.7],
      ['Prod', 300_000, 0.7],
      ['Shake', 600_000, 0.65],
    ]);
    expect(Object.values(PRESETS).map((preset) => preset.maxBatches)).toEqual([1, 2, 3]);
    expect(Object.values(PRESETS).map((preset) => preset.maxFaultedCallSites)).toEqual([3, 8, 20]);
  });

  it('matches the mutators shipped with the installed Stryker', () => {
    const directory = path.resolve('node_modules/@stryker-mutator/instrumenter/dist/src/mutators');
    const installed = fs
      .readdirSync(directory)
      .filter((file) => file.endsWith('-mutator.js'))
      .flatMap((file) => [...fs.readFileSync(path.join(directory, file), 'utf8').matchAll(/^\s+name: '(\w+)',$/gm)])
      .map((match) => match[1])
      .sort();
    expect(installed).toEqual([...STRYKER_MUTATORS].sort());
  });
});

describe('ignoreStatic decision', () => {
  const base = { staticRegionLines: 4, baselineMs: 1000, mutationBudgetMs: 390_000 };

  it('always ignores static mutants at Poke and Prod', () => {
    expect(decideIgnoreStatic({ ...base, intensity: 1 }).ignoreStatic).toBe(true);
    expect(decideIgnoreStatic({ ...base, intensity: 2 }).ignoreStatic).toBe(true);
  });

  it('tests static mutants at Shake when they are few and fit a quarter of the budget', () => {
    expect(decideIgnoreStatic({ ...base, intensity: 3 })).toEqual({
      ignoreStatic: false,
      reason: 'static mutants fit the budget',
    });
    expect(decideIgnoreStatic({ ...base, intensity: 3, staticRegionLines: 20, baselineMs: 1625 }).ignoreStatic).toBe(false);
  });

  it('ignores them at Shake above 20 static lines', () => {
    const decision = decideIgnoreStatic({ ...base, intensity: 3, staticRegionLines: 21 });
    expect(decision.ignoreStatic).toBe(true);
    expect(decision.reason).toContain('21 static lines');
  });

  it('ignores them at Shake when the estimate exceeds a quarter of the mutation budget', () => {
    const decision = decideIgnoreStatic({ ...base, intensity: 3, staticRegionLines: 20, baselineMs: 1626 });
    expect(decision.ignoreStatic).toBe(true);
    expect(decision.reason).toContain('97560 ms');
  });
});

describe('prior', () => {
  it('splits paths and identifiers into lowercase tokens', () => {
    expect(tokenize('src/payments/refundHandler.ts')).toEqual(['src', 'payments', 'refund', 'handler', 'ts']);
    expect(tokenize('HTTPSessionStore_v2')).toEqual(['http', 'session', 'store', 'v']);
  });

  it('scores whole tokens, not substrings', () => {
    expect(priorOf('src/payments/refund.ts')).toBe(15);
    expect(priorOf('src/display.ts')).toBe(0);
    expect(priorOf('src/report.ts')).toBe(0);
    expect(priorOf('src/userRepository.ts')).toBe(10);
    expect(priorOf('src/db/saveInvoice.ts')).toBe(25);
    expect(priorOf('src/db/saveInvoice.ts', 'updateRefundBalance', 'authToken')).toBe(25);
  });
});

describe('budget', () => {
  it('counts down against the injected clock and never goes negative', () => {
    let now = 1000;
    const budget = startBudget(500, () => now);
    expect([budget.spentMs(), budget.remainingMs(), budget.exhausted()]).toEqual([0, 500, false]);
    now = 1400;
    expect([budget.spentMs(), budget.remainingMs(), budget.exhausted()]).toEqual([400, 100, false]);
    now = 1900;
    expect([budget.spentMs(), budget.remainingMs(), budget.exhausted()]).toEqual([900, 0, true]);
  });
});

describe('work directory', () => {
  it('creates .chimpd with an ignore file that hides it from git', () => {
    const target = tempDir();
    const workDir = ensureWorkDir(target);
    expect(workDir).toBe(path.join(target, '.chimpd'));
    expect(fs.readFileSync(path.join(workDir, '.gitignore'), 'utf8')).toBe('*\n');
  });

  it('removes a tree without descending into links', () => {
    const outside = tempDir();
    fs.mkdirSync(path.join(outside, 'kept'));
    fs.writeFileSync(path.join(outside, 'kept/file.txt'), 'keep me');

    const tree = path.join(tempDir(), 'tree');
    fs.mkdirSync(path.join(tree, 'nested/deeper'), { recursive: true });
    fs.writeFileSync(path.join(tree, 'nested/deeper/file.txt'), 'x');
    fs.symlinkSync(path.join(outside, 'kept'), path.join(tree, 'nested/link'), 'junction');

    removeTree(tree);

    expect(fs.existsSync(tree)).toBe(false);
    expect(fs.readFileSync(path.join(outside, 'kept/file.txt'), 'utf8')).toBe('keep me');
  });
});
