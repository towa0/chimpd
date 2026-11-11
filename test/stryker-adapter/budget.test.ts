import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ScopeRange } from '../../src/core/index.js';
import { runMutation } from '../../src/stryker-adapter/index.js';
import { createTempRepo, type TempRepo } from '../helpers/temp-repo.js';

const fakeWorker = fileURLToPath(new URL('../fixtures/fake-stryker-worker.mjs', import.meta.url));

function range(file: string): ScopeRange {
  return { file, startLine: 1, endLine: 5, kind: 'changed', staticRegion: false };
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
    process.env.CHIMPD_FAKE_PIDS = pidFile;
    process.env.CHIMPD_FAKE_FILE = path.join(repo.dir, 'src/a.ts');
  });

  afterEach(() => {
    delete process.env.CHIMPD_FAKE_PIDS;
    delete process.env.CHIMPD_FAKE_FILE;
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
    const result = await runMutation({
      targetRoot: repo.dir,
      ranges: [range('src/a.ts'), range('src/b.ts'), range('src/c.ts')],
      intensity: 3,
      ignoreStatic: true,
      budgetMs: 1800,
      workerEntry: fakeWorker,
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
    expect(result.mutants).toEqual([]);
    expect(result.notTested.unplannedFiles).toEqual(['src/a.ts', 'src/b.ts']);
    expect(grandchildren()).toEqual([]);
  });
});
