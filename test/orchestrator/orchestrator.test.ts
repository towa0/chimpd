import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PRESETS } from '../../src/core/index.js';
import type { FaultRunRequest } from '../../src/fault-run/index.js';
import {
  exitCodeOf,
  runChimpd,
  type OrchestratorDeps,
  type RunOptions,
  type RunResult,
} from '../../src/orchestrator/index.js';
import type { MutationRequest } from '../../src/stryker-adapter/index.js';
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
function changedRepo(options: { config?: boolean; testOnly?: boolean } = {}): TempRepo {
  const repo = track(createTempRepo());
  repo.write('package.json', '{ "type": "module" }\n');
  repo.write('src/a.ts', SOURCE);
  repo.write('test/a.test.ts', "import { it } from 'vitest';\nit('a', () => {});\n");
  if (options.config !== false) repo.write('vitest.config.ts', 'export default {};\n');
  const base = repo.commit('Base');
  repo.branch('origin/main', base);
  if (options.testOnly === true) repo.write('test/a.test.ts', "import { it } from 'vitest';\nit('a', () => {});\nit('b', () => {});\n");
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
    const dir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'chimpd-nogit-'));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const result = await runChimpd({ cwd: dir, level: 'poke', seed: 1 });
    expect(result).toMatchObject({ status: 'error', git: null, scope: null, phases: [], findings: [], seed: 1 });
    expect(result.error).toContain('is not inside a git repository');
    expect(exitCodeOf(result)).toBe(2);
  });

  it('reports a directory that does not exist as a tool error', async () => {
    const result = await runChimpd({ cwd: path.join(os.tmpdir(), 'chimpd-missing-dir-x'), level: 'poke' });
    expect(result.status).toBe('error');
    expect(result.error).toContain('is not a directory');
  });

  it('reports a missing base ref as a tool error', async () => {
    const repo = changedRepo();
    const result = await runChimpd({ cwd: repo.dir, level: 'poke', base: 'origin/nope' });
    expect(result.status).toBe('error');
    expect(result.error).toBe(`base ref 'origin/nope' does not resolve to a commit in ${repo.dir}; fetch it or pass --base <ref>`);
    expect(exitCodeOf(result)).toBe(2);
  });

  it('reports a target without a Vitest config as a tool error, after scoping', async () => {
    const repo = changedRepo({ config: false });
    const run = harness(repo);
    const result = await runChimpd(run.options());
    expect(result.status).toBe('error');
    expect(result.error).toContain('no Vitest config found in');
    expect(result.scope?.changedSourceFiles).toEqual(['src/a.ts']);
    expect(run.mutationRequests).toEqual([]);
    expect(exitCodeOf(result)).toBe(2);
  });

  it('reports a target whose Vitest cannot be loaded as a tool error before any phase runs', async () => {
    const repo = changedRepo();
    const run = harness(repo, { loadVitest: () => Promise.reject(new Error(`Vitest is not installed in ${repo.dir}`)) });
    const result = await runChimpd(run.options());
    expect(result).toMatchObject({ status: 'error', error: `Vitest is not installed in ${repo.dir}`, phases: [] });
    expect(run.mutationRequests).toEqual([]);
  });

  it('reports nothing in scope, without needing a Vitest config, when the branch changes no TypeScript', async () => {
    const repo = track(createTempRepo());
    repo.write('README.md', 'one\n');
    repo.branch('origin/main', repo.commit('Base'));
    repo.write('README.md', 'two\n');
    repo.commit('Docs');
    const result = await runChimpd({ cwd: repo.dir, level: 'poke' });
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
    const result = await runChimpd(run.options());
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
      await runChimpd(run.options({ level }));
      const preset = PRESETS[intensity];
      expect(run.mutationRequests[0]?.budgetMs).toBe(Math.floor(preset.budgetMs * preset.mutationShare));
      expect(run.mutationRequests[0]?.intensity).toBe(intensity);
    }
  });

  it('gives the whole budget to mutation when only test files changed', async () => {
    const repo = changedRepo({ testOnly: true });
    const run = harness(repo, {
      computeBoundary: () => ({ files: [{ file: 'src/a.ts', distance: 1 }], truncated: 0, mocked: [], sourceRoot: 'src' }),
    });
    const result = await runChimpd(run.options());
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
    await runChimpd({
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
    const result = await runChimpd(run.options());
    expect(phase(result, 'mutation')).toMatchObject({
      status: 'budget-exhausted',
      statusReason: 'the budget ran out before every mutant was tested',
    });
    expect(result.skipped).toEqual([
      { source: 'mutation', file: 'src/a.ts', line: 2, reason: 'not tested: budget' },
      { source: 'mutation', file: 'src/b.ts', line: null, reason: 'mutants never planned: the budget ran out first' },
    ]);
    expect(result.checked).toEqual({ mutants: 1, invalidMutants: 0, callSites: 0 });
    expect(result.status).toBe('partial');
    expect(exits(result)).toEqual([0, 2]);
  });

  it('reports a batch stopped at twice its share as budget-exhausted and the run as partial', async () => {
    const repo = changedRepo();
    const run = harness(repo, {
      runMutation: () => Promise.resolve(mutationResult({ mutants: [killed], batches: [batch({ outcome: 'killed-over-share' })] })),
    });
    const result = await runChimpd(run.options());
    expect(phase(result, 'mutation')?.status).toBe('budget-exhausted');
    expect(result.status).toBe('partial');
    expect(exits(result)).toEqual([0, 2]);
  });

  it('lists every file the fault phase never got to when mutation spent the whole budget', async () => {
    const repo = changedRepo();
    const run = harness(repo, {
      runMutation: () => {
        run.advance(PRESETS[1].budgetMs + 500);
        return Promise.resolve(mutationResult({ mutants: [killed, mutant()] }));
      },
    });
    const result = await runChimpd(run.options());
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
            skipped: [{ site: site(), reason: 'budget' }],
          }),
        ),
    });
    const result = await runChimpd(run.options());
    expect(phase(result, 'faults')).toMatchObject({
      status: 'budget-exhausted',
      statusReason: 'the budget ran out before every call site was faulted',
    });
    expect(result.skipped).toEqual([
      { source: 'fault', file: 'src/a.ts', line: 5, reason: 'not faulted: the budget ran out first' },
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
    const result = await runChimpd(run.options());
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
    const result = await runChimpd(run.options());
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
    const result = await runChimpd(run.options());
    expect(phase(result, 'mutation')).toMatchObject({ status: 'error', statusReason: 'mutation batch 0 failed: dry run failed' });
    expect(exits(result)).toEqual([2, 2]);
  });

  it('records a fault phase that throws and lists its files as not checked', async () => {
    const repo = changedRepo();
    const run = harness(repo, {
      runMutation: () => Promise.resolve(mutationResult({ mutants: [killed, mutant()] })),
      runFaults: () => Promise.reject(new Error('vitest would not start')),
    });
    const result = await runChimpd(run.options());
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
    const result = await runChimpd(run.options());
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
    const result = await runChimpd(run.options());
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
    const result = await runChimpd(run.options());
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
      runMutation: () => Promise.resolve(mutationResult({ mutants: [killed, mutant({ status: 'CompileError' })] })),
      runFaults: () => Promise.resolve(faultRun({ results: [siteResult()] })),
    });
    const result = await runChimpd(run.options());
    expect(result).toMatchObject({ status: 'completed', findings: [], skipped: [], inconclusive: [] });
    expect(result.checked).toEqual({ mutants: 1, invalidMutants: 1, callSites: 1 });
    expect(exits(result)).toEqual([0, 0]);
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
            skipped: [{ site: site({ key: 'src/a.ts:8:1', line: 8 }), reason: 'over-cap' }],
          }),
        ),
    });
    const result = await runChimpd(run.options());
    expect(result.inconclusive).toEqual([
      { source: 'fault', file: 'src/a.ts', line: 5, reason: 'the test did not reach the call site under the fault' },
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
    const result = await runChimpd(run.options());
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
    const result = await runChimpd(run.options());
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

  it('returns the seed it was given, and picks one when it was not', async () => {
    const repo = changedRepo();
    const run = harness(repo);
    expect((await runChimpd(run.options({ seed: 1234 }))).seed).toBe(1234);
    const { seed, ...withoutSeed } = run.options();
    expect(seed).toBe(7);
    const picked = (await runChimpd(withoutSeed)).seed;
    expect(Number.isInteger(picked)).toBe(true);
    expect(picked).toBeGreaterThanOrEqual(0);
  });
});
