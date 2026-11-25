import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BASELINE_FILE, serializeBaseline, SourceStatements } from '../../src/baseline/index.js';
import { PRESETS } from '../../src/core/index.js';
import type { FaultRunRequest } from '../../src/fault-run/index.js';
import {
  exitCodeOf,
  runBruise,
  type OrchestratorDeps,
  type RunOptions,
  type RunResult,
} from '../../src/orchestrator/index.js';
import { renderText } from '../../src/reporter/index.js';
import type { MutationRequest } from '../../src/stryker-adapter/index.js';
import { readTimings } from '../../src/timings/index.js';
import type { ProgressEvent } from '../../src/progress/events.js';
import { batch, faultRun, mutant, mutationResult, site, siteResult } from '../helpers/run-fixtures.js';
import { createTempRepo, type TempRepo } from '../helpers/temp-repo.js';

const SOURCE = 'export function total(a: number, b: number): number {\n  return a + b;\n}\n';

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function track<T extends { cleanup(): void }>(value: T): T {
  cleanups.push(() => value.cleanup());
  return value;
}

/** A repository whose branch changes one source file, with a Vitest config unless told otherwise. */
function changedRepo(options: { config?: boolean; testOnly?: boolean; changedSource?: string } = {}): TempRepo {
  const repo = track(createTempRepo());
  repo.write('package.json', '{ "type": "module" }\n');
  repo.write('src/a.ts', SOURCE);
  repo.write('test/a.test.ts', "import { it } from 'vitest';\nit('a', () => {});\n");
  if (options.config !== false) repo.write('vitest.config.ts', 'export default {};\n');
  const base = repo.commit('Base');
  repo.branch('origin/main', base);
  if (options.testOnly === true) repo.write('test/a.test.ts', "import { it } from 'vitest';\nit('a', () => {});\nit('b', () => {});\n");
  else if (options.changedSource !== undefined) repo.write('src/a.ts', options.changedSource);
  else repo.edit('src/a.ts', 'a + b', 'a - b');
  repo.commit('Change');
  return repo;
}

const fakeVitest: OrchestratorDeps['loadVitest'] = () =>
  Promise.resolve({ version: '5.1.0', node: {} as Awaited<ReturnType<OrchestratorDeps['loadVitest']>>['node'] });

interface Harness {
  readonly mutationRequests: MutationRequest[];
  readonly faultRequests: FaultRunRequest[];
  advance(ms: number): void;
  options(overrides?: Partial<RunOptions>): RunOptions;
}

function harness(repo: TempRepo, deps: Partial<OrchestratorDeps> = {}): Harness {
  let clock = 0;
  const mutationRequests: MutationRequest[] = [];
  const faultRequests: FaultRunRequest[] = [];
  const runMutation = deps.runMutation ?? (() => Promise.resolve(mutationResult()));
  const runFaults = deps.runFaults ?? (() => Promise.resolve(faultRun()));
  const wrapped: Partial<OrchestratorDeps> = {
    loadVitest: fakeVitest,
    ...deps,
    runMutation: (request) => {
      mutationRequests.push(request);
      return runMutation(request);
    },
    runFaults: (request) => {
      faultRequests.push(request);
      return runFaults(request);
    },
  };
  return {
    mutationRequests,
    faultRequests,
    advance: (ms) => {
      clock += ms;
    },
    options: (overrides = {}) => ({ cwd: repo.dir, level: 'poke', seed: 7, now: () => clock, deps: wrapped, ...overrides }),
  };
}

function phase(result: RunResult, name: 'mutation' | 'faults') {
  return result.phases.find((entry) => entry.name === name);
}

describe('preconditions', () => {
  it('reports a directory outside any git repository as a tool error', async () => {
    const dir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'bruise-nogit-'));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const result = await runBruise({ cwd: dir, level: 'poke', seed: 1 });
    expect(result).toMatchObject({ status: 'error', git: null, scope: null, phases: [], findings: [], seed: 1 });
    expect(result.error).toContain('is not inside a git repository');
    expect(exitCodeOf(result)).toBe(2);
  });

  it('reports a directory that does not exist as a tool error', async () => {
    const result = await runBruise({ cwd: path.join(os.tmpdir(), 'bruise-missing-dir-x'), level: 'poke' });
    expect(result.status).toBe('error');
    expect(result.error).toContain('is not a directory');
  });

  it('reports a missing base ref as a tool error', async () => {
    const repo = changedRepo();
    const result = await runBruise({ cwd: repo.dir, level: 'poke', base: 'origin/nope' });
    expect(result.status).toBe('error');
    expect(result.error).toBe(`base ref 'origin/nope' does not resolve to a commit in ${repo.dir}; fetch it or pass --base <ref>`);
    expect(exitCodeOf(result)).toBe(2);
  });

  it('reports a target without a Vitest config as a tool error, after scoping', async () => {
    const repo = changedRepo({ config: false });
    const run = harness(repo);
    const result = await runBruise(run.options());
    expect(result.status).toBe('error');
    expect(result.error).toContain('no Vitest config found in');
    expect(result.scope?.changedSourceFiles).toEqual(['src/a.ts']);
    expect(run.mutationRequests).toEqual([]);
    expect(exitCodeOf(result)).toBe(2);
  });

  it('checks the target Vitest version on a test-only run too, before any phase runs', async () => {
    const repo = changedRepo({ testOnly: true });
    const run = harness(repo, {
      computeBoundary: () => ({ files: [{ file: 'src/a.ts', distance: 1 }], truncated: 0, mocked: [], sourceRoot: 'src' }),
      loadVitest: () => Promise.reject(new Error(`Vitest 3.2.4 in ${repo.dir} is not supported; bruise needs Vitest >=4.1 <6`)),
    });
    const result = await runBruise(run.options());
    expect(result).toMatchObject({ status: 'error', phases: [] });
    expect(result.error).toContain('Vitest 3.2.4');
    expect(run.mutationRequests).toEqual([]);
  });

  it('reports a target whose Vitest cannot be loaded as a tool error before any phase runs', async () => {
    const repo = changedRepo();
    const run = harness(repo, { loadVitest: () => Promise.reject(new Error(`Vitest is not installed in ${repo.dir}`)) });
    const result = await runBruise(run.options());
    expect(result).toMatchObject({ status: 'error', error: `Vitest is not installed in ${repo.dir}`, phases: [] });
    expect(run.mutationRequests).toEqual([]);
  });

  it('reports nothing in scope, without needing a Vitest config, when the branch changes no TypeScript', async () => {
    const repo = track(createTempRepo());
    repo.write('README.md', 'one\n');
    repo.branch('origin/main', repo.commit('Base'));
    repo.write('README.md', 'two\n');
    repo.commit('Docs');
    const result = await runBruise({ cwd: repo.dir, level: 'poke' });
    expect(result.status).toBe('nothing-in-scope');
    expect(result.phases.map((entry) => [entry.name, entry.status])).toEqual([
      ['mutation', 'not-run'],
      ['faults', 'not-run'],
    ]);
    expect(result.scope?.ignoredFiles).toEqual([{ file: 'README.md', reason: 'not-typescript' }]);
    expect(exitCodeOf(result)).toBe(0);
  });
});

describe('budget split', () => {
  it('gives the mutation phase its share and the fault phase everything left', async () => {
    const repo = changedRepo();
    const run = harness(repo, {
      runMutation: () => {
        run.advance(10_000);
        return Promise.resolve(mutationResult());
      },
    });
    const result = await runBruise(run.options());
    const total = PRESETS[1].budgetMs;
    expect(run.mutationRequests.map((request) => request.budgetMs)).toEqual([Math.floor(total * PRESETS[1].mutationShare)]);
    expect(run.faultRequests.map((request) => request.budgetMs)).toEqual([total - 10_000]);
    expect(phase(result, 'mutation')).toMatchObject({ status: 'completed', spentMs: 10_000 });
    expect(phase(result, 'faults')).toMatchObject({ status: 'completed', budgetMs: total - 10_000 });
  });

  it('splits by the preset share at every level', async () => {
    const repo = changedRepo();
    for (const [level, intensity] of [['prod', 2], ['shake', 3]] as const) {
      const run = harness(repo);
      await runBruise(run.options({ level }));
      const preset = PRESETS[intensity];
      expect(run.mutationRequests[0]?.budgetMs).toBe(Math.floor(preset.budgetMs * preset.mutationShare));
      expect(run.mutationRequests[0]?.intensity).toBe(intensity);
    }
  });

  it('gives the whole budget to mutation when only test files changed', async () => {
    const repo = changedRepo({ testOnly: true });
    const run = harness(repo, {
      computeBoundary: () => ({ files: [{ file: 'src/a.ts', distance: 1 }], truncated: 0, mocked: [], sourceRoot: 'src' }),
      runMutation: () =>
        Promise.resolve(mutationResult({ mutants: [mutant({ status: 'Killed', scopeKind: 'test-boundary', killedBy: ['test/a.test.ts#a'] })] })),
    });
    const result = await runBruise(run.options());
    expect(result.scope).toMatchObject({ mode: 'test-only', boundaryFiles: ['src/a.ts'], changedTestFiles: ['test/a.test.ts'] });
    expect(run.mutationRequests.map((request) => [request.budgetMs, request.ranges.map((range) => range.kind)])).toEqual([
      [PRESETS[1].budgetMs, ['test-boundary']],
    ]);
    expect(run.faultRequests).toEqual([]);
    expect(phase(result, 'faults')).toMatchObject({ status: 'not-run' });
    expect(result.status).toBe('completed');
  });

  it('counts the scoping time against the budget', async () => {
    const repo = changedRepo();
    const run = harness(repo);
    const options = run.options();
    const deps = options.deps ?? {};
    await runBruise({
      ...options,
      deps: {
        ...deps,
        scopeDiff: async (scopeOptions) => {
          const { scopeDiff } = await import('../../src/diff-scoper/index.js');
          const scope = await scopeDiff(scopeOptions);
          run.advance(20_000);
          return scope;
        },
      },
    });
    expect(run.mutationRequests[0]?.budgetMs).toBe(Math.floor((PRESETS[1].budgetMs - 20_000) * PRESETS[1].mutationShare));
  });
});

const killed = mutant({ status: 'Killed', killedBy: ['test/a.test.ts#a'], start: { line: 1, column: 1 } });

/** The exit code without and with --strict. */
function exits(result: RunResult): [number, number] {
  return [exitCodeOf(result), exitCodeOf(result, { strict: true })];
}

describe('budget exhaustion', () => {
  it('reports a mutation phase cut short as partial, lists what it left untested, and exits by findings', async () => {
    const repo = changedRepo();
    const run = harness(repo, {
      runMutation: () =>
        Promise.resolve(
          mutationResult({
            mutants: [killed, mutant({ status: 'NotTested', statusReason: 'not tested: budget' })],
            batches: [batch({ outcome: 'killed-budget' }), batch({ index: 1, files: ['src/b.ts'], outcome: 'not-launched', planned: null })],
            notTested: { reason: 'budget', mutants: 1, unplannedFiles: ['src/b.ts'] },
          }),
        ),
    });
    const result = await runBruise(run.options());
    expect(phase(result, 'mutation')).toMatchObject({
      status: 'budget-exhausted',
      statusReason: 'the budget ran out before every mutant was tested',
    });
    expect(result.skipped).toEqual([
      { source: 'mutation', file: 'src/a.ts', line: 2, reason: 'not tested: budget' },
      { source: 'mutation', file: 'src/b.ts', line: null, reason: 'mutants never planned: the budget ran out first' },
    ]);
    expect(result.notTested).toEqual([
      { file: 'src/a.ts', mutants: 1 },
      { file: 'src/b.ts', mutants: null },
    ]);
    expect(result.checked).toEqual({ mutants: 1, invalidMutants: 0, callSites: 0 });
    expect(result.status).toBe('partial');
    expect(exits(result)).toEqual([0, 2]);
    const text = renderText(result);
    expect(text).toContain(
      '  NOT CHECKED: 1 generated mutant not tested and the mutants of 1 file never planned before the budget ran out: src/a.ts (1), src/b.ts (never planned)',
    );
    expect(text).toContain('Result: 0 findings, coverage partial: 2 not checked, listed above (exit 0; 2 with --strict)');
  });

  it('reports a batch stopped at twice its share as budget-exhausted and the run as partial', async () => {
    const repo = changedRepo();
    const run = harness(repo, {
      runMutation: () => Promise.resolve(mutationResult({ mutants: [killed], batches: [batch({ outcome: 'killed-over-share' })] })),
    });
    const result = await runBruise(run.options());
    expect(phase(result, 'mutation')?.status).toBe('budget-exhausted');
    expect(result.status).toBe('partial');
    expect(exits(result)).toEqual([0, 2]);
    expect(renderText(result)).toContain(
      'Result: 0 findings, coverage partial: the mutation phase ended budget-exhausted (exit 0; 2 with --strict)',
    );
  });

  it('notes excluded invalid mutants in the Result line of a partial run without counting them as a gap', async () => {
    const repo = changedRepo();
    const invalid = mutant({ status: 'CompileError', statusReason: 'src/a.ts(2,3): error TS2322: nope' });
    const untested = mutant({ start: { line: 2, column: 9 }, status: 'NotTested', statusReason: 'not tested: budget' });
    const run = harness(repo, {
      runMutation: () =>
        Promise.resolve(
          mutationResult({
            mutants: [killed, invalid, untested],
            batches: [batch({ outcome: 'killed-budget' })],
            notTested: { reason: 'budget', mutants: 1, unplannedFiles: [] },
          }),
        ),
    });
    const result = await runBruise(run.options());
    expect(renderText(result)).toContain(
      'Result: 0 findings, coverage partial: 1 not checked, listed above; 1 invalid mutant excluded (exit 0; 2 with --strict)',
    );
  });

  it('lists every file the fault phase never got to when mutation spent the whole budget', async () => {
    const repo = changedRepo();
    const run = harness(repo, {
      runMutation: () => {
        run.advance(PRESETS[1].budgetMs + 500);
        return Promise.resolve(mutationResult({ mutants: [killed, mutant()] }));
      },
    });
    const result = await runBruise(run.options());
    expect(run.faultRequests).toEqual([]);
    expect(phase(result, 'faults')).toMatchObject({
      status: 'budget-exhausted',
      statusReason: 'no budget was left for the fault phase',
    });
    expect(result.skipped).toEqual([
      { source: 'fault', file: 'src/a.ts', line: null, reason: 'not faulted: no budget was left for the fault phase' },
    ]);
    expect(result.status).toBe('partial');
    expect(exits(result)).toEqual([1, 2]);
  });

  it('keeps the sites a budget-exhausted fault phase skipped, and exits by findings', async () => {
    const repo = changedRepo();
    const run = harness(repo, {
      runFaults: () =>
        Promise.resolve(
          faultRun({
            status: 'budget-exhausted',
            statusReason: 'the budget ran out before every call site was faulted',
            results: [siteResult({ site: site({ key: 'src/a.ts:9:1', line: 9 }) })],
            skipped: [{ site: site(), kind: 'blackhole', reason: 'budget' }],
          }),
        ),
    });
    const result = await runBruise(run.options());
    expect(phase(result, 'faults')).toMatchObject({
      status: 'budget-exhausted',
      statusReason: 'the budget ran out before every call site was faulted',
    });
    expect(result.skipped).toEqual([
      { source: 'fault', file: 'src/a.ts', line: 5, reason: 'not faulted: the budget ran out first', faultKind: 'blackhole' },
    ]);
    expect(result.checked.callSites).toBe(1);
    expect(exits(result)).toEqual([0, 2]);
  });

  it('is inconclusive as a whole, exit 2, when the budget ran out before anything was checked', async () => {
    const repo = changedRepo();
    const run = harness(repo, {
      runMutation: () =>
        Promise.resolve(
          mutationResult({
            batches: [batch({ outcome: 'killed-budget', planned: null, tested: 0 })],
            notTested: { reason: 'budget', mutants: 0, unplannedFiles: ['src/a.ts'] },
          }),
        ),
      runFaults: () => Promise.resolve(faultRun({ status: 'budget-exhausted', statusReason: 'discovery ran out of time' })),
    });
    const result = await runBruise(run.options());
    expect(result.checked).toEqual({ mutants: 0, invalidMutants: 0, callSites: 0 });
    expect(result.skipped).toEqual([
      { source: 'fault', file: 'src/a.ts', line: null, reason: 'not faulted: discovery ran out of time' },
      { source: 'mutation', file: 'src/a.ts', line: null, reason: 'mutants never planned: the budget ran out first' },
    ]);
    expect(result.status).toBe('inconclusive');
    expect(exits(result)).toEqual([2, 2]);
  });
});

describe('phase failures', () => {
  it('records a mutation phase that throws, lists its files as not checked, and exits 2', async () => {
    const repo = changedRepo();
    const run = harness(repo, {
      runMutation: () => Promise.reject(new Error('stryker exploded')),
      runFaults: () => Promise.resolve(faultRun({ results: [siteResult()] })),
    });
    const result = await runBruise(run.options());
    expect(phase(result, 'mutation')).toMatchObject({ status: 'error', statusReason: 'stryker exploded' });
    expect(phase(result, 'faults')?.status).toBe('completed');
    expect(result.skipped).toEqual([
      { source: 'mutation', file: 'src/a.ts', line: null, reason: 'not mutated: the mutation phase failed: stryker exploded' },
    ]);
    expect(result.status).toBe('inconclusive');
    expect(exits(result)).toEqual([2, 2]);
  });

  it('records a failed Stryker batch as a phase error', async () => {
    const repo = changedRepo();
    const run = harness(repo, {
      runMutation: () =>
        Promise.resolve(mutationResult({ mutants: [killed], batches: [batch({ outcome: 'failed', error: 'dry run failed' })] })),
    });
    const result = await runBruise(run.options());
    expect(phase(result, 'mutation')).toMatchObject({ status: 'error', statusReason: 'mutation batch 0 failed: dry run failed' });
    expect(exits(result)).toEqual([2, 2]);
  });

  it('records a fault phase that throws and lists its files as not checked', async () => {
    const repo = changedRepo();
    const run = harness(repo, {
      runMutation: () => Promise.resolve(mutationResult({ mutants: [killed, mutant()] })),
      runFaults: () => Promise.reject(new Error('vitest would not start')),
    });
    const result = await runBruise(run.options());
    expect(phase(result, 'faults')).toMatchObject({ status: 'error', statusReason: 'vitest would not start' });
    expect(result.skipped).toEqual([
      { source: 'fault', file: 'src/a.ts', line: null, reason: 'not faulted: the fault phase failed: vitest would not start' },
    ]);
    expect(result.findings).toHaveLength(1);
    expect(exits(result)).toEqual([2, 2]);
  });

  it('reports an inconclusive fault phase as partial when mutation checked something, listing its files', async () => {
    const repo = changedRepo();
    const run = harness(repo, {
      runMutation: () => Promise.resolve(mutationResult({ mutants: [killed] })),
      runFaults: () => Promise.resolve(faultRun({ status: 'inconclusive', statusReason: 'fetch was patched before the tests loaded' })),
    });
    const result = await runBruise(run.options());
    expect(phase(result, 'faults')).toMatchObject({ status: 'inconclusive', statusReason: 'fetch was patched before the tests loaded' });
    expect(result.skipped).toEqual([
      { source: 'fault', file: 'src/a.ts', line: null, reason: 'not faulted: fetch was patched before the tests loaded' },
    ]);
    expect(result.status).toBe('partial');
    expect(exits(result)).toEqual([0, 2]);
  });

  it('is inconclusive as a whole when nothing else was checked besides an inconclusive phase', async () => {
    const repo = changedRepo();
    const run = harness(repo, {
      runFaults: () => Promise.resolve(faultRun({ status: 'inconclusive', statusReason: 'fetch was patched before the tests loaded' })),
    });
    const result = await runBruise(run.options());
    expect(result.status).toBe('inconclusive');
    expect(exits(result)).toEqual([2, 2]);
  });
});

describe('findings', () => {
  it('ranks findings from both phases on one scale and exits 1 when everything was checked', async () => {
    const repo = changedRepo();
    const run = harness(repo, {
      runMutation: () => Promise.resolve(mutationResult({ mutants: [mutant(), killed] })),
      runFaults: () =>
        Promise.resolve(
          faultRun({
            results: [
              siteResult({ verdict: 'hang', findingKind: 'hang-no-timeout', reason: 'the call has no timeout of its own' }),
              siteResult({ site: site({ key: 'src/a.ts:9:3', line: 9 }) }),
            ],
          }),
        ),
    });
    const result = await runBruise(run.options());
    expect(result.findings.map((finding) => [finding.source, finding.kind, finding.line, finding.severity.score])).toEqual([
      ['fault', 'hang-no-timeout', 5, 70],
      ['mutation', 'survived', 2, 55],
    ]);
    expect(result.findings[1]?.message).toBe('EqualityOperator mutant survived every test that covers it: total > 100');
    expect(result.checked).toEqual({ mutants: 2, invalidMutants: 0, callSites: 2 });
    expect(result.status).toBe('completed');
    expect(exits(result)).toEqual([1, 1]);
  });

  it('exits 0 when everything in scope was checked and nothing was found', async () => {
    const repo = changedRepo();
    const run = harness(repo, {
      runMutation: () => Promise.resolve(mutationResult({ mutants: [killed] })),
      runFaults: () => Promise.resolve(faultRun({ results: [siteResult()] })),
    });
    const result = await runBruise(run.options());
    expect(result).toMatchObject({ status: 'completed', statusReason: null, findings: [], skipped: [], inconclusive: [] });
    expect(result.checked).toEqual({ mutants: 1, invalidMutants: 0, callSites: 1 });
    expect(exits(result)).toEqual([0, 0]);
  });

  it('says why each invalid mutant could not run: compile error or runtime crash, with the first error line', async () => {
    const repo = changedRepo();
    const run = harness(repo, {
      runMutation: () =>
        Promise.resolve(
          mutationResult({
            mutants: [
              killed,
              mutant({
                status: 'CompileError',
                statusReason:
                  "\nsrc/a.ts(2,7): error TS2345: Argument of type 'unknown' is not assignable to parameter of type 'string'.\nsrc/a.ts(4,1): error TS18047: 'm' is possibly 'null'.",
              }),
              mutant({ status: 'RuntimeError', statusReason: 'TypeError: total is not a function\n    at src/a.ts:2:7', start: { line: 3, column: 1 } }),
              mutant({ status: 'CompileError', statusReason: null, start: { line: 4, column: 1 } }),
            ],
          }),
        ),
      runFaults: () => Promise.resolve(faultRun({ results: [siteResult()] })),
    });
    const result = await runBruise(run.options());
    expect(result.invalid).toEqual([
      {
        source: 'mutation',
        file: 'src/a.ts',
        line: 2,
        reason: "compile error: src/a.ts(2,7): error TS2345: Argument of type 'unknown' is not assignable to parameter of type 'string'.",
      },
      { source: 'mutation', file: 'src/a.ts', line: 3, reason: 'runtime error: TypeError: total is not a function' },
      { source: 'mutation', file: 'src/a.ts', line: 4, reason: 'compile error: Stryker reported no reason' },
    ]);
    expect(result.checked).toEqual({ mutants: 1, invalidMutants: 3, callSites: 1 });
  });

  it('lists inconclusive and over-cap sites, reports the run as partial, and exits by findings', async () => {
    const repo = changedRepo();
    const run = harness(repo, {
      runFaults: () =>
        Promise.resolve(
          faultRun({
            results: [
              siteResult({ verdict: 'inconclusive', reason: 'the test did not reach the call site under the fault' }),
              siteResult({
                site: site({ key: 'src/a.ts:12:1', line: 12 }),
                verdict: 'hang',
                findingKind: 'hang-no-timeout',
                reason: 'no timeout',
              }),
            ],
            skipped: [{ site: site({ key: 'src/a.ts:8:1', line: 8 }), kind: null, reason: 'over-cap' }],
          }),
        ),
    });
    const result = await runBruise(run.options());
    expect(result.inconclusive).toEqual([
      { source: 'fault', file: 'src/a.ts', line: 5, reason: 'the test did not reach the call site under the fault', faultKind: 'blackhole' },
    ]);
    expect(result.skipped).toEqual([
      { source: 'fault', file: 'src/a.ts', line: 8, reason: 'not faulted: over the preset cap of 3 call sites' },
    ]);
    expect(result.status).toBe('partial');
    expect(exits(result)).toEqual([1, 2]);
  });

  it('keeps a test file that replaces HTTP entry points as a coverage gap that exits by findings', async () => {
    const repo = changedRepo();
    const conflict = { testFile: 'test/a.test.ts', patched: ['fetch'] };
    const run = harness(repo, { runFaults: () => Promise.resolve(faultRun({ results: [siteResult()], conflicts: [conflict] })) });
    const result = await runBruise(run.options());
    expect(result).toMatchObject({ status: 'partial', conflicts: [conflict] });
    expect(exits(result)).toEqual([0, 2]);
  });

  it('reports only the survivors a changed test covers in test-only mode, and the files over the cap', async () => {
    const repo = changedRepo({ testOnly: true });
    const covered = mutant({ scopeKind: 'test-boundary', coveredBy: ['test/a.test.ts#a'] });
    const elsewhere = mutant({ scopeKind: 'test-boundary', coveredBy: ['test/other.test.ts#x'], start: { line: 3, column: 1 } });
    const run = harness(repo, {
      computeBoundary: () => ({ files: [{ file: 'src/a.ts', distance: 1 }], truncated: 2, mocked: [], sourceRoot: 'src' }),
      runMutation: () =>
        Promise.resolve(
          mutationResult({
            mutants: [covered, elsewhere],
            tests: [
              { id: 'test/a.test.ts#a', name: 'a', file: 'test/a.test.ts' },
              { id: 'test/other.test.ts#x', name: 'x', file: 'test/other.test.ts' },
            ],
          }),
        ),
    });
    const result = await runBruise(run.options());
    expect(result.findings.map((finding) => finding.line)).toEqual([2]);
    expect(result.skipped).toEqual([
      {
        source: 'mutation',
        file: 'src',
        line: null,
        reason: '2 more source files reachable from the changed tests are over the preset cap of 10',
      },
    ]);
    expect(result.status).toBe('partial');
    expect(exits(result)).toEqual([1, 2]);
  });

  it('hands the target output sink to both phases', async () => {
    const repo = changedRepo();
    const run = harness(repo);
    const onTargetOutput = (): void => undefined;
    await runBruise({ ...run.options(), onTargetOutput });
    expect(run.mutationRequests.map((request) => request.onTargetOutput)).toEqual([onTargetOutput]);
    expect(run.faultRequests.map((request) => request.onTargetOutput)).toEqual([onTargetOutput]);
    await runBruise(run.options());
    expect(run.mutationRequests[1]?.onTargetOutput).toBeUndefined();
    expect(run.faultRequests[1]?.onTargetOutput).toBeUndefined();
  });

  it('returns the seed it was given, and picks one when it was not', async () => {
    const repo = changedRepo();
    const run = harness(repo);
    expect((await runBruise(run.options({ seed: 1234 }))).seed).toBe(1234);
    const { seed, ...withoutSeed } = run.options();
    expect(seed).toBe(7);
    const picked = (await runBruise(withoutSeed)).seed;
    expect(Number.isInteger(picked)).toBe(true);
    expect(picked).toBeGreaterThanOrEqual(0);
  });

  it('passes the seed to both phases, the picked one too', async () => {
    const repo = changedRepo();
    const run = harness(repo);
    await runBruise(run.options({ seed: 99 }));
    expect(run.mutationRequests.map((request) => request.seed)).toEqual([99]);
    expect(run.faultRequests.map((request) => request.seed)).toEqual([99]);
    const { seed, ...withoutSeed } = run.options();
    expect(seed).toBe(7);
    const picked = (await runBruise(withoutSeed)).seed;
    expect(run.mutationRequests[1]?.seed).toBe(picked);
    expect(run.faultRequests[1]?.seed).toBe(picked);
  });

  it('passes the seed to the test-only boundary', async () => {
    const repo = changedRepo({ testOnly: true });
    const seeds: (number | undefined)[] = [];
    const run = harness(repo, {
      computeBoundary: (options) => {
        seeds.push(options.seed);
        return { files: [], truncated: 0, mocked: [], sourceRoot: 'src' };
      },
    });
    await runBruise(run.options({ seed: 5 }));
    expect(seeds).toEqual([5]);
  });

  it.each([-1, 1.5, 2 ** 31])('reports the seed %s as a tool error without scoping', async (seed) => {
    const repo = changedRepo();
    const run = harness(repo);
    const result = await runBruise(run.options({ seed }));
    expect(result.status).toBe('error');
    expect(result.error).toBe(`seed must be an integer from 0 to 2147483647, not ${seed}`);
    expect(result.scope).toBeNull();
    expect(run.mutationRequests).toEqual([]);
    expect(exitCodeOf(result)).toBe(2);
  });
});

const compileError = (line: number) =>
  mutant({ status: 'CompileError', statusReason: "src/a.ts(2,7): error TS2339: Property 'x' does not exist.", start: { line, column: 1 } });

const FETCH_SOURCE = [
  'export function total(a: number, b: number): number {',
  '  return a + b;',
  '}',
  '',
  'export async function load(): Promise<Response> {',
  "  return fetch('http://127.0.0.1:9/load');",
  '}',
  '',
].join('\n');

describe('fault kinds', () => {
  it('reports one result per site and kind, with the kind on findings and gaps, and counts each site once', async () => {
    const repo = changedRepo();
    const run = harness(repo, {
      runFaults: () =>
        Promise.resolve(
          faultRun({
            status: 'budget-exhausted',
            statusReason: 'the budget ran out before every call site was faulted',
            results: [
              siteResult({ verdict: 'handled-timeout' }),
              siteResult({
                kind: 'connection-refused',
                verdict: 'refusal-mishandled',
                findingKind: 'refusal-mishandled',
                reason: 'the test failed after the connection was refused',
              }),
              siteResult({ kind: 'connection-refused', site: site({ key: 'src/a.ts:9:1', line: 9 }), verdict: 'inconclusive', reason: 'the test did not reach the call site under the fault' }),
            ],
            skipped: [{ site: site({ key: 'src/a.ts:9:1', line: 9 }), kind: 'blackhole', reason: 'budget' }],
          }),
        ),
    });
    const result = await runBruise(run.options({ level: 'shake' }));
    expect(result.findings).toMatchObject([
      { source: 'fault', kind: 'refusal-mishandled', line: 5, fault: { kind: 'connection-refused', verdict: 'refusal-mishandled' } },
    ]);
    expect(result.inconclusive).toEqual([
      { source: 'fault', file: 'src/a.ts', line: 9, reason: 'the test did not reach the call site under the fault', faultKind: 'connection-refused' },
    ]);
    expect(result.skipped).toEqual([
      { source: 'fault', file: 'src/a.ts', line: 9, reason: 'not faulted: the budget ran out first', faultKind: 'blackhole' },
    ]);
    expect(result.checked.callSites).toBe(1);
  });

  it.each([
    ['connection-refused', 'refusal-mishandled', 'refusal-mishandled'],
    ['http-500', 'status-ignored', 'error-status-ignored'],
    ['http-500', 'status-mishandled', 'error-status-mishandled'],
    ['malformed-json', 'parse-mishandled', 'malformed-json-mishandled'],
  ] as const)('sets aside a %s finding (%s) under an ignore comment or a baseline entry like any other', async (kind, verdict, findingKind) => {
    const comment = '  // bruise-ignore: the caller retries the whole job\n';
    const source = `export async function load(url: string): Promise<void> {\n${comment}  await fetch(url);\n}\n`;
    const repo = changedRepo({ changedSource: source });
    const refused = siteResult({
      kind,
      site: site({ key: 'src/a.ts:3:9', line: 3, column: 9 }),
      verdict,
      findingKind,
      reason: 'the fault was not handled',
    });
    const run = harness(repo, { runFaults: () => Promise.resolve(faultRun({ results: [refused] })) });
    const result = await runBruise(run.options({ level: 'shake' }));
    expect(result.findings).toEqual([]);
    expect(result.ignored).toMatchObject([{ by: 'inline', finding: { kind: findingKind, fault: { kind } } }]);

    repo.write('src/a.ts', source.replace(comment, ''));
    repo.commit('Drop the comment');
    repo.write(BASELINE_FILE, serializeBaseline([{ source: 'fault', file: 'src/a.ts', function: 'load', kind: findingKind, reason: null }]));
    const moved = siteResult({ ...refused, site: site({ key: 'src/a.ts:2:9', line: 2, column: 9 }) });
    const again = harness(repo, { runFaults: () => Promise.resolve(faultRun({ results: [moved] })) });
    const baselined = await runBruise(again.options({ level: 'shake' }));
    expect(baselined.findings).toEqual([]);
    expect(baselined.ignored).toMatchObject([{ by: 'baseline', finding: { kind: findingKind } }]);
  });
});

describe('verdict honesty', () => {
  it('is inconclusive, exit 2, when every mutant in scope was invalid and nothing else was checked', async () => {
    const repo = changedRepo();
    const run = harness(repo, {
      runMutation: () => Promise.resolve(mutationResult({ mutants: [compileError(2), compileError(3)] })),
    });
    const result = await runBruise(run.options());
    expect(result.checked).toEqual({ mutants: 0, invalidMutants: 2, callSites: 0 });
    expect(result).toMatchObject({ status: 'inconclusive', statusReason: 'no mutant in scope could run' });
    expect(exits(result)).toEqual([2, 2]);
  });

  it('excludes invalid mutants from coverage once a valid mutant ran: completed, exit 0 even with --strict', async () => {
    const repo = changedRepo();
    const run = harness(repo, {
      runMutation: () => Promise.resolve(mutationResult({ mutants: [killed, compileError(2), compileError(3), compileError(4)] })),
    });
    const result = await runBruise(run.options());
    expect(result).toMatchObject({ status: 'completed', statusReason: null, invalidExcluded: true });
    expect(result.checked).toEqual({ mutants: 1, invalidMutants: 3, callSites: 0 });
    expect(result.invalid.map((item) => [item.line, item.reason])).toEqual([
      [2, "compile error: src/a.ts(2,7): error TS2339: Property 'x' does not exist."],
      [3, "compile error: src/a.ts(2,7): error TS2339: Property 'x' does not exist."],
      [4, "compile error: src/a.ts(2,7): error TS2339: Property 'x' does not exist."],
    ]);
    expect(exits(result)).toEqual([0, 0]);
    const text = renderText(result);
    expect(text).toContain('Invalid mutants (3):');
    expect(text).toContain('Result: clean, coverage complete, 3 invalid mutants excluded (exit 0)');
  });

  it('keeps invalid mutants a gap when no valid mutant ran but a call site was checked', async () => {
    const repo = changedRepo();
    const run = harness(repo, {
      runMutation: () => Promise.resolve(mutationResult({ mutants: [compileError(2)] })),
      runFaults: () => Promise.resolve(faultRun({ results: [siteResult()] })),
    });
    const result = await runBruise(run.options());
    expect(result).toMatchObject({ status: 'partial', invalidExcluded: false });
    expect(exits(result)).toEqual([0, 2]);
    expect(renderText(result)).toContain('coverage partial: 1 invalid, listed above');
  });

  it('does not exclude anything when every mutant in scope was invalid', async () => {
    const repo = changedRepo();
    const run = harness(repo, { runMutation: () => Promise.resolve(mutationResult({ mutants: [compileError(2)] })) });
    const result = await runBruise(run.options());
    expect(result).toMatchObject({ status: 'inconclusive', invalidExcluded: false });
  });

  it('is nothing-checkable, exit 0 and 2 with --strict, when the change has no mutants and no outgoing calls', async () => {
    const repo = changedRepo();
    const run = harness(repo, { runMutation: () => Promise.resolve(mutationResult({ mutants: [] })) });
    const result = await runBruise(run.options());
    expect(result).toMatchObject({
      status: 'nothing-checkable',
      statusReason: 'the changed code produces no mutants at this level and makes no outgoing calls',
    });
    expect(exits(result)).toEqual([0, 2]);
  });

  it('lists a changed outgoing call that no test reaches as not checked, and the run as partial', async () => {
    const repo = changedRepo({ changedSource: FETCH_SOURCE });
    const run = harness(repo, { runMutation: () => Promise.resolve(mutationResult({ mutants: [killed] })) });
    const result = await runBruise(run.options());
    expect(result.skipped).toEqual([
      { source: 'fault', file: 'src/a.ts', line: 6, reason: 'changed call to fetch at src/a.ts:6 is not reached by any test' },
    ]);
    expect(result.status).toBe('partial');
    expect(exits(result)).toEqual([0, 2]);
  });

  it('does not list a changed outgoing call that discovery saw', async () => {
    const repo = changedRepo({ changedSource: FETCH_SOURCE });
    const reached = site({ key: 'src/a.ts:6:10', line: 6, column: 10 });
    const run = harness(repo, {
      runMutation: () => Promise.resolve(mutationResult({ mutants: [killed] })),
      runFaults: () => Promise.resolve(faultRun({ results: [siteResult({ site: reached })] })),
    });
    const result = await runBruise(run.options());
    expect(result).toMatchObject({ status: 'completed', skipped: [] });
  });

  it('says so when the changed code reaches no outgoing call, instead of showing 0 call sites silently', async () => {
    const repo = changedRepo();
    const run = harness(repo, { runMutation: () => Promise.resolve(mutationResult({ mutants: [killed] })) });
    const result = await runBruise(run.options());
    expect(result.status).toBe('completed');
    expect(phase(result, 'faults')).toMatchObject({
      status: 'completed',
      statusReason: 'the changed code reached no outgoing call in the tests related to it, directly or through other code',
    });
    expect(renderText(result)).toContain(
      [
        'Coverage: 1 mutant and 0 call sites checked',
        '  nothing in scope was left unchecked',
        '  no call site to fault: the changed code reached no outgoing call in the tests related to it, directly or through other code',
      ].join('\n'),
    );
  });

  it('keeps the fault phase reason empty when it faulted a site', async () => {
    const repo = changedRepo();
    const run = harness(repo, {
      runMutation: () => Promise.resolve(mutationResult({ mutants: [killed] })),
      runFaults: () => Promise.resolve(faultRun({ results: [siteResult()] })),
    });
    const result = await runBruise(run.options());
    expect(phase(result, 'faults')).toMatchObject({ status: 'completed', statusReason: null });
  });

  it('counts a changed call as reached when discovery saw it as a caller frame of a wrapper site', async () => {
    const repo = changedRepo({ changedSource: FETCH_SOURCE });
    const wrapper = site({
      key: 'src/client.ts:3:10',
      file: 'src/client.ts',
      line: 3,
      frames: [
        { file: 'src/client.ts', line: 3, column: 10, functionName: 'request' },
        { file: 'src/a.ts', line: 6, column: 10, functionName: 'load' },
      ],
      reachedFrom: ['src/a.ts load'],
    });
    const run = harness(repo, {
      runMutation: () => Promise.resolve(mutationResult({ mutants: [killed] })),
      runFaults: () => Promise.resolve(faultRun({ results: [siteResult({ site: wrapper })] })),
    });
    const result = await runBruise(run.options());
    expect(result).toMatchObject({ status: 'completed', skipped: [] });
  });

  it('names the changed callers of a wrapper site on its finding and on its gaps', async () => {
    const repo = changedRepo();
    const loads = { id: 't1', file: 'test/a.test.ts', name: 'loads' };
    const reachedBy = [
      { test: loads, durationMs: 5, calls: 1, reachedFrom: ['src/a.ts total'] },
      { test: { id: 't2', file: 'test/b.test.ts', name: 'saves' }, durationMs: 9, calls: 1, reachedFrom: ['src/b.ts save'] },
    ];
    const wrapper = site({ key: 'src/client.ts:3:10', file: 'src/client.ts', line: 3, functionName: 'request', reachedFrom: ['src/a.ts total', 'src/b.ts save'], reachedBy });
    const run = harness(repo, {
      runMutation: () => Promise.resolve(mutationResult({ mutants: [killed] })),
      runFaults: () =>
        Promise.resolve(
          faultRun({
            status: 'budget-exhausted',
            statusReason: 'the budget ran out before every call site was faulted',
            results: [
              siteResult({
                site: wrapper,
                verdict: 'hang',
                findingKind: 'hang-no-timeout',
                reason: 'the call has no timeout of its own',
                tests: [{ test: loads, observations: [], injected: null, problem: null }],
              }),
            ],
            skipped: [{ site: wrapper, kind: 'http-500', reason: 'budget' }],
          }),
        ),
    });
    const result = await runBruise(run.options());
    expect(result.findings[0]?.fault).toMatchObject({ reachedFrom: ['src/a.ts total'], notFaultedFrom: ['src/b.ts save'] });
    expect(result.skipped).toContainEqual({
      source: 'fault',
      file: 'src/client.ts',
      line: 3,
      reason: 'not faulted: the budget ran out first; reached from changed code: src/a.ts total, src/b.ts save',
      faultKind: 'http-500',
    });
    const text = renderText(result);
    expect(text).toContain('    reached from changed code: src/a.ts total\n    also reached from src/b.ts save, not faulted at this level');
  });

  it('is inconclusive when the only things in scope are invalid mutants and an unreached call', async () => {
    const repo = changedRepo({ changedSource: FETCH_SOURCE });
    const run = harness(repo, { runMutation: () => Promise.resolve(mutationResult({ mutants: [compileError(6)] })) });
    const result = await runBruise(run.options());
    expect(result.status).toBe('inconclusive');
    expect(exits(result)).toEqual([2, 2]);
  });

  it('marks the mutation phase inconclusive when the target suite fails before any mutant runs', async () => {
    const repo = changedRepo();
    const run = harness(repo, {
      runMutation: () =>
        Promise.resolve(
          mutationResult({
            batches: [
              batch({
                outcome: 'dry-run-failed',
                planned: null,
                tested: 0,
                error: 'ConfigError: There were failed tests in the initial test run.\n    at DryRunExecutor.validateResultCompleted',
              }),
            ],
            notTested: { reason: 'budget', mutants: 0, unplannedFiles: ['src/a.ts'] },
          }),
        ),
    });
    const result = await runBruise(run.options());
    expect(phase(result, 'mutation')).toMatchObject({
      status: 'inconclusive',
      statusReason: "the target's own tests fail before any mutant runs: There were failed tests in the initial test run.",
    });
    expect(result.skipped).toContainEqual({
      source: 'mutation',
      file: 'src/a.ts',
      line: null,
      reason: "not mutated: the target's own tests fail before any mutant runs",
    });
    expect(result.status).toBe('inconclusive');
    expect(exits(result)).toEqual([2, 2]);
  });

  it('never renders clean or "everything in scope was checked" for a run where nothing could run', async () => {
    const repo = changedRepo();
    const run = harness(repo, { runMutation: () => Promise.resolve(mutationResult({ mutants: [compileError(2)] })) });
    const text = renderText(await runBruise(run.options()));
    expect(text).not.toContain('clean');
    expect(text).not.toContain('everything in scope was checked');
    expect(text).not.toContain('nothing in scope was left unchecked');
    expect(text).toContain('Result: inconclusive, no mutant in scope could run; 0 findings (exit 2)');
  });
});

const BOOM = [
  'Error: Error: boom from config',
  'Error: boom from config',
  '    at file:///C:/target/node_modules/.vite-temp/vitest.config.ts.timestamp.mjs:4:7',
  '    at ModuleJob.run (node:internal/modules/esm/module_job:437:25)',
].join('\n');

describe('error reporting', () => {
  it('gives the files of a failed batch the reason of that batch, not the budget', async () => {
    const repo = changedRepo();
    const run = harness(repo, {
      runMutation: () =>
        Promise.resolve(
          mutationResult({
            batches: [batch({ outcome: 'failed', planned: null, tested: 0, error: BOOM })],
            notTested: { reason: 'budget', mutants: 0, unplannedFiles: ['src/a.ts'] },
          }),
        ),
    });
    const result = await runBruise(run.options());
    expect(result.skipped).toContainEqual({
      source: 'mutation',
      file: 'src/a.ts',
      line: null,
      reason: 'mutants never planned: batch failed: boom from config',
    });
    expect(result.skipped.map((item) => item.reason)).not.toContain('mutants never planned: the budget ran out first');
  });

  it('keeps a failed phase reason to its first line and the full error as detail', async () => {
    const repo = changedRepo();
    const thrown = Object.assign(new Error('Error: boom from config'), { stack: BOOM });
    const run = harness(repo, {
      runMutation: () =>
        Promise.resolve(mutationResult({ batches: [batch({ outcome: 'failed', planned: null, tested: 0, error: BOOM })] })),
      runFaults: () => Promise.reject(thrown),
    });
    const result = await runBruise(run.options());
    expect(phase(result, 'mutation')).toMatchObject({ statusReason: 'mutation batch 0 failed: boom from config', detail: BOOM });
    expect(phase(result, 'faults')).toMatchObject({ statusReason: 'boom from config', detail: BOOM });
    expect(result.skipped).toContainEqual({
      source: 'fault',
      file: 'src/a.ts',
      line: null,
      reason: 'not faulted: the fault phase failed: boom from config',
    });
  });

  it('reports where each phase spent its time and records it for the plan', async () => {
    const repo = changedRepo();
    const mutationTimings = { batchesStarted: 1, strykerStartMs: 54_800, dryRunNetMs: 8_500, mutantsMs: 29_000, mutantsRun: 8 };
    const faultTimings = { discoveryMs: 11_400, faultRuns: 2, faultRunsMs: 6_000 };
    const run = harness(repo, {
      runMutation: () => Promise.resolve(mutationResult({ mutants: [killed], timings: mutationTimings })),
      runFaults: () => Promise.resolve(faultRun({ results: [siteResult()], timings: faultTimings })),
    });
    const result = await runBruise(run.options());
    expect(phase(result, 'mutation')?.timings).toEqual(mutationTimings);
    expect(phase(result, 'faults')?.timings).toEqual(faultTimings);
    expect(renderText(result)).toContain(
      [
        '    Stryker start and dry run 54.8 s (the tests 8.5 s of it), 8 mutants run in 29.0 s, 3.6 s each',
        '  faults completed 0.0 s of 120.0 s',
        '    discovery run 11.4 s, 2 faulted runs in 6.0 s, 3.0 s each',
      ].join('\n'),
    );
    const recorded = readTimings(repo.dir);
    expect(recorded).toEqual([{ at: expect.any(String) as string, level: 'poke', mutation: mutationTimings, faults: faultTimings }]);
    expect(repo.git('status', '--porcelain')).toBe('');
  });

  it('reports each phase start and end to the progress listener and hands it to both phases', async () => {
    const repo = changedRepo();
    const events: ProgressEvent[] = [];
    const run = harness(repo, { runMutation: () => Promise.resolve(mutationResult({ mutants: [killed] })) });
    const result = await runBruise(run.options({ onProgress: (event) => events.push(event) }));
    expect(events.map((event) => [event.type, 'phase' in event ? event.phase : null])).toEqual([
      ['phase-start', 'mutation'],
      ['phase-end', 'mutation'],
      ['phase-start', 'faults'],
      ['phase-end', 'faults'],
    ]);
    expect(events[0]).toMatchObject({ budgetMs: phase(result, 'mutation')?.budgetMs });
    expect(events[1]).toMatchObject({ status: 'completed' });
    expect(run.mutationRequests[0]?.onProgress).toBeDefined();
    expect(run.faultRequests[0]?.onProgress).toBeDefined();
  });

  it('records no timings when no phase ran', async () => {
    const repo = track(createTempRepo());
    repo.write('README.md', 'docs\n');
    repo.branch('origin/main', repo.commit('Base'));
    repo.write('README.md', 'more docs\n');
    repo.commit('Docs');
    const result = await runBruise(harness(repo).options());
    expect(result.status).toBe('nothing-in-scope');
    expect(readTimings(repo.dir)).toEqual([]);
  });

  it('rounds every phase duration to whole milliseconds', async () => {
    const repo = changedRepo();
    const run = harness(repo, {
      runMutation: () => {
        run.advance(1234.56);
        return Promise.resolve(mutationResult({ mutants: [killed] }));
      },
      runFaults: () => {
        run.advance(10.4);
        return Promise.resolve(faultRun({ results: [siteResult()] }));
      },
    });
    const result = await runBruise(run.options());
    for (const entry of result.phases) {
      expect(Number.isInteger(entry.budgetMs)).toBe(true);
      expect(Number.isInteger(entry.spentMs)).toBe(true);
    }
    expect(Number.isInteger(result.spentMs)).toBe(true);
  });
});

describe('baseline and inline ignores', () => {
  const survivor = (line: number) =>
    mutant({ file: 'src/a.ts', start: { line, column: 10 }, end: { line, column: 15 }, mutatorName: 'ArithmeticOperator', replacement: 'a + b' });

  function baselineFor(repo: TempRepo, line: number, reason: string | null): string {
    const statement = new SourceStatements('src/a.ts', repo.read('src/a.ts')).enclosing(line, 10)[0]?.hash ?? '';
    return serializeBaseline([{ source: 'mutation', file: 'src/a.ts', mutator: 'ArithmeticOperator', replacement: 'a + b', statement, reason }]);
  }

  it('sets aside a finding the baseline accepts, lists it as ignored and exits by the rest', async () => {
    const repo = changedRepo();
    repo.write(BASELINE_FILE, baselineFor(repo, 2, 'equivalent here'));
    const run = harness(repo, { runMutation: () => Promise.resolve(mutationResult({ mutants: [survivor(2)] })) });
    const result = await runBruise(run.options());
    expect(result.findings).toEqual([]);
    expect(result.ignored).toMatchObject([{ by: 'baseline', reason: 'equivalent here', finding: { kind: 'survived', line: 2 } }]);
    expect(result.baseline).toMatchObject({ present: true, entries: 1, stale: [], notEvaluated: [] });
    expect(result.status).toBe('completed');
    expect(exitCodeOf(result)).toBe(0);
    expect(renderText(result)).toContain('1 finding ignored (baseline: 1, inline: 0)');
  });

  it('reports an ignore comment without a reason as a finding and does not honour it', async () => {
    const repo = changedRepo({ changedSource: SOURCE.replace('  return a + b;', '  // bruise-ignore\n  return a - b;') });
    const run = harness(repo, { runMutation: () => Promise.resolve(mutationResult({ mutants: [survivor(3)] })) });
    const result = await runBruise(run.options());
    expect(result.findings.map(({ kind, line }) => [kind, line])).toEqual([
      ['survived', 3],
      ['invalid-ignore', 2],
    ]);
    expect(result.ignored).toEqual([]);
    expect(exitCodeOf(result)).toBe(1);
  });

  it('honours an ignore comment with a reason', async () => {
    const repo = changedRepo({ changedSource: SOURCE.replace('  return a + b;', '  // bruise-ignore: subtraction is intended\n  return a - b;') });
    const run = harness(repo, { runMutation: () => Promise.resolve(mutationResult({ mutants: [survivor(3)] })) });
    const result = await runBruise(run.options());
    expect(result.findings).toEqual([]);
    expect(result.ignored).toMatchObject([{ by: 'inline', reason: 'subtraction is intended' }]);
    expect(exitCodeOf(result)).toBe(0);
  });

  it('reports a stale entry without failing the run', async () => {
    const repo = changedRepo();
    repo.write(BASELINE_FILE, baselineFor(repo, 2, null));
    const killed = { ...survivor(2), status: 'Killed' as const };
    const run = harness(repo, { runMutation: () => Promise.resolve(mutationResult({ mutants: [killed] })) });
    const result = await runBruise(run.options());
    expect(result.baseline?.stale).toHaveLength(1);
    expect(result.status).toBe('completed');
    expect(exitCodeOf(result)).toBe(0);
  });

  it.each([
    ['a corrupt file', '{ "version": 1, ', 'bruise-baseline.json is not valid JSON'],
    ['an unknown version', '{ "version": 3, "entries": [] }\n', 'bruise-baseline.json has version 3; this version of bruise reads baseline version 1'],
  ])('stops with a tool error on %s, before any phase runs', async (_label, content, message) => {
    const repo = changedRepo();
    repo.write(BASELINE_FILE, content);
    const run = harness(repo);
    const result = await runBruise(run.options());
    expect(result.status).toBe('error');
    expect(result.error).toContain(message);
    expect(run.mutationRequests).toEqual([]);
    expect(run.faultRequests).toEqual([]);
    expect(exitCodeOf(result)).toBe(2);
  });

  it('has no baseline report without a baseline file and nothing ignored', async () => {
    const repo = changedRepo();
    const result = await runBruise(harness(repo).options());
    expect(result.baseline).toMatchObject({ present: false, entries: 0 });
    expect(result.ignored).toEqual([]);
  });
});
