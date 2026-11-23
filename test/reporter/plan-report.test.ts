import { describe, expect, it } from 'vitest';
import { PLAN_SCHEMA_VERSION, renderPlanJson, renderPlanText, SCHEMA_VERSION } from '../../src/reporter/index.js';
import { runPlan } from '../helpers/run-fixtures.js';

describe('plan text report', () => {
  const text = renderPlanText(runPlan());

  it('says that nothing was run', () => {
    expect(text).toMatch(/^Plan for a Poke run, seed 7; nothing was run/);
    expect(text.trimEnd().split('\n').at(-1)).toBe('Result: plan only, nothing was run (exit 0)');
  });

  it('lists the files in scope and every ignored file with its reason', () => {
    expect(text).toContain('  src/a.ts\n  src/b.ts\n  test/a.test.ts (test)');
    expect(text).toContain('  README.md: not TypeScript');
    expect(text).toContain('  vitest.config.ts: a tooling config file');
  });

  it('gives the mutant count per file, or why it is unavailable', () => {
    expect(text).toContain('  src/a.ts: 8 mutants (2 in module-level code)');
    expect(text).toContain('  src/b.ts: count unavailable: Unexpected token (1:5)');
    expect(text).toContain('Mutants: total unavailable');
    expect(text).toContain('static mutants are only tested at Shake');
  });

  it('lists the batches, the calls, the preset caps and the budget split', () => {
    expect(text).toContain('  batch 1: src/a.ts, src/b.ts');
    expect(text).toContain('  src/a.ts:12 fetch (changed line)');
    expect(text).toContain('at most 3 call sites, 1 test each');
    expect(text).toContain('Budget: 120.0 s; mutation 84.0 s, faults 36.0 s plus what the mutation phase leaves unused');
  });

  it('labels the estimate as one and shows its derivation', () => {
    expect(text).toContain('Estimate (rough, not measured): about 30.0 s');
    expect(text).toContain('  mutation: 1 batch x 10 s assumed Stryker start');
  });

  it('shows the reason a run would fail and a phase that would not run', () => {
    const blocked = renderPlanText(
      runPlan({
        runWouldFail: 'no Vitest config found in /work',
        faults: { calls: [], kinds: ['blackhole'], maxCallSites: 3, testsPerCallSite: 1, notRun: 'only test files changed' },
      }),
    );
    expect(blocked).toContain('A run would stop here: no Vitest config found in /work');
    expect(blocked).toContain('Fault phase: would not run: only test files changed');
  });

  it('reports an error and exit 2 when the plan cannot be computed', () => {
    const failed = renderPlanText(runPlan({ status: 'error', error: 'base ref missing\n  at x', scope: null, git: null, mutation: null, faults: null, estimate: null }));
    expect(failed).toContain('Error: base ref missing');
    expect(failed).not.toContain('at x');
    expect(failed.trimEnd().split('\n').at(-1)).toBe('Result: the plan could not be computed (exit 2)');
  });
});

describe('plan JSON report', () => {
  it('has its own schema version and marks itself as a plan', () => {
    const json = JSON.parse(renderPlanJson(runPlan())) as Record<string, unknown>;
    expect(json).toMatchObject({ report: 'plan', schemaVersion: PLAN_SCHEMA_VERSION, exitCode: 0, status: 'planned', seed: 7 });
    expect(PLAN_SCHEMA_VERSION).toBe(1);
    expect(SCHEMA_VERSION).toBe(1);
  });

  it('keeps every field a reader needs', () => {
    const json = JSON.parse(renderPlanJson(runPlan())) as Record<string, unknown>;
    expect(Object.keys(json)).toEqual([
      'report',
      'schemaVersion',
      'status',
      'exitCode',
      'error',
      'level',
      'preset',
      'seed',
      'git',
      'scope',
      'vitestConfig',
      'runWouldFail',
      'mutation',
      'faults',
      'budget',
      'estimate',
    ]);
    expect(json.estimate).toMatchObject({ isEstimate: true, totalMs: 30_000 });
    expect(json.mutation).toMatchObject({ total: null, files: [{ file: 'src/a.ts', mutants: 8 }, { file: 'src/b.ts', mutants: null }] });
  });

  it('reports exit 2 for a plan that could not be computed', () => {
    const json = JSON.parse(renderPlanJson(runPlan({ status: 'error', error: 'boom', mutation: null, faults: null, estimate: null }))) as Record<string, unknown>;
    expect(json).toMatchObject({ exitCode: 2, error: 'boom', mutation: null, estimate: null });
  });
});
