import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyIgnores, SourceStatements, type Baseline, type BaselineEntry, type IgnoreInput } from '../../src/baseline/index.js';
import type { ScopeRange } from '../../src/core/index.js';
import type { Finding } from '../../src/orchestrator/index.js';
import { faultFinding, mutant, mutationFinding, site, siteResult } from '../helpers/run-fixtures.js';

const SOURCE = [
  'export function discount(total: number): number {',
  '  if (total >= 100) {',
  '    return total * 0.9;',
  '  }',
  '  return total;',
  '}',
  '',
].join('\n');

const FETCH = ['export async function load(url: string): Promise<void> {', '  await fetch(url);', '}', ''].join('\n');

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function project(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'bruise-ignore-'));
  dirs.push(dir);
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), content);
  }
  return dir;
}

function range(file: string, startLine: number, endLine: number): ScopeRange {
  return { file, startLine, endLine, kind: 'changed', staticRegion: false };
}

function survivor(line: number, overrides: Partial<Finding> = {}): Finding {
  return mutationFinding({
    file: 'src/a.ts',
    line,
    column: 7,
    mutation: { mutatorName: 'EqualityOperator', replacement: 'total > 100', status: 'Survived', endLine: line, endColumn: 19, coveredBy: [], statement: null },
    ...overrides,
  });
}

function hashAt(source: string, line: number, column: number): string {
  const hash = new SourceStatements('src/a.ts', source).enclosing(line, column)[0]?.hash;
  if (hash === undefined) throw new Error('no statement');
  return hash;
}

function entry(overrides: Partial<BaselineEntry & { source: 'mutation' }> = {}): BaselineEntry {
  return {
    source: 'mutation',
    file: 'src/a.ts',
    mutator: 'EqualityOperator',
    replacement: 'total > 100',
    statement: hashAt(SOURCE, 2, 7),
    reason: 'accepted',
    ...overrides,
  };
}

function baseline(entries: readonly BaselineEntry[], prefix = ''): Baseline {
  return { path: '/repo/bruise-baseline.json', prefix, present: entries.length > 0, entries };
}

function input(dir: string, overrides: Partial<IgnoreInput> = {}): IgnoreInput {
  return {
    targetRoot: dir,
    baseline: baseline([]),
    findings: [],
    mutants: [],
    mutationRanges: [range('src/a.ts', 1, 6)],
    faultRanges: [],
    faulted: [],
    ...overrides,
  };
}

describe('inline ignores', () => {
  it('sets aside a finding under a comment with a reason, and keeps the reason', () => {
    const dir = project({ 'src/a.ts': SOURCE.replace('  if (total', '  // bruise-ignore: equivalent, 100 is never passed\n  if (total') });
    const outcome = applyIgnores(input(dir, { findings: [survivor(3)], mutationRanges: [range('src/a.ts', 1, 7)] }));
    expect(outcome.findings).toEqual([]);
    expect(outcome.ignored).toMatchObject([{ by: 'inline', reason: 'equivalent, 100 is never passed', finding: { line: 3 } }]);
  });

  it('covers every statement nested in the one under the comment', () => {
    const dir = project({ 'src/a.ts': `// bruise-ignore: legacy pricing, replaced next quarter\n${SOURCE}` });
    const outcome = applyIgnores(input(dir, { findings: [survivor(3)], mutationRanges: [range('src/a.ts', 1, 7)] }));
    expect(outcome.ignored.map(({ by }) => by)).toEqual(['inline']);
  });

  it('does not honour a comment without a reason and reports it as an error finding', () => {
    const dir = project({ 'src/a.ts': SOURCE.replace('  if (total', '  // bruise-ignore\n  if (total') });
    const outcome = applyIgnores(input(dir, { findings: [survivor(3)], mutationRanges: [range('src/a.ts', 1, 7)] }));
    expect(outcome.ignored).toEqual([]);
    expect(outcome.findings.map(({ kind, line }) => [kind, line])).toEqual([
      ['invalid-ignore', 2],
      ['survived', 3],
    ]);
    expect(outcome.findings[0]?.message).toContain('bruise-ignore without a reason is not honoured');
    expect(outcome.findings[0]?.severity.score).toBeGreaterThan(0);
  });

  it('does not report a comment without a reason outside the scope', () => {
    const dir = project({ 'src/a.ts': `// bruise-ignore\nexport const other = 1;\n\n${SOURCE}` });
    const outcome = applyIgnores(input(dir, { mutationRanges: [range('src/a.ts', 5, 10)] }));
    expect(outcome.findings).toEqual([]);
  });

  it('sets aside a fault finding under a comment above the call', () => {
    const dir = project({ 'src/f.ts': FETCH.replace('  await fetch', '  // bruise-ignore: telemetry, losing it is fine\n  await fetch') });
    const finding = faultFinding({ file: 'src/f.ts', line: 3, column: 9, functionName: 'load', kind: 'fire-and-forget' });
    const outcome = applyIgnores(input(dir, { findings: [finding], mutationRanges: [], faultRanges: [range('src/f.ts', 1, 4)] }));
    expect(outcome.ignored).toMatchObject([{ by: 'inline', reason: 'telemetry, losing it is fine' }]);
  });
});

describe('baseline entries', () => {
  it('match a finding by file, mutator, replacement and statement, also after the statement moved', () => {
    const moved = `import { x } from './x.js';\nexport const y = x;\n\n${SOURCE}`;
    const dir = project({ 'src/a.ts': moved });
    const outcome = applyIgnores(input(dir, { baseline: baseline([entry()]), findings: [survivor(5)], mutationRanges: [range('src/a.ts', 4, 9)] }));
    expect(outcome.findings).toEqual([]);
    expect(outcome.ignored).toMatchObject([{ by: 'baseline', reason: 'accepted', finding: { line: 5 } }]);
    expect(outcome.stale).toEqual([]);
  });

  it('fill in the statement hash of every mutation finding', () => {
    const dir = project({ 'src/a.ts': SOURCE });
    const outcome = applyIgnores(input(dir, { findings: [survivor(2)] }));
    expect(outcome.findings[0]?.mutation?.statement).toBe(hashAt(SOURCE, 2, 7));
  });

  it.each([
    ['another replacement', { replacement: 'total <= 100' }],
    ['another mutator', { mutator: 'ConditionalExpression' }],
    ['another statement', { statement: 'ffffffffffffffff' }],
    ['another file', { file: 'src/b.ts' }],
  ])('do not match a finding with %s', (_label, overrides) => {
    const dir = project({ 'src/a.ts': SOURCE });
    const outcome = applyIgnores(input(dir, { baseline: baseline([entry(overrides)]), findings: [survivor(2)] }));
    expect(outcome.findings).toHaveLength(1);
    expect(outcome.ignored).toEqual([]);
  });

  it('count an inline ignore first when both match, and the entry is not stale', () => {
    const commented = SOURCE.replace('  if (total', '  // bruise-ignore: inline wins\n  if (total');
    const dir = project({ 'src/a.ts': commented });
    const outcome = applyIgnores(
      input(dir, { baseline: baseline([entry({ statement: hashAt(commented, 3, 7) })]), findings: [survivor(3)], mutationRanges: [range('src/a.ts', 1, 7)] }),
    );
    expect(outcome.ignored.map(({ by }) => by)).toEqual(['inline']);
    expect(outcome.stale).toEqual([]);
  });

  it('match paths from the repository root for a target in a subdirectory', () => {
    const dir = project({ 'src/a.ts': SOURCE });
    const outcome = applyIgnores(
      input(dir, { baseline: baseline([entry({ file: 'packages/api/src/a.ts' }), entry({ file: 'packages/web/src/a.ts' })], 'packages/api'), findings: [survivor(2)] }),
    );
    expect(outcome.ignored).toHaveLength(1);
    expect(outcome.stale).toEqual([]);
    expect(outcome.notEvaluated).toEqual([]);
  });

  it('match a fault finding by file, function and kind', () => {
    const dir = project({ 'src/f.ts': FETCH });
    const faultEntry: BaselineEntry = { source: 'fault', file: 'src/f.ts', function: 'load', kind: 'hang-no-timeout', reason: null };
    const finding = faultFinding({ file: 'src/f.ts', line: 2, column: 9, functionName: 'load' });
    const outcome = applyIgnores(input(dir, { baseline: baseline([faultEntry]), findings: [finding], mutationRanges: [], faultRanges: [range('src/f.ts', 1, 3)] }));
    expect(outcome.ignored).toMatchObject([{ by: 'baseline', reason: null }]);
  });
});

describe('stale baseline entries', () => {
  it('are stale when the mutant they name is now killed', () => {
    const dir = project({ 'src/a.ts': SOURCE });
    const killed = mutant({ file: 'src/a.ts', start: { line: 2, column: 7 }, mutatorName: 'EqualityOperator', replacement: 'total > 100', status: 'Killed' });
    const outcome = applyIgnores(input(dir, { baseline: baseline([entry()]), mutants: [killed] }));
    expect(outcome.stale).toEqual([entry()]);
    expect(outcome.findings).toEqual([]);
  });

  it('are stale when their statement no longer exists in a file in scope, or the file is gone', () => {
    const dir = project({ 'src/a.ts': SOURCE.replace('total >= 100', 'total >= 200') });
    const gone = entry({ file: 'src/deleted.ts' });
    const outcome = applyIgnores(input(dir, { baseline: baseline([entry(), gone]) }));
    expect(outcome.stale).toEqual([entry(), gone]);
  });

  it('are not evaluated when their mutant was in scope but not tested, or not generated at this level', () => {
    const dir = project({ 'src/a.ts': SOURCE });
    const untested = mutant({ file: 'src/a.ts', start: { line: 2, column: 7 }, mutatorName: 'EqualityOperator', replacement: 'total > 100', status: 'NotTested' });
    expect(applyIgnores(input(dir, { baseline: baseline([entry()]), mutants: [untested] })).notEvaluated).toEqual([entry()]);
    expect(applyIgnores(input(dir, { baseline: baseline([entry()]), mutants: [] })).notEvaluated).toEqual([entry()]);
  });

  it('are left alone when their statement lies outside the scope', () => {
    const dir = project({ 'src/a.ts': SOURCE });
    const outcome = applyIgnores(input(dir, { baseline: baseline([entry()]), mutationRanges: [range('src/a.ts', 5, 5)] }));
    expect(outcome.stale).toEqual([]);
    expect(outcome.notEvaluated).toEqual([]);
  });

  it('are stale for a fault when its function was faulted again with another verdict', () => {
    const dir = project({ 'src/f.ts': FETCH });
    const faultEntry: BaselineEntry = { source: 'fault', file: 'src/f.ts', function: 'load', kind: 'hang-no-timeout', reason: null };
    const handled = siteResult({ site: site({ file: 'src/f.ts', functionName: 'load' }), verdict: 'handled-timeout', findingKind: null });
    const inconclusive = siteResult({ site: site({ file: 'src/f.ts', functionName: 'load' }), verdict: 'inconclusive', findingKind: null });
    const ranges = { mutationRanges: [], faultRanges: [range('src/f.ts', 1, 3)] };
    expect(applyIgnores(input(dir, { ...ranges, baseline: baseline([faultEntry]), faulted: [handled] })).stale).toEqual([faultEntry]);
    expect(applyIgnores(input(dir, { ...ranges, baseline: baseline([faultEntry]), faulted: [inconclusive] })).stale).toEqual([]);
    expect(applyIgnores(input(dir, { ...ranges, baseline: baseline([faultEntry]), faulted: [] })).stale).toEqual([]);
  });

  it('judge a fault entry only by results of the fault kind its finding comes from', () => {
    const dir = project({ 'src/f.ts': FETCH });
    const ranges = { mutationRanges: [], faultRanges: [range('src/f.ts', 1, 3)] };
    const hangEntry: BaselineEntry = { source: 'fault', file: 'src/f.ts', function: 'load', kind: 'hang-no-timeout', reason: null };
    const refusalEntry: BaselineEntry = { source: 'fault', file: 'src/f.ts', function: 'load', kind: 'refusal-mishandled', reason: null };
    const refusedHandled = siteResult({ site: site({ file: 'src/f.ts', functionName: 'load' }), kind: 'connection-refused', verdict: 'refusal-handled', findingKind: null });
    const outcome = applyIgnores(input(dir, { ...ranges, baseline: baseline([hangEntry, refusalEntry]), faulted: [refusedHandled] }));
    expect(outcome.stale).toEqual([refusalEntry]);
  });
});
