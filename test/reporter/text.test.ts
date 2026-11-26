import { describe, expect, it } from 'vitest';
import { renderText } from '../../src/reporter/index.js';
import { faultFinding, mutationFinding, runResult } from '../helpers/run-fixtures.js';

const PRINTABLE = /^[\n\x20-\x7e]*$/;

describe('text report', () => {
  it('renders a complete run with findings, most severe first', () => {
    expect(renderText(runResult())).toBe(
      [
        'Poke run, budget 120.0 s, spent 45.3 s, seed 42',
        'Diff: 2222222 against origin/main (merge base 1111111)',
        '',
        'Scope: 2 changed source files, 0 changed test files',
        '  src/clients/ledger.ts',
        '  src/discount.ts',
        '',
        'Coverage: 12 mutants and 3 call sites checked',
        '  nothing in scope was left unchecked',
        '',
        'Findings, most severe first:',
        '  1. [high 70] src/clients/ledger.ts:12:20 in postLedgerEntry',
        '    hang-no-timeout: the call has no timeout of its own and relies on runtime transport defaults',
        '    faulted with blackhole under: test/ledger.test.ts > posts a ledger entry',
        '  2. [medium 55] src/discount.ts:3:7',
        '    survived: EqualityOperator mutant survived every test that covers it: orderTotal > 120',
        '',
        'Phases:',
        '  mutation completed 30.0 s of 84.0 s',
        '  faults completed 15.0 s of 90.0 s',
        '',
        'Result: 2 findings (exit 1)',
        '',
      ].join('\n'),
    );
  });

  it('shows up to 20 findings at every level and says how many more there are', () => {
    const findings = Array.from({ length: 22 }, (_, index) => mutationFinding({ line: index + 1 }));
    for (const level of ['poke', 'prod', 'shake'] as const) {
      const text = renderText(runResult({ level, findings }));
      expect(text).toContain('  20. [medium 55] src/discount.ts:20:7');
      expect(text).not.toContain('src/discount.ts:21:7');
      expect(text).toContain('  2 more findings not shown; --all-findings or --json lists every finding');
    }
  });

  it("names the changed callers a fault site was reached through, but not the site's own function", () => {
    const fault = faultFinding().fault;
    if (fault === null) throw new Error('a fault finding has fault detail');
    const own = renderText(runResult({ findings: [faultFinding({ fault: { ...fault, reachedFrom: ['src/clients/ledger.ts postLedgerEntry'] } })] }));
    expect(own).not.toContain('reached from changed code');
    const wrapper = renderText(runResult({ findings: [faultFinding({ fault: { ...fault, reachedFrom: ['src/checkout.ts checkout'] } })] }));
    expect(wrapper).toContain('    reached from changed code: src/checkout.ts checkout');
  });

  it('lists every finding with allFindings', () => {
    const findings = Array.from({ length: 22 }, (_, index) => mutationFinding({ line: index + 1 }));
    const text = renderText(runResult({ findings }), { allFindings: true });
    expect(text).toContain('  22. [medium 55] src/discount.ts:22:7');
    expect(text).not.toContain('not shown');
  });

  it('groups skipped items by reason and lists inconclusive items and conflicts one per line', () => {
    const text = renderText(
      runResult({
        status: 'partial',
        findings: [],
        skipped: [
          { source: 'mutation', file: 'src/a.ts', line: 2, reason: 'not tested: budget' },
          { source: 'mutation', file: 'src/a.ts', line: 5, reason: 'not tested: budget' },
          { source: 'fault', file: 'src/b.ts', line: 3, reason: 'not faulted: over the preset cap of 3 call sites' },
        ],
        inconclusive: [{ source: 'fault', file: 'src/c.ts', line: 7, reason: 'the test did not reach the call site under the fault' }],
        conflicts: [{ testFile: 'test/n.test.ts', patched: ['fetch'] }],
      }),
    );
    expect(text).toContain(
      [
        'Skipped (3):',
        '  mutation: not tested: budget (2 items)',
        '    src/a.ts:2, src/a.ts:5',
        '  fault: not faulted: over the preset cap of 3 call sites (1 item)',
        '    src/b.ts:3',
        '',
        'Inconclusive (1):',
        '  src/c.ts:7 fault: the test did not reach the call site under the fault',
        '',
        'Conflicts, calls made under these test files were not faulted:',
        '  test/n.test.ts replaces fetch',
      ].join('\n'),
    );
    expect(text).toContain('  NOT CHECKED: 3 skipped, 1 inconclusive, 1 conflicting test file; each is listed below');
    expect(text.trimEnd().endsWith('Result: 0 findings, coverage partial: 5 not checked, listed above (exit 0; 2 with --strict)')).toBe(
      true,
    );
  });

  it('puts the coverage summary before the findings', () => {
    const text = renderText(runResult({ status: 'partial', inconclusive: [{ source: 'fault', file: 'src/c.ts', line: 7, reason: 'x' }] }));
    expect(text.indexOf('NOT CHECKED')).toBeGreaterThan(-1);
    expect(text.indexOf('NOT CHECKED')).toBeLessThan(text.indexOf('Findings, most severe first:'));
  });

  it('says what the exit code is under --strict', () => {
    const partial = runResult({ status: 'partial', skipped: [{ source: 'fault', file: 'src/b.ts', line: 3, reason: 'over the cap' }] });
    expect(renderText(partial)).toContain('Result: 2 findings, coverage partial: 1 not checked, listed above (exit 1; 2 with --strict)');
    expect(renderText(partial, { strict: true })).toContain(
      'Result: 2 findings, coverage partial: 1 not checked, listed above (exit 2, --strict)',
    );
    expect(renderText(runResult(), { strict: true })).toContain('Result: 2 findings (exit 1)');
  });

  it('reports a run that is inconclusive as a whole', () => {
    const text = renderText(runResult({ status: 'inconclusive', findings: [], checked: { mutants: 0, invalidMutants: 0, callSites: 0 } }));
    expect(text).toContain('Coverage: 0 mutants and 0 call sites checked');
    expect(text).toContain('Result: inconclusive, a phase failed or nothing in scope could be checked; 0 findings (exit 2)');
  });

  it('lists invalid mutants grouped by why they could not run', () => {
    const text = renderText(
      runResult({
        status: 'partial',
        checked: { mutants: 0, invalidMutants: 3, callSites: 0 },
        skipped: [{ source: 'mutation', file: 'src/b.ts', line: 4, reason: 'not tested: budget' }],
        invalid: [
          { source: 'mutation', file: 'src/a.ts', line: 2, reason: "compile error: src/a.ts(2,7): error TS2345: Argument of type 'unknown'." },
          { source: 'mutation', file: 'src/a.ts', line: 2, reason: "compile error: src/a.ts(2,7): error TS2345: Argument of type 'unknown'." },
          { source: 'mutation', file: 'src/a.ts', line: 3, reason: 'runtime error: TypeError: total is not a function' },
        ],
      }),
    );
    expect(text).toContain(
      [
        'Invalid mutants (3):',
        "  compile error: src/a.ts(2,7): error TS2345: Argument of type 'unknown'. (2 items)",
        '    src/a.ts:2',
        '  runtime error: TypeError: total is not a function (1 item)',
        '    src/a.ts:3',
      ].join('\n'),
    );
    expect(text.indexOf('Findings, most severe first:')).toBeLessThan(text.indexOf('Skipped (1):'));
    expect(text.indexOf('Skipped (1):')).toBeLessThan(text.indexOf('Invalid mutants (3):'));
    expect(text).toContain('  3 invalid mutants failed to compile or crashed the runner; each is listed below');
  });

  it('counts invalid mutants separately', () => {
    const text = renderText(runResult({ checked: { mutants: 4, invalidMutants: 2, callSites: 0 } }));
    expect(text).toContain(
      ['Coverage: 4 mutants and 0 call sites checked', '  2 invalid mutants failed to compile or crashed the runner'].join('\n'),
    );
  });

  it('says excluded invalid mutants are not a gap, and notes them in the Result line of a completed run', () => {
    const invalid = [{ source: 'mutation' as const, file: 'src/a.ts', line: 2, reason: 'compile error: src/a.ts(2,7): error TS2322: nope' }];
    const result = runResult({ checked: { mutants: 7, invalidMutants: 3, callSites: 0 }, invalid: [...invalid, ...invalid, ...invalid], invalidExcluded: true });
    const text = renderText(result);
    expect(text).toContain('  3 invalid mutants failed to compile or crashed the runner; excluded from coverage, each is listed below');
    expect(text).not.toContain('NOT CHECKED');
    expect(text).toContain('Result: 2 findings, coverage complete, 3 invalid mutants excluded (exit 1)');
  });

  it('shows a phase that ran out of budget or did not run, with its reason', () => {
    const text = renderText(
      runResult({
        status: 'partial',
        phases: [
          {
            name: 'mutation',
            status: 'budget-exhausted',
            statusReason: 'the budget ran out before every mutant was tested',
            budgetMs: 84_000,
            spentMs: 84_100,
          },
          { name: 'faults', status: 'not-run', statusReason: 'no TypeScript source in scope to fault', budgetMs: 0, spentMs: 0 },
        ],
      }),
    );
    expect(text).toContain('  mutation budget-exhausted 84.1 s of 84.0 s: the budget ran out before every mutant was tested');
    expect(text).toContain('  faults not-run: no TypeScript source in scope to fault');
    expect(text).toContain(
      '  NOT CHECKED: the mutation phase ended budget-exhausted: the budget ran out before every mutant was tested',
    );
    expect(text).not.toContain('NOT CHECKED: the faults phase');
  });

  it('says clean only when nothing was found and nothing was left unevaluated', () => {
    expect(renderText(runResult({ findings: [] }))).toContain('Result: clean, everything in scope was checked (exit 0)');
  });

  it('reports a tool error with its message', () => {
    const text = renderText(
      runResult({ status: 'error', error: "base ref 'origin/main' does not resolve", git: null, scope: null, phases: [], findings: [] }),
    );
    expect(text).toBe(
      [
        'Poke run, budget 120.0 s, spent 45.3 s, seed 42',
        '',
        "Error: base ref 'origin/main' does not resolve",
        '',
        'Result: tool error (exit 2)',
        '',
      ].join('\n'),
    );
  });

  it('reports nothing in scope', () => {
    const text = renderText(runResult({ status: 'nothing-in-scope', findings: [] }));
    expect(text).toContain('Result: nothing in scope (exit 0)');
  });

  it('describes a test-only run by the source it reached', () => {
    const text = renderText(
      runResult({
        scope: {
          mode: 'test-only',
          changedSourceFiles: [],
          changedTestFiles: ['test/refund-cap.test.ts'],
          ignoredFiles: [],
          notes: [],
          boundaryFiles: ['src/payments/refund.ts'],
        },
      }),
    );
    expect(text).toContain(
      [
        'Scope: only test files changed; mutating the source they reach',
        '  test/refund-cap.test.ts (test)',
        '  src/payments/refund.ts (reached by a changed test)',
      ].join('\n'),
    );
  });

  it('lists the config files it kept out of scope', () => {
    const base = runResult();
    const scope = base.scope === null ? null : { ...base.scope, ignoredFiles: [...base.scope.ignoredFiles, { file: 'vitest.config.ts', reason: 'config-file' as const }] };
    const text = renderText(runResult({ scope }));
    expect(text).toContain('  vitest.config.ts (not checked: a tooling config file)');
    expect(text).not.toContain('README.md');
  });

  it('mentions uncommitted changes', () => {
    const base = runResult();
    const text = renderText(runResult({ git: base.git === null ? null : { ...base.git, dirty: true } }));
    expect(text).toContain('(merge base 1111111), with uncommitted changes');
  });

  it('uses plain printable ASCII only: no color codes, no emoji', () => {
    const noisy = runResult({
      status: 'partial',
      skipped: [{ source: 'mutation', file: 'src/a.ts', line: null, reason: 'mutants never planned: the budget ran out first' }],
    });
    for (const text of [renderText(runResult()), renderText(noisy)]) expect(text).toMatch(PRINTABLE);
  });

  it('reports a nothing-checkable run with its reason, never as clean', () => {
    const result = runResult({
      status: 'nothing-checkable',
      statusReason: 'the changed code produces no mutants at this level and makes no outgoing calls',
      findings: [],
      checked: { mutants: 0, invalidMutants: 0, callSites: 0 },
    });
    const text = renderText(result);
    expect(text).toContain(
      'Result: nothing checkable, the changed code produces no mutants at this level and makes no outgoing calls (exit 0; 2 with --strict)',
    );
    expect(text).not.toContain('clean');
    expect(text).not.toContain('nothing in scope was left unchecked');
    expect(renderText(result, { strict: true })).toContain('(exit 2, --strict)');
  });

  it('gives the reason of an inconclusive run', () => {
    const text = renderText(
      runResult({ status: 'inconclusive', statusReason: 'no mutant in scope could run', findings: [], checked: { mutants: 0, invalidMutants: 2, callSites: 0 } }),
    );
    expect(text).toContain('Result: inconclusive, no mutant in scope could run; 0 findings (exit 2)');
  });

  it('shows a failed phase error as its first line, once, without repeated error prefixes', () => {
    const stack = 'Error: Error: boom from config\nError: boom from config\n    at file:///x.mjs:4:7';
    const text = renderText(
      runResult({
        status: 'inconclusive',
        statusReason: 'the mutation phase failed',
        findings: [],
        phases: [
          { name: 'mutation', status: 'error', statusReason: 'mutation batch 0 failed: boom from config', detail: stack, budgetMs: 84_000, spentMs: 22_000 },
          { name: 'faults', status: 'error', statusReason: 'Error: boom from config\n    at file:///x.mjs:4:7', budgetMs: 97_000, spentMs: 2_000 },
        ],
      }),
    );
    expect(text.split('boom from config').length - 1).toBe(2);
    expect(text).not.toContain('Error: Error:');
    expect(text).not.toContain('at file:///');
    expect(text).toContain('  mutation error 22.0 s of 84.0 s: mutation batch 0 failed: boom from config');
    expect(text).toContain('  faults error 2.0 s of 97.0 s: boom from config');
    expect(text).toContain('  NOT CHECKED: the mutation phase ended error; the reason is under Phases');
  });

  it('shows only the first line of a tool error', () => {
    const text = renderText(runResult({ status: 'error', error: 'Error: Error: no config\n    at x (y.js:1:1)', git: null, scope: null, phases: [], findings: [] }));
    expect(text).toContain('Error: no config\n');
    expect(text).not.toContain('at x (y.js:1:1)');
  });
});

describe('ignored findings in the text report', () => {
  const ignored = [
    { finding: mutationFinding({ line: 9 }), by: 'baseline' as const, reason: 'equivalent' },
    { finding: mutationFinding({ line: 11 }), by: 'baseline' as const, reason: null },
    { finding: faultFinding({ kind: 'fire-and-forget' }), by: 'inline' as const, reason: 'telemetry' },
  ];

  it('says how many findings were ignored and by what, so none is silent', () => {
    const text = renderText(runResult({ ignored }));
    expect(text).toContain('3 findings ignored (baseline: 2, inline: 1); --json lists them');
    expect(text).toContain('Result: 2 findings, 3 ignored (exit 1)');
  });

  it('still says what was ignored on an otherwise clean run', () => {
    const text = renderText(runResult({ findings: [], ignored: ignored.slice(0, 1) }));
    expect(text).toContain('1 finding ignored (baseline: 1, inline: 0); --json lists them');
    expect(text).toContain('Result: clean, everything in scope was checked; 1 finding ignored (exit 0)');
  });

  it('lists stale baseline entries and the command that removes them, without failing', () => {
    const text = renderText(
      runResult({
        findings: [],
        baseline: {
          file: 'bruise-baseline.json',
          present: true,
          entries: 2,
          stale: [
            { source: 'mutation', file: 'src/a.ts', mutator: 'EqualityOperator', replacement: 'a > b', statement: '0123456789abcdef', reason: null },
            { source: 'fault', file: 'src/b.ts', function: 'load', kind: 'hang-no-timeout', reason: 'slow upstream' },
          ],
          notEvaluated: [],
        },
      }),
    );
    expect(text).toContain('Stale baseline entries (2), matching nothing in scope any more; bruise baseline --prune removes them:');
    expect(text).toContain('  src/a.ts: EqualityOperator mutant a > b');
    expect(text).toContain('  src/b.ts: hang-no-timeout in load');
    expect(text).toContain('Result: clean, everything in scope was checked (exit 0)');
  });

  it('lists entries it could not evaluate', () => {
    const text = renderText(
      runResult({
        baseline: {
          file: 'bruise-baseline.json',
          present: true,
          entries: 1,
          stale: [],
          notEvaluated: [{ source: 'fault', file: 'src/b.ts', function: null, kind: 'fire-and-forget', reason: null }],
        },
      }),
    );
    expect(text).toContain('Baseline entries not evaluated (1), their code was in scope but not fully checked:');
    expect(text).toContain('  src/b.ts: fire-and-forget in an anonymous function');
  });

  it('says nothing about ignores when there are none', () => {
    expect(renderText(runResult())).not.toContain('ignored');
  });
});

describe('fault kinds in the text report', () => {
  it('names the fault kind of a finding, an inconclusive site and a skipped one', () => {
    const text = renderText(
      runResult({
        status: 'partial',
        findings: [
          faultFinding({
            kind: 'refusal-mishandled',
            message: 'the test failed after the connection was refused',
            fault: { kind: 'connection-refused', verdict: 'refusal-mishandled', path: 'fetch', tests: ['test/a.test.ts > loads'], reachedFrom: [], notFaultedFrom: [] },
          }),
        ],
        inconclusive: [{ source: 'fault', file: 'src/a.ts', line: 9, reason: 'the test did not reach the call site under the fault', faultKind: 'connection-refused' }],
        skipped: [{ source: 'fault', file: 'src/b.ts', line: 3, reason: 'not faulted: the budget ran out first', faultKind: 'blackhole' }],
      }),
    );
    expect(text).toContain('    refusal-mishandled: the test failed after the connection was refused');
    expect(text).toContain('    faulted with connection-refused under: test/a.test.ts > loads');
    expect(text).toContain('  src/a.ts:9 fault (connection-refused): the test did not reach the call site under the fault');
    expect(text).toContain('  fault (blackhole): not faulted: the budget ran out first (1 item)');
  });
});

