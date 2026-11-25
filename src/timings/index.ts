import fs from 'node:fs';
import path from 'node:path';
import { ensureWorkDir, WORK_DIR_NAME } from '../core/index.js';

/** Where measured run timings are kept, from the target root; inside bruise's git-ignored work directory. */
export const TIMINGS_FILE = `${WORK_DIR_NAME}/timings.json`;
export const TIMINGS_VERSION = 1;
const KEPT_RUNS = 10;

export interface MutationTimings {
  /** Batches whose Stryker start and dry run finished. */
  readonly batchesStarted: number;
  /** From launching Stryker to the end of its dry run, summed over those batches. */
  readonly strykerStartMs: number;
  /** The dry run's own test time, as Stryker measured it. */
  readonly dryRunNetMs: number;
  /** From the end of the dry run to the end of the batch, summed. */
  readonly mutantsMs: number;
  /** Mutants Stryker ran or type-checked in that time; ignored mutants and ones the budget cut off are not counted. */
  readonly mutantsRun: number;
}

export interface FaultTimings {
  /** The unfaulted run that discovers call sites; null when it did not finish. */
  readonly discoveryMs: number | null;
  /** Faulted runs that finished, one per site and fault kind. */
  readonly faultRuns: number;
  readonly faultRunsMs: number;
}

export interface RunTimings {
  readonly at: string;
  readonly level: string;
  readonly mutation: MutationTimings | null;
  readonly faults: FaultTimings | null;
}

interface TimingsFile {
  readonly version: typeof TIMINGS_VERSION;
  readonly runs: readonly RunTimings[];
}

export function perMutantMs(timings: MutationTimings): number | null {
  return timings.mutantsRun > 0 ? timings.mutantsMs / timings.mutantsRun : null;
}

export function perBatchStartMs(timings: MutationTimings): number | null {
  return timings.batchesStarted > 0 ? timings.strykerStartMs / timings.batchesStarted : null;
}

export function perFaultRunMs(timings: FaultTimings): number | null {
  return timings.faultRuns > 0 ? timings.faultRunsMs / timings.faultRuns : null;
}

function isRun(value: unknown): value is RunTimings {
  if (typeof value !== 'object' || value === null) return false;
  const run = value as Record<string, unknown>;
  return typeof run.at === 'string' && typeof run.level === 'string' && 'mutation' in run && 'faults' in run;
}

/** The recorded runs, oldest first; none when the file is missing, unreadable or of another version. */
export function readTimings(targetRoot: string): RunTimings[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(targetRoot, TIMINGS_FILE), 'utf8'));
  } catch {
    return [];
  }
  const file = parsed as Partial<TimingsFile> | null;
  if (file?.version !== TIMINGS_VERSION || !Array.isArray(file.runs)) return [];
  return file.runs.filter(isRun);
}

/** Adds a run and keeps the most recent ones. The file only calibrates estimates, so a failed write does not fail the run. */
export function recordTimings(targetRoot: string, run: RunTimings): void {
  try {
    ensureWorkDir(targetRoot);
    const runs = [...readTimings(targetRoot), run].slice(-KEPT_RUNS);
    const file: TimingsFile = { version: TIMINGS_VERSION, runs };
    fs.writeFileSync(path.join(targetRoot, TIMINGS_FILE), `${JSON.stringify(file, null, 2)}\n`);
  } catch {
    return;
  }
}

/** Per-unit costs from the most recent run that measured each of them; null where no run did. */
export interface Calibration {
  readonly strykerStartMs: number | null;
  readonly msPerMutant: number | null;
  readonly discoveryMs: number | null;
  readonly msPerFaultRun: number | null;
}

export function calibrate(runs: readonly RunTimings[]): Calibration {
  const latest = <T>(pick: (run: RunTimings) => T | null): T | null => {
    for (const run of runs.toReversed()) {
      const value = pick(run);
      if (value !== null) return value;
    }
    return null;
  };
  return {
    strykerStartMs: latest((run) => (run.mutation === null ? null : perBatchStartMs(run.mutation))),
    msPerMutant: latest((run) => (run.mutation === null ? null : perMutantMs(run.mutation))),
    discoveryMs: latest((run) => run.faults?.discoveryMs ?? null),
    msPerFaultRun: latest((run) => (run.faults === null ? null : perFaultRunMs(run.faults))),
  };
}
