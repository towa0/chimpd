import { describe, expect, it } from 'vitest';
import { exitCodeOf, type RunResult } from '../../src/orchestrator/index.js';
import { renderJson, SCHEMA_VERSION, toJsonReport } from '../../src/reporter/index.js';
import { severityOf } from '../../src/severity/index.js';
import { faultFinding, faultSite, mutationFinding, runResult } from '../helpers/run-fixtures.js';

type Shape =
  | 'string'
  | 'number'
  | 'boolean'
  | { readonly nullable: Shape }
  | { readonly list: Shape }
  | { readonly fields: Readonly<Record<string, Shape>> }
  | { readonly oneOf: readonly string[] }
  | { readonly anyOf: readonly Shape[] };

const nullable = (shape: Shape): Shape => ({ nullable: shape });
const list = (shape: Shape): Shape => ({ list: shape });
const fields = (shape: Readonly<Record<string, Shape>>): Shape => ({ fields: shape });
const oneOf = (...values: string[]): Shape => ({ oneOf: values });
const anyOf = (...shapes: Shape[]): Shape => ({ anyOf: shapes });

const ITEM = fields({
  source: oneOf('mutation', 'fault'),
  file: 'string',
  line: nullable('number'),
  reason: 'string',
  faultKind: nullable(oneOf('blackhole', 'http-500', 'malformed-json', 'connection-refused')),
});

const FINDING_FIELDS: Readonly<Record<string, Shape>> = {
  source: oneOf('mutation', 'fault'),
  kind: oneOf(
    'survived',
    'no-coverage',
    'hang-no-timeout',
    'abort-mishandled',
    'fire-and-forget',
    'invalid-ignore',
    'refusal-mishandled',
    'error-status-ignored',
    'error-status-mishandled',
    'malformed-json-mishandled',
  ),
  file: 'string',
  line: 'number',
  column: 'number',
  functionName: nullable('string'),
  message: 'string',
  severity: fields({ score: 'number', level: oneOf('high', 'medium', 'low'), base: 'number', prior: 'number' }),
  mutation: nullable(
    fields({
      mutatorName: 'string',
      replacement: 'string',
      status: 'string',
      endLine: 'number',
      endColumn: 'number',
      coveredBy: list('string'),
      statement: nullable('string'),
    }),
  ),
  fault: nullable(
    fields({ kind: oneOf('blackhole', 'http-500', 'malformed-json', 'connection-refused'), verdict: 'string', path: oneOf('fetch', 'http'), tests: list('string'), reachedFrom: list('string'), notFaultedFrom: list('string') }),
  ),
};

const BASELINE_ENTRY = anyOf(
  fields({ source: oneOf('mutation'), file: 'string', mutator: 'string', replacement: 'string', statement: 'string', reason: nullable('string') }),
  fields({ source: oneOf('fault'), file: 'string', function: nullable('string'), kind: 'string', reason: nullable('string') }),
);

/** Schema version 1. Changing this object without bumping SCHEMA_VERSION is the mistake these tests exist to catch. */
const SCHEMA_V1: Shape = fields({
  schemaVersion: 'number',
  status: oneOf('completed', 'partial', 'inconclusive', 'nothing-checkable', 'nothing-in-scope', 'error'),
  statusReason: nullable('string'),
  exitCode: 'number',
  strict: 'boolean',
  error: nullable('string'),
  level: oneOf('poke', 'prod', 'shake'),
  preset: fields({ name: oneOf('Poke', 'Prod', 'Shake'), budgetMs: 'number', mutationShare: 'number' }),
  budgetMs: 'number',
  spentMs: 'number',
  seed: 'number',
  git: nullable(fields({ base: 'string', mergeBase: 'string', head: 'string', dirty: 'boolean' })),
  scope: nullable(
    fields({
      mode: oneOf('diff', 'test-only'),
      changedSourceFiles: list('string'),
      changedTestFiles: list('string'),
      boundaryFiles: list('string'),
      ignoredFiles: list(fields({ file: 'string', reason: 'string' })),
      notes: list(fields({ file: 'string', line: 'number', message: 'string' })),
    }),
  ),
  phases: list(
    fields({
      name: oneOf('mutation', 'faults'),
      status: oneOf('completed', 'budget-exhausted', 'inconclusive', 'error', 'not-run'),
      statusReason: nullable('string'),
      detail: nullable('string'),
      budgetMs: 'number',
      spentMs: 'number',
      timings: nullable(
        anyOf(
          fields({
            batchesStarted: 'number',
            strykerStartMs: 'number',
            dryRunNetMs: 'number',
            mutantsMs: 'number',
            mutantsRun: 'number',
            msPerMutant: nullable('number'),
          }),
          fields({ discoveryMs: nullable('number'), faultRuns: 'number', faultRunsMs: 'number', msPerFaultRun: nullable('number') }),
        ),
      ),
    }),
  ),
  findings: list(fields(FINDING_FIELDS)),
  ignored: list(fields({ ...FINDING_FIELDS, ignoredBy: oneOf('baseline', 'inline'), ignoreReason: nullable('string') })),
  baseline: nullable(fields({ file: 'string', present: 'boolean', entries: 'number', stale: list(BASELINE_ENTRY), notEvaluated: list(BASELINE_ENTRY) })),
  coverage: fields({
    checked: fields({ mutants: 'number', invalidMutants: 'number', callSites: 'number' }),
    invalid: list(ITEM),
    invalidExcluded: 'boolean',
    notTested: list(fields({ file: 'string', mutants: nullable('number') })),
    skipped: list(ITEM),
    inconclusive: list(ITEM),
    conflicts: list(fields({ testFile: 'string', patched: list('string') })),
    faultSites: list(
      fields({
        file: 'string',
        line: 'number',
        column: 'number',
        functionName: nullable('string'),
        faultKind: oneOf('blackhole', 'http-500', 'malformed-json', 'connection-refused'),
        verdict: 'string',
        outcome: oneOf('handled', 'finding'),
        findingKind: nullable('string'),
        reason: 'string',
        summary: 'string',
        path: oneOf('fetch', 'http'),
        tests: list('string'),
        reachedFrom: list('string'),
      }),
    ),
  }),
});

function violations(value: unknown, shape: Shape, at = '$'): string[] {
  if (typeof shape === 'string') return typeof value === shape ? [] : [`${at}: expected ${shape}, got ${JSON.stringify(value)}`];
  if ('nullable' in shape) return value === null ? [] : violations(value, shape.nullable, at);
  if ('anyOf' in shape) {
    const attempts = shape.anyOf.map((option) => violations(value, option, at));
    return attempts.some((problems) => problems.length === 0) ? [] : (attempts[0] ?? []);
  }
  if ('oneOf' in shape) return shape.oneOf.includes(value as string) ? [] : [`${at}: ${JSON.stringify(value)} is not one of ${shape.oneOf.join(', ')}`];
  if ('list' in shape) {
    if (!Array.isArray(value)) return [`${at}: expected a list`];
    return value.flatMap((entry, index) => violations(entry, shape.list, `${at}[${index}]`));
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [`${at}: expected an object`];
  const actual = Object.keys(value).sort();
  const expected = Object.keys(shape.fields).sort();
  const keyProblems = actual.join() === expected.join() ? [] : [`${at}: keys ${actual.join(', ')} instead of ${expected.join(', ')}`];
  return [
    ...keyProblems,
    ...expected.flatMap((key) => {
      const field = shape.fields[key];
      return field === undefined ? [] : violations((value as Record<string, unknown>)[key], field, `${at}.${key}`);
    }),
  ];
}

function parsed(result: RunResult): unknown {
  return JSON.parse(renderJson(result)) as unknown;
}

const full = runResult({
  status: 'partial',
  phases: [
    {
      name: 'mutation',
      status: 'budget-exhausted',
      statusReason: 'the budget ran out before every mutant was tested',
      budgetMs: 84_000,
      spentMs: 83_900,
      timings: { batchesStarted: 1, strykerStartMs: 54_800, dryRunNetMs: 8_500, mutantsMs: 29_000, mutantsRun: 8 },
    },
    { name: 'faults', status: 'completed', statusReason: null, budgetMs: 36_000, spentMs: 11_400, timings: { discoveryMs: 11_400, faultRuns: 0, faultRunsMs: 0 } },
  ],
  scope: {
    mode: 'diff',
    changedSourceFiles: ['src/a.ts'],
    changedTestFiles: ['test/a.test.ts'],
    ignoredFiles: [{ file: 'README.md', reason: 'not-typescript' }],
    notes: [{ file: 'src/a.ts', line: 4, message: 'deleted top-level code, nothing to mutate' }],
    boundaryFiles: [],
  },
  findings: [faultFinding(), mutationFinding({ kind: 'no-coverage', severity: severityOf('no-coverage', 10) })],
  skipped: [{ source: 'mutation', file: 'src/a.ts', line: null, reason: 'mutants never planned: the budget ran out first' }],
  notTested: [{ file: 'src/a.ts', mutants: null }, { file: 'src/b.ts', mutants: 2 }],
  inconclusive: [{ source: 'fault', file: 'src/a.ts', line: 9, reason: 'the test did not reach the call site under the fault', faultKind: 'connection-refused' }],
  conflicts: [{ testFile: 'test/n.test.ts', patched: ['fetch'] }],
  faultSites: [
    faultSite(),
    faultSite({
      file: 'src/clients/ledger.ts',
      line: 12,
      column: 20,
      functionName: 'postLedgerEntry',
      faultKind: 'blackhole',
      verdict: 'hang',
      outcome: 'finding',
      findingKind: 'hang-no-timeout',
      reason: 'the call has no timeout of its own and relies on runtime transport defaults',
      summary: 'no timeout of its own',
      path: 'http',
      tests: ['test/ledger.test.ts > posts a ledger entry'],
      reachedFrom: ['src/clients/ledger.ts postLedgerEntry'],
    }),
  ],
  invalid: [{ source: 'mutation', file: 'src/a.ts', line: 6, reason: 'compile error: src/a.ts(6,3): error TS2322: Type mismatch.' }],
  ignored: [
    { finding: mutationFinding({ line: 9 }), by: 'baseline', reason: 'equivalent' },
    { finding: faultFinding({ kind: 'fire-and-forget' }), by: 'inline', reason: 'telemetry' },
  ],
  baseline: {
    file: 'bruise-baseline.json',
    present: true,
    entries: 3,
    stale: [{ source: 'mutation', file: 'src/a.ts', mutator: 'EqualityOperator', replacement: 'a > b', statement: '0123456789abcdef', reason: null }],
    notEvaluated: [{ source: 'fault', file: 'src/b.ts', function: null, kind: 'hang-no-timeout', reason: 'slow upstream' }],
  },
});

describe('JSON report schema', () => {
  it('is version 1', () => {
    expect(SCHEMA_VERSION).toBe(1);
    expect(toJsonReport(full).schemaVersion).toBe(1);
  });

  it('matches the version 1 shape exactly for a run with every kind of entry', () => {
    expect(violations(parsed(full), SCHEMA_V1)).toEqual([]);
  });

  it('matches the version 1 shape for a tool error, with git and scope null', () => {
    const error = runResult({ status: 'error', error: 'base ref missing', git: null, scope: null, phases: [], findings: [] });
    expect(violations(parsed(error), SCHEMA_V1)).toEqual([]);
    expect(parsed(error)).toMatchObject({ git: null, scope: null, error: 'base ref missing', exitCode: 2 });
  });

  it('fails the shape check when a field goes missing or changes type', () => {
    const report = parsed(full) as Record<string, unknown>;
    expect(violations({ ...report, seed: '42' }, SCHEMA_V1)).toEqual(['$.seed: expected number, got "42"']);
    const withoutLevel: Record<string, unknown> = { ...report };
    delete withoutLevel['level'];
    expect(violations(withoutLevel, SCHEMA_V1)[0]).toContain('$: keys');
  });

  it('carries the exit code of the run, with and without --strict', () => {
    for (const status of ['completed', 'partial', 'inconclusive', 'nothing-in-scope', 'error'] as const) {
      const result = runResult({ status, findings: status === 'nothing-in-scope' ? [] : full.findings });
      expect(toJsonReport(result).exitCode).toBe(exitCodeOf(result));
      expect(toJsonReport(result, { strict: true }).exitCode).toBe(exitCodeOf(result, { strict: true }));
    }
    expect(toJsonReport(runResult({ findings: [] })).exitCode).toBe(0);
    expect(toJsonReport(runResult()).exitCode).toBe(1);
    expect(toJsonReport(full)).toMatchObject({ exitCode: 1, strict: false });
    expect(toJsonReport(full, { strict: true })).toMatchObject({ exitCode: 2, strict: true });
  });

  it('gives each phase the breakdown of where its time went', () => {
    expect(toJsonReport(full).phases.map((entry) => entry.timings)).toEqual([
      { batchesStarted: 1, strykerStartMs: 54_800, dryRunNetMs: 8_500, mutantsMs: 29_000, mutantsRun: 8, msPerMutant: 3625 },
      { discoveryMs: 11_400, faultRuns: 0, faultRunsMs: 0, msPerFaultRun: null },
    ]);
    expect(toJsonReport(runResult()).phases.map((entry) => entry.timings)).toEqual([null, null]);
  });

  it('lists what was checked and every gap in the coverage section', () => {
    expect(toJsonReport(full).coverage).toEqual({
      checked: { mutants: 12, invalidMutants: 0, callSites: 3 },
      invalid: [{ source: 'mutation', file: 'src/a.ts', line: 6, reason: 'compile error: src/a.ts(6,3): error TS2322: Type mismatch.', faultKind: null }],
      invalidExcluded: false,
      notTested: [{ file: 'src/a.ts', mutants: null }, { file: 'src/b.ts', mutants: 2 }],
      skipped: [{ source: 'mutation', file: 'src/a.ts', line: null, reason: 'mutants never planned: the budget ran out first', faultKind: null }],
      inconclusive: [{ source: 'fault', file: 'src/a.ts', line: 9, reason: 'the test did not reach the call site under the fault', faultKind: 'connection-refused' }],
      conflicts: [{ testFile: 'test/n.test.ts', patched: ['fetch'] }],
      faultSites: [
        {
          file: 'src/clients/profile.ts',
          line: 7,
          column: 26,
          functionName: 'fetchProfile',
          faultKind: 'http-500',
          verdict: 'status-checked',
          outcome: 'handled',
          findingKind: null,
          reason:
            'the code checked the status of the 500 response; the code raised its own error at src/clients/profile.ts:9: Error: profile request failed with 500',
          summary: 'threw at src/clients/profile.ts:9',
          path: 'fetch',
          tests: ['test/profile.test.ts > loads a profile'],
          reachedFrom: ['src/clients/profile.ts fetchProfile'],
        },
        {
          file: 'src/clients/ledger.ts',
          line: 12,
          column: 20,
          functionName: 'postLedgerEntry',
          faultKind: 'blackhole',
          verdict: 'hang',
          outcome: 'finding',
          findingKind: 'hang-no-timeout',
          reason: 'the call has no timeout of its own and relies on runtime transport defaults',
          summary: 'no timeout of its own',
          path: 'http',
          tests: ['test/ledger.test.ts > posts a ledger entry'],
          reachedFrom: ['src/clients/ledger.ts postLedgerEntry'],
        },
      ],
    });
  });

  it('says whether the invalid mutants were excluded from coverage', () => {
    const excluded = runResult({ status: 'completed', checked: { mutants: 7, invalidMutants: 3, callSites: 0 }, invalid: full.invalid, invalidExcluded: true });
    expect(toJsonReport(excluded)).toMatchObject({ status: 'completed', exitCode: 1, coverage: { invalidExcluded: true } });
    expect(toJsonReport(excluded, { strict: true }).exitCode).toBe(1);
  });

  it('keeps every finding, in ranked order, with its detail', () => {
    const report = toJsonReport(full);
    expect(report.findings.map((finding) => [finding.kind, finding.severity.score])).toEqual([
      ['hang-no-timeout', 70],
      ['no-coverage', 55],
    ]);
    expect(report.findings[0]?.fault).toEqual({
      kind: 'blackhole',
      verdict: 'hang',
      path: 'http',
      tests: ['test/ledger.test.ts > posts a ledger entry'],
      reachedFrom: [],
      notFaultedFrom: [],
    });
    expect(report.findings[1]?.mutation).toMatchObject({ replacement: 'orderTotal > 120', coveredBy: ['test/discount.test.ts#applies'] });
  });

  it('lists every ignored finding with what ignored it and why, apart from the findings', () => {
    const report = toJsonReport(full);
    expect(report.ignored.map((entry) => [entry.kind, entry.ignoredBy, entry.ignoreReason])).toEqual([
      ['survived', 'baseline', 'equivalent'],
      ['fire-and-forget', 'inline', 'telemetry'],
    ]);
    expect(report.findings).toHaveLength(2);
    expect(report.baseline).toMatchObject({ file: 'bruise-baseline.json', entries: 3, stale: [{ mutator: 'EqualityOperator' }] });
  });

  it('does not count ignored findings in the exit code', () => {
    const onlyIgnored = runResult({ findings: [], ignored: full.ignored });
    expect(toJsonReport(onlyIgnored).exitCode).toBe(0);
  });

  it('describes the preset the run used', () => {
    expect(toJsonReport(runResult({ level: 'shake' })).preset).toEqual({ name: 'Shake', budgetMs: 600_000, mutationShare: 0.65 });
  });

  it('is pretty-printed JSON ending in a newline', () => {
    const text = renderJson(full);
    expect(text.endsWith('}\n')).toBe(true);
    expect(text.startsWith('{\n  "schemaVersion": 1,')).toBe(true);
  });

  it('keeps the full error of a failed phase as detail, and rounds every duration to an integer', () => {
    const stack = 'Error: Error: boom\n    at x (y.js:1:1)';
    const report = toJsonReport(
      runResult({
        spentMs: 45_250.7,
        phases: [
          { name: 'mutation', status: 'error', statusReason: 'mutation batch 0 failed: boom', detail: stack, budgetMs: 83_668.2, spentMs: 22_000.5 },
          { name: 'faults', status: 'completed', statusReason: null, budgetMs: 100_462.8686, spentMs: 1_861.4 },
        ],
      }),
    );
    expect(report.phases).toEqual([
      { name: 'mutation', status: 'error', statusReason: 'mutation batch 0 failed: boom', detail: stack, budgetMs: 83_668, spentMs: 22_001, timings: null },
      { name: 'faults', status: 'completed', statusReason: null, detail: null, budgetMs: 100_463, spentMs: 1_861, timings: null },
    ]);
    expect(report.spentMs).toBe(45_251);
    expect(report.budgetMs).toBe(120_000);
  });
});
