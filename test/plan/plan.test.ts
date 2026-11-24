import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PRESETS } from '../../src/core/index.js';
import {
  ASSUMED_DISCOVERY_MS,
  ASSUMED_MS_PER_MUTANT,
  ASSUMED_STRYKER_START_MS,
  ASSUMED_TEST_MS,
  countMutants,
  exitCodeOfPlan,
  planRun,
  type PlanDeps,
  type PlanOptions,
  type RunPlan,
} from '../../src/plan/index.js';
import { isRunnableKind } from '../../src/fault-run/index.js';
import { planBatches } from '../../src/stryker-adapter/index.js';
import { createTempRepo, type TempRepo } from '../helpers/temp-repo.js';

const SOURCE = [
  'export function total(a: number, b: number): number {',
  '  return a + b;',
  '}',
  '',
  'export async function load(url: string): Promise<unknown> {',
  '  const response = await fetch(url);',
  '  return response.json();',
  '}',
  '',
].join('\n');

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function changedRepo(options: { config?: boolean; testOnly?: boolean } = {}): TempRepo {
  const repo = createTempRepo();
  cleanups.push(() => repo.cleanup());
  repo.write('package.json', '{ "type": "module" }\n');
  repo.write('src/a.ts', SOURCE);
  repo.write('test/a.test.ts', "import { it } from 'vitest';\nimport { total } from '../src/a.js';\nit('a', () => total(1, 2));\n");
  if (options.config !== false) repo.write('vitest.config.ts', 'export default {};\n');
  const base = repo.commit('Base');
  repo.branch('origin/main', base);
  if (options.testOnly === true) {
    repo.write('test/a.test.ts', "import { it } from 'vitest';\nimport { total } from '../src/a.js';\nit('b', () => total(2, 2));\n");
  } else {
    repo.edit('src/a.ts', 'a + b', 'a > b ? a - b : b');
    repo.edit('src/a.ts', 'await fetch(url)', 'await fetch(url, { headers: {} })');
  }
  repo.write('README.md', '# changed\n');
  repo.commit('Change');
  return repo;
}

function plan(repo: TempRepo, overrides: Partial<PlanOptions> = {}): Promise<RunPlan> {
  return planRun({ cwd: repo.dir, level: 'poke', seed: 7, ...overrides });
}

interface Snapshot {
  readonly [file: string]: string;
}

/** Every file outside .git with its size and modification time, ignored files included. */
function snapshot(dir: string): Snapshot {
  const entries: Record<string, string> = {};
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) walk(full);
      else {
        const stat = fs.lstatSync(full);
        entries[path.relative(dir, full)] = `${stat.size}:${stat.mtimeMs}`;
      }
    }
  };
  walk(dir);
  return entries;
}

describe('planRun', () => {
  it('lists the files in scope and the ignored ones with their reason', async () => {
    const result = await plan(changedRepo());
    expect(result.status).toBe('planned');
    expect(result.error).toBeNull();
    expect(result.scope?.changedSourceFiles).toEqual(['src/a.ts']);
    expect(result.scope?.ignoredFiles).toEqual([{ file: 'README.md', reason: 'not-typescript' }]);
    expect(result.vitestConfig).toBe('vitest.config.ts');
    expect(exitCodeOfPlan(result)).toBe(0);
  });

  it("counts the mutants Stryker's instrumenter generates in scope, without the preset's excluded mutators", async () => {
    const repo = changedRepo();
    const poke = await plan(repo, { level: 'poke' });
    const shake = await plan(repo, { level: 'shake' });
    const pokeFile = poke.mutation?.files.find((entry) => entry.file === 'src/a.ts');
    const shakeFile = shake.mutation?.files.find((entry) => entry.file === 'src/a.ts');
    expect(pokeFile?.reason).toBeNull();
    expect(pokeFile?.mutants).toBeGreaterThan(0);
    expect(shakeFile?.mutants).toBeGreaterThan(pokeFile?.mutants ?? Infinity);
    expect(poke.mutation?.total).toBe(pokeFile?.mutants);
  });

  it('finds the changed outgoing calls in the source', async () => {
    const result = await plan(changedRepo(), { level: 'prod' });
    expect(result.faults?.calls).toEqual([{ file: 'src/a.ts', line: 6, callee: 'fetch', scopeKind: 'changed' }]);
    expect(result.faults).toMatchObject({ maxCallSites: PRESETS[2].maxFaultedCallSites, testsPerCallSite: PRESETS[2].testsPerCallSite, notRun: null });
  });

  it('splits the budget the way a run would', async () => {
    const result = await plan(changedRepo(), { level: 'prod' });
    const totalMs = PRESETS[2].budgetMs;
    expect(result.budget).toEqual({ totalMs, mutationMs: Math.floor(totalMs * 0.7), faultMs: totalMs - Math.floor(totalMs * 0.7) });
  });

  it('orders the mutation batches by the seed, as a run with that seed would', async () => {
    const repo = createTempRepo();
    cleanups.push(() => repo.cleanup());
    const files = ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts', 'src/f.ts'];
    for (const file of files) repo.write(file, 'export const f = (a: number) => a > 1;\n');
    repo.branch('origin/main', repo.commit('Base'));
    for (const file of files) repo.edit(file, 'a > 1', 'a > 2');
    repo.commit('Change');
    const batchesFor = async (seed: number) => (await plan(repo, { level: 'shake', seed })).mutation?.batches;
    const ranges = files.map((file) => ({ file, startLine: 1, endLine: 1, kind: 'changed' as const, staticRegion: false }));
    const expected = (seed: number) => planBatches(ranges, PRESETS[3].maxBatches, seed).map((batch) => batch.files.map((entry) => entry.file));
    for (const seed of [12, 13, 14]) expect(await batchesFor(seed)).toEqual(expected(seed));
    expect((await plan(repo, { level: 'shake', seed: 12 })).estimate?.derivation[0]).toContain('mutation: 3 batches x');
    expect(new Set([12, 13, 14].map((seed) => JSON.stringify(expected(seed)))).size).toBeGreaterThan(1);
    const picked = await planRun({ cwd: repo.dir, level: 'shake' });
    expect(Number.isInteger(picked.seed)).toBe(true);
    expect(picked.mutation?.batches).toEqual(expected(picked.seed));
  });

  it('labels the time estimate as an estimate and shows how it was derived', async () => {
    const deps: Partial<PlanDeps> = {
      countMutants: () => Promise.resolve([{ file: 'src/a.ts', mutants: 12, moduleLevel: 0, reason: null }]),
    };
    const result = await plan(changedRepo(), { level: 'poke', deps });
    const mutationMs = ASSUMED_STRYKER_START_MS + 12 * ASSUMED_MS_PER_MUTANT;
    const faultMs = ASSUMED_DISCOVERY_MS + 1 * (2000 + PRESETS[1].testsPerCallSite * ASSUMED_TEST_MS);
    expect(result.estimate).toMatchObject({ mutationMs, faultMs, totalMs: mutationMs + faultMs });
    expect(result.estimate?.derivation.join('\n')).toMatch(/assumed/);
    expect(result.estimate?.derivation.join('\n')).toContain('12 mutants');
  });

  it('marks an estimate without measured timings as uncalibrated', async () => {
    const deps: Partial<PlanDeps> = {
      countMutants: () => Promise.resolve([{ file: 'src/a.ts', mutants: 12, moduleLevel: 0, reason: null }]),
    };
    const result = await plan(changedRepo(), { level: 'poke', deps });
    expect(result.estimate?.calibrated).toBe(false);
  });

  it('estimates from the timings an earlier run measured, and says they were measured', async () => {
    const deps: Partial<PlanDeps> = {
      countMutants: () => Promise.resolve([{ file: 'src/a.ts', mutants: 12, moduleLevel: 0, reason: null }]),
      readTimings: () => [
        {
          at: '2026-11-24T10:00:00.000Z',
          level: 'poke',
          mutation: { batchesStarted: 1, strykerStartMs: 50_000, dryRunNetMs: 8_000, mutantsMs: 30_000, mutantsRun: 10 },
          faults: { discoveryMs: 11_000, faultRuns: 2, faultRunsMs: 8_000 },
        },
      ],
    };
    const result = await plan(changedRepo(), { level: 'poke', deps });
    const mutationMs = 50_000 + 12 * 3_000;
    const faultMs = 11_000 + 1 * 1 * 4_000;
    expect(result.estimate).toMatchObject({ calibrated: true, mutationMs: Math.min(mutationMs, result.budget.mutationMs), faultMs });
    const derivation = result.estimate?.derivation.join('\n') ?? '';
    expect(derivation).toContain('1 batch x 50.0 s measured Stryker start and dry run + 12 mutants x 3.0 s measured each');
    expect(derivation).toContain('faults: 11.0 s measured discovery run + 1 call site found in the source x 1 fault kind x 4.0 s measured per faulted run');
    expect(derivation).not.toMatch(/assumed/);
  });

  it('counts an estimate as calibrated when the only unmeasured cost is one it multiplies by no call site', async () => {
    const repo = changedRepo();
    const deps: Partial<PlanDeps> = {
      countMutants: () => Promise.resolve([{ file: 'src/a.ts', mutants: 12, moduleLevel: 0, reason: null }]),
      readTimings: () => [
        {
          at: '2026-11-24T10:00:00.000Z',
          level: 'poke',
          mutation: { batchesStarted: 1, strykerStartMs: 50_000, dryRunNetMs: 8_000, mutantsMs: 30_000, mutantsRun: 10 },
          faults: { discoveryMs: 11_000, faultRuns: 0, faultRunsMs: 0 },
        },
      ],
    };
    const withCall = await plan(repo, { level: 'poke', deps });
    expect(withCall.faults?.calls).toHaveLength(1);
    expect(withCall.estimate?.calibrated).toBe(false);
    repo.write('src/a.ts', SOURCE.replace('fetch(', 'String('));
    const withoutCall = await plan(repo, { level: 'poke', deps });
    expect(withoutCall.faults?.calls).toEqual([]);
    expect(withoutCall.estimate?.calibrated).toBe(true);
  });

  it('lists the fault kinds a run would use and counts a run per site and kind in the estimate', async () => {
    const deps: Partial<PlanDeps> = {
      countMutants: () => Promise.resolve([{ file: 'src/a.ts', mutants: 12, moduleLevel: 0, reason: null }]),
    };
    const result = await plan(changedRepo(), { level: 'shake', deps });
    const kinds = PRESETS[3].faultKinds.filter(isRunnableKind);
    expect(result.faults?.kinds).toEqual(kinds);
    const tests = PRESETS[3].testsPerCallSite * ASSUMED_TEST_MS;
    const perSite = 2000 + tests + (kinds.length - 1) * tests;
    expect(result.estimate?.faultMs).toBe(ASSUMED_DISCOVERY_MS + perSite);
    expect(result.estimate?.derivation.join('\n')).toContain(`${kinds.length} fault kinds`);
  });

  it('caps each part of the estimate at its budget', async () => {
    const deps: Partial<PlanDeps> = {
      countMutants: () => Promise.resolve([{ file: 'src/a.ts', mutants: 100_000, moduleLevel: 0, reason: null }]),
    };
    const result = await plan(changedRepo(), { level: 'poke', deps });
    expect(result.estimate?.mutationMs).toBe(result.budget.mutationMs);
    expect(result.estimate?.totalMs).toBeLessThanOrEqual(PRESETS[1].budgetMs);
  });

  it('runs nothing and leaves the working tree exactly as it was', async () => {
    const repo = changedRepo();
    repo.write('src/a.ts', `${SOURCE}export const dirty = 1;\n`);
    const before = snapshot(repo.dir);
    const status = repo.git('status', '--porcelain', '--ignored');
    await plan(repo, { level: 'shake' });
    expect(snapshot(repo.dir)).toEqual(before);
    expect(repo.git('status', '--porcelain', '--ignored')).toBe(status);
    expect(fs.existsSync(path.join(repo.dir, '.chimpd'))).toBe(false);
  });

  it('plans a test-only change: the source the tests reach, and no fault phase', async () => {
    const result = await plan(changedRepo({ testOnly: true }));
    expect(result.scope?.mode).toBe('test-only');
    expect(result.scope?.boundaryFiles).toEqual(['src/a.ts']);
    expect(result.mutation?.files.map((entry) => entry.file)).toEqual(['src/a.ts']);
    expect(result.faults).toMatchObject({ calls: [], notRun: 'only test files changed; the fault phase faults calls made from changed source code' });
    expect(result.budget.faultMs).toBe(0);
  });

  it('says so when nothing is in scope', async () => {
    const repo = createTempRepo();
    cleanups.push(() => repo.cleanup());
    repo.write('README.md', '# a\n');
    repo.branch('origin/main', repo.commit('Base'));
    repo.write('README.md', '# b\n');
    repo.commit('Docs');
    const result = await plan(repo);
    expect(result.status).toBe('nothing-in-scope');
    expect(result.mutation).toBeNull();
    expect(result.faults).toBeNull();
    expect(exitCodeOfPlan(result)).toBe(0);
  });

  it('still plans with a baseline a run cannot read, and says a run would stop there', async () => {
    const repo = changedRepo();
    repo.write('chimpd-baseline.json', '{ "version": 7, "entries": [] }\n');
    const result = await plan(repo);
    expect(result.status).toBe('planned');
    expect(result.runWouldFail).toBe('chimpd-baseline.json has version 7; this chimpd reads version 1');
    expect(exitCodeOfPlan(result)).toBe(0);
  });

  it('still plans without a Vitest config, and says a run would stop there', async () => {
    const result = await plan(changedRepo({ config: false }));
    expect(result.status).toBe('planned');
    expect(result.vitestConfig).toBeNull();
    expect(result.runWouldFail).toContain('no Vitest config found in');
    expect(exitCodeOfPlan(result)).toBe(0);
  });
});

describe('planRun failure paths', () => {
  it('cannot plan outside a git repository: error, exit 2', async () => {
    const dir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'chimpd-plan-nogit-'));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const result = await planRun({ cwd: dir, level: 'poke' });
    expect(result.status).toBe('error');
    expect(result.error).toContain('is not inside a git repository');
    expect(result.mutation).toBeNull();
    expect(exitCodeOfPlan(result)).toBe(2);
  });

  it('cannot plan against a missing base ref: error, exit 2', async () => {
    const result = await plan(changedRepo(), { base: 'origin/nope' });
    expect(result.status).toBe('error');
    expect(result.error).toContain("base ref 'origin/nope' does not resolve");
    expect(exitCodeOfPlan(result)).toBe(2);
  });

  it('rejects an invalid seed: error, exit 2', async () => {
    const result = await plan(changedRepo(), { seed: -3 });
    expect(result.status).toBe('error');
    expect(result.error).toBe('seed must be an integer from 0 to 2147483647, not -3');
    expect(exitCodeOfPlan(result)).toBe(2);
  });

  it('marks the counts unavailable, with the reason, when the instrumenter fails, and still exits 0', async () => {
    const deps: Partial<PlanDeps> = { countMutants: () => Promise.reject(new Error('instrumenter exploded\n    at stack')) };
    const result = await plan(changedRepo(), { deps });
    expect(result.status).toBe('planned');
    expect(result.mutation?.total).toBeNull();
    expect(result.mutation?.files).toEqual([
      { file: 'src/a.ts', mutants: null, moduleLevel: null, reason: 'count unavailable: instrumenter exploded' },
    ]);
    expect(result.estimate?.derivation.join('\n')).toContain(`${PRESETS[1].estimatedMutantsPerLine} mutant per scoped line`);
    expect(exitCodeOfPlan(result)).toBe(0);
  });
});

describe('countMutants', () => {
  it('marks a file the instrumenter cannot parse as unavailable and still counts the others', async () => {
    const repo = createTempRepo();
    cleanups.push(() => repo.cleanup());
    repo.write('src/ok.ts', 'export const ok = (a: number) => a > 1;\n');
    repo.write('src/broken.ts', 'export const broken = (a: number => a > ;\n');
    const counts = await countMutants({
      targetRoot: repo.dir,
      intensity: 1,
      ranges: [
        { file: 'src/ok.ts', startLine: 1, endLine: 1, kind: 'changed', staticRegion: false },
        { file: 'src/broken.ts', startLine: 1, endLine: 1, kind: 'changed', staticRegion: false },
      ],
    });
    expect(counts.map((entry) => entry.file)).toEqual(['src/broken.ts', 'src/ok.ts']);
    expect(counts[0]).toMatchObject({ mutants: null, moduleLevel: null });
    expect(counts[0]?.reason).toMatch(/^count unavailable: /);
    expect(counts[1]?.mutants).toBeGreaterThan(0);
    expect(counts[1]?.reason).toBeNull();
  });

  it('counts only mutants that start inside the scoped lines, and those in module-level code apart', async () => {
    const repo = createTempRepo();
    cleanups.push(() => repo.cleanup());
    repo.write('src/a.ts', 'export const LIMIT = 1 > 0;\nexport const f = (a: number) => a > 1;\nexport const g = (a: number) => a < 1;\n');
    const count = (startLine: number, endLine: number, staticRegion: boolean) =>
      countMutants({ targetRoot: repo.dir, intensity: 1, ranges: [{ file: 'src/a.ts', startLine, endLine, kind: 'changed', staticRegion }] });
    const [line2] = await count(2, 2, false);
    const [lines23] = await count(2, 3, false);
    const [line1] = await count(1, 1, true);
    expect(line2?.mutants).toBeGreaterThan(0);
    expect(lines23?.mutants).toBe((line2?.mutants ?? 0) * 2);
    expect(line2?.moduleLevel).toBe(0);
    expect(line1?.moduleLevel).toBe(line1?.mutants);
  });
});
