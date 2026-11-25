import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Clock, ScopeRange } from '../../src/core/index.js';
import { planBatches, runMutation, type WorkerMessage } from '../../src/stryker-adapter/index.js';
import type { ProgressEvent } from '../../src/progress/events.js';
import { createTempRepo, type TempRepo } from '../helpers/temp-repo.js';

const fakeWorker = fileURLToPath(new URL('../fixtures/fake-stryker-worker.mjs', import.meta.url));

function range(file: string): ScopeRange {
  return { file, startLine: 1, endLine: 5, kind: 'changed', staticRegion: false };
}

interface ManualClock extends Clock {
  fireNext(): void;
}

/** Time moves only when a timer is fired, so a kill lands exactly when the test decides. */
function manualClock(): ManualClock {
  let time = 0;
  let nextId = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  return {
    now: () => time,
    setTimeout(callback, ms) {
      nextId += 1;
      timers.set(nextId, { at: time + ms, callback });
      return nextId;
    },
    clearTimeout(handle) {
      timers.delete(handle as number);
    },
    fireNext() {
      const [id, timer] = [...timers].sort(([, a], [, b]) => a.at - b.at)[0] ?? [];
      if (id === undefined || timer === undefined) throw new Error('no timer is pending');
      timers.delete(id);
      time = Math.max(time, timer.at);
      timer.callback();
    },
  };
}

// The fake worker sends its result last, so killing on it leaves every earlier message delivered.
function killOnResult(clock: ManualClock): (message: WorkerMessage) => void {
  return (message) => {
    if (message.type === 'mutant') clock.fireNext();
  };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntilDead(pids: readonly number[]): Promise<boolean> {
  const deadline = performance.now() + 5000;
  while (pids.some(isAlive)) {
    if (performance.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return true;
}

describe('budget enforcement', () => {
  let repo: TempRepo;
  let pidFile: string;

  beforeEach(() => {
    repo = createTempRepo();
    for (const file of ['src/a.ts', 'src/b.ts', 'src/c.ts']) repo.write(file, 'export const A = 1;\nexport const B = 2;\n');
    pidFile = path.join(path.dirname(repo.dir), 'grandchildren.txt');
    fs.writeFileSync(pidFile, '');
    process.env.BRUISE_FAKE_PIDS = pidFile;
    process.env.BRUISE_FAKE_FILE = path.join(repo.dir, 'src/a.ts');
  });

  afterEach(() => {
    delete process.env.BRUISE_FAKE_PIDS;
    delete process.env.BRUISE_FAKE_FILE;
    repo.cleanup();
  });

  const grandchildren = (): number[] => fs.readFileSync(pidFile, 'utf8').split('\n').filter(Boolean).map(Number);

  it('kills a batch at the total budget and keeps every result already streamed', async () => {
    const startedAt = performance.now();
    const result = await runMutation({
      targetRoot: repo.dir,
      ranges: [range('src/a.ts')],
      intensity: 1,
      ignoreStatic: true,
      budgetMs: 1200,
      workerEntry: fakeWorker,
      // The wall-time bounds are about the kill, so the count that sizes the concurrency is kept out of them.
      countMutants: () => Promise.resolve([{ file: 'src/a.ts', mutants: 3, moduleLevel: 0, reason: null }]),
    });
    const elapsedMs = performance.now() - startedAt;

    expect(elapsedMs).toBeGreaterThanOrEqual(1150);
    expect(elapsedMs).toBeLessThan(4000);
    expect(result.batches).toMatchObject([{ outcome: 'killed-budget', planned: 3, tested: 1, files: ['src/a.ts'] }]);
    expect(result.mutants.map((mutant) => [mutant.replacement, mutant.status, mutant.statusReason])).toEqual([
      ['replacement 1', 'Killed', null],
      ['replacement 2', 'NotTested', 'not tested: budget'],
      ['replacement 3', 'Ignored', null],
    ]);
    expect(result.notTested).toEqual({ reason: 'budget', mutants: 1, unplannedFiles: [] });
    expect(result.tests).toEqual([{ id: 'test/a.test.ts#a', name: 'a', file: 'test/a.test.ts' }]);
  });

  it('counts a mutant as not tested only when it is in scope and listed', async () => {
    const result = await runMutation({
      targetRoot: repo.dir,
      ranges: [{ file: 'src/a.ts', startLine: 1, endLine: 1, kind: 'changed', staticRegion: false }],
      intensity: 1,
      ignoreStatic: true,
      budgetMs: 1200,
      workerEntry: fakeWorker,
    });
    expect(result.mutants).toEqual([]);
    expect(result.outOfScope).toBe(3);
    expect(result.notTested).toEqual({ reason: 'budget', mutants: 0, unplannedFiles: [] });
  });

  it('caps the concurrency at the batch mutant count, half the cores and 4, unless one is given', async () => {
    const optionsFile = path.join(path.dirname(repo.dir), 'options.jsonl');
    process.env.BRUISE_FAKE_OPTIONS = optionsFile;
    try {
      repo.write('src/a.ts', 'export const f = (a: number): boolean => a > 1 && a < 9;\n');
      const request = { targetRoot: repo.dir, ranges: [range('src/a.ts')], intensity: 1 as const, ignoreStatic: true, budgetMs: 800, workerEntry: fakeWorker };
      const many = await runMutation({ ...request, cores: 64 });
      const few = await runMutation({ ...request, cores: 2 });
      const given = await runMutation({ ...request, cores: 64, concurrency: 7 });
      repo.write('src/a.ts', 'export const A = 1;\n');
      const none = await runMutation({ ...request, cores: 64 });
      expect([many, few, given, none].map((result) => result.batches[0]?.concurrency)).toEqual([4, 1, 7, 1]);
      const sent = fs.readFileSync(optionsFile, 'utf8').trim().split('\n').map((line) => (JSON.parse(line) as { concurrency: number }).concurrency);
      expect(sent).toEqual([4, 1, 7, 1]);
    } finally {
      delete process.env.BRUISE_FAKE_OPTIONS;
    }
  });

  it('reports each mutant in scope that gets a result, with the counted total, and not the ignored ones', async () => {
    const events: ProgressEvent[] = [];
    repo.write('src/a.ts', 'export const f = (a: number): boolean => a > 1;\nexport const B = 2;\n');
    await runMutation({
      targetRoot: repo.dir,
      ranges: [range('src/a.ts')],
      intensity: 1,
      ignoreStatic: true,
      budgetMs: 1200,
      workerEntry: fakeWorker,
      onProgress: (event) => events.push(event),
    });
    expect(events).toEqual([{ type: 'mutant-tested', file: 'src/a.ts', status: 'Killed', tested: 1, total: expect.any(Number) as number, at: expect.any(Number) as number }]);
    expect(events[0]?.type === 'mutant-tested' && (events[0].total ?? 0) > 0).toBe(true);
  });

  it('kills the whole process tree, including processes the batch started', async () => {
    await runMutation({
      targetRoot: repo.dir,
      ranges: [range('src/a.ts')],
      intensity: 1,
      ignoreStatic: true,
      budgetMs: 800,
      workerEntry: fakeWorker,
    });
    const pids = grandchildren();
    expect(pids).toHaveLength(1);
    expect(await waitUntilDead(pids)).toBe(true);
  });

  it('kills a batch at twice its share and stops launching once the budget is spent', async () => {
    const clock = manualClock();
    const result = await runMutation({
      targetRoot: repo.dir,
      ranges: [range('src/a.ts'), range('src/b.ts'), range('src/c.ts')],
      intensity: 3,
      ignoreStatic: true,
      budgetMs: 1800,
      workerEntry: fakeWorker,
      clock,
      onWorkerMessage: killOnResult(clock),
    });

    expect(result.batches.map((batch) => [batch.files, batch.outcome])).toEqual([
      [['src/a.ts'], 'killed-over-share'],
      [['src/b.ts'], 'killed-over-share'],
      [['src/c.ts'], 'not-launched'],
    ]);
    const [first, second] = result.batches;
    expect(first?.elapsedMs).toBeGreaterThanOrEqual(1150);
    expect(first?.elapsedMs).toBeLessThan(1700);
    expect(second?.elapsedMs).toBeLessThan(900);
    expect(result.notTested.unplannedFiles).toEqual(['src/c.ts']);
    expect(await waitUntilDead(grandchildren())).toBe(true);
  });

  it('measures the budget and kills on the injected clock, not on wall time', { timeout: 10_000 }, async () => {
    const clock = manualClock();
    const result = await runMutation({
      targetRoot: repo.dir,
      ranges: [range('src/a.ts')],
      intensity: 1,
      ignoreStatic: true,
      budgetMs: 3_600_000,
      workerEntry: fakeWorker,
      clock,
      onWorkerMessage: killOnResult(clock),
    });
    expect(result.batches).toMatchObject([{ outcome: 'killed-budget', planned: 3, tested: 1, elapsedMs: 3_600_000 }]);
    expect(result.batches[0]).toMatchObject({ strykerStartMs: 0, mutantsMs: 3_600_000, mutantsRun: 1 });
    expect(result.timings).toEqual({ batchesStarted: 1, strykerStartMs: 0, dryRunNetMs: 5, mutantsMs: 3_600_000, mutantsRun: 1 });
    expect(await waitUntilDead(grandchildren())).toBe(true);
  });

  it('hands what the worker writes to the output sink, and nothing to this process without one', async () => {
    const clock = manualClock();
    const stdout = vi.spyOn(process.stdout, 'write');
    const stderr = vi.spyOn(process.stderr, 'write');
    let captured = '';
    const request = {
      targetRoot: repo.dir,
      ranges: [range('src/a.ts')],
      intensity: 1 as const,
      ignoreStatic: true,
      budgetMs: 1200,
      workerEntry: fakeWorker,
      clock,
      onWorkerMessage: killOnResult(clock),
    };
    await runMutation({
      ...request,
      onTargetOutput: (text) => {
        captured += text;
      },
    });
    expect(captured).toContain('FAKE-WORKER-STDOUT\n');
    expect(captured).toContain('FAKE-WORKER-STDERR\n');
    const quiet = manualClock();
    await runMutation({ ...request, clock: quiet, onWorkerMessage: killOnResult(quiet) });
    const written = [...stdout.mock.calls, ...stderr.mock.calls].map(([chunk]) => String(chunk)).join('');
    expect(written).not.toContain('FAKE-WORKER');
    vi.restoreAllMocks();
    expect(await waitUntilDead(grandchildren())).toBe(true);
  });

  it('launches nothing with no budget and reports the files', async () => {
    const result = await runMutation({
      targetRoot: repo.dir,
      ranges: [range('src/a.ts'), range('src/b.ts')],
      intensity: 2,
      ignoreStatic: true,
      budgetMs: 0,
      workerEntry: fakeWorker,
    });
    expect(result.batches.map((batch) => batch.outcome)).toEqual(['not-launched', 'not-launched']);
    expect(result.timings).toEqual({ batchesStarted: 0, strykerStartMs: 0, dryRunNetMs: 0, mutantsMs: 0, mutantsRun: 0 });
    expect(result.mutants).toEqual([]);
    expect(result.notTested.unplannedFiles).toEqual(['src/a.ts', 'src/b.ts']);
    expect(grandchildren()).toEqual([]);
  });

  it('plans its batches in the order the seed gives files of equal prior', async () => {
    const ranges = ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts', 'src/f.ts'].map(range);
    const unseeded = planBatches(ranges, 3).map((batch) => batch.files.map((entry) => entry.file));
    expect([1, 2, 3].some((seed) => JSON.stringify(planBatches(ranges, 3, seed).map((batch) => batch.files.map((entry) => entry.file))) !== JSON.stringify(unseeded))).toBe(true);
    for (const seed of [1, 2, 3]) {
      const result = await runMutation({
        targetRoot: repo.dir,
        ranges,
        intensity: 3,
        ignoreStatic: true,
        budgetMs: 0,
        workerEntry: fakeWorker,
        seed,
      });
      expect(result.batches.map((batch) => batch.files)).toEqual(
        planBatches(ranges, 3, seed).map((batch) => batch.files.map((entry) => entry.file)),
      );
    }
  });
});
