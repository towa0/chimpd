import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { calibrate, readTimings, recordTimings, TIMINGS_FILE, type RunTimings } from '../../src/timings/index.js';
import { createTempRepo, type TempRepo } from '../helpers/temp-repo.js';

const repos: TempRepo[] = [];

afterEach(() => {
  for (const repo of repos.splice(0)) repo.cleanup();
});

function repo(): TempRepo {
  const created = createTempRepo();
  repos.push(created);
  return created;
}

function run(overrides: Partial<RunTimings> = {}): RunTimings {
  return {
    at: '2026-11-24T10:00:00.000Z',
    level: 'poke',
    mutation: { batchesStarted: 1, strykerStartMs: 54_800, dryRunNetMs: 8_500, mutantsMs: 29_000, mutantsRun: 8 },
    faults: { discoveryMs: 11_400, faultRuns: 2, faultRunsMs: 6_000 },
    ...overrides,
  };
}

describe('timings file', () => {
  it('reads nothing when no run has been recorded', () => {
    expect(readTimings(repo().dir)).toEqual([]);
  });

  it('records runs in the git-ignored work directory and keeps the last ten', () => {
    const target = repo();
    for (let index = 0; index < 12; index += 1) recordTimings(target.dir, run({ at: `run ${index}` }));
    const runs = readTimings(target.dir);
    expect(runs.map((entry) => entry.at)).toEqual(Array.from({ length: 10 }, (_, index) => `run ${index + 2}`));
    expect(fs.readFileSync(path.join(target.dir, '.bruise/.gitignore'), 'utf8')).toBe('*\n');
    expect(TIMINGS_FILE).toBe('.bruise/timings.json');
  });

  it('reads an unreadable file or one of another version as no runs', () => {
    const target = repo();
    fs.mkdirSync(path.join(target.dir, '.bruise'));
    fs.writeFileSync(path.join(target.dir, TIMINGS_FILE), '{ not json');
    expect(readTimings(target.dir)).toEqual([]);
    fs.writeFileSync(path.join(target.dir, TIMINGS_FILE), JSON.stringify({ version: 99, runs: [run()] }));
    expect(readTimings(target.dir)).toEqual([]);
  });
});

describe('calibration', () => {
  it('has no measured cost without runs', () => {
    expect(calibrate([])).toEqual({ strykerStartMs: null, msPerMutant: null, discoveryMs: null, msPerFaultRun: null });
  });

  it('takes each cost from the most recent run that measured it, per batch, mutant and faulted run', () => {
    const older = run({ mutation: { batchesStarted: 2, strykerStartMs: 40_000, dryRunNetMs: 0, mutantsMs: 10_000, mutantsRun: 4 } });
    const newer = run({
      mutation: { batchesStarted: 1, strykerStartMs: 30_000, dryRunNetMs: 0, mutantsMs: 0, mutantsRun: 0 },
      faults: { discoveryMs: null, faultRuns: 0, faultRunsMs: 0 },
    });
    expect(calibrate([older, newer])).toEqual({ strykerStartMs: 30_000, msPerMutant: 2_500, discoveryMs: 11_400, msPerFaultRun: 3_000 });
  });
});
