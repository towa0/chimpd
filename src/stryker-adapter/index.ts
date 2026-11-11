import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  ensureWorkDir,
  PRESETS,
  rangeForLine,
  removeTree,
  startBudget,
  toPosix,
  type Intensity,
  type MutantRecord,
  type MutantStatus,
  type ScopeRange,
} from '../core/index.js';
import { planBatches, type Batch } from './batches.js';
import { decideChecker, strykerVersion, type CheckerDecision } from './checker.js';
import { buildStrykerOptions, STRYKER_TEMP_DIR } from './options.js';
import { runWorker, workerPath } from './process.js';
import type { WireMutant, WireTest } from './worker.js';

export { planBatches, mutatePatterns } from './batches.js';
export type { Batch, BatchFile } from './batches.js';
export { decideChecker, resolveCheckerTypeScript, strykerVersion } from './checker.js';
export type { CheckerDecision } from './checker.js';
export { buildStrykerOptions, STRYKER_TEMP_DIR } from './options.js';
export type { WireMutant } from './worker.js';

export interface MutationRequest {
  readonly targetRoot: string;
  readonly ranges: readonly ScopeRange[];
  readonly intensity: Intensity;
  readonly ignoreStatic: boolean;
  readonly budgetMs: number;
  readonly concurrency?: number;
  readonly vitestConfigFile?: string;
  /** Replaces the Stryker child process entry point; for tests of budget enforcement. */
  readonly workerEntry?: string;
}

export type BatchOutcome = 'completed' | 'failed' | 'killed-over-share' | 'killed-budget' | 'not-launched';

export interface BatchReport {
  readonly index: number;
  readonly files: readonly string[];
  readonly outcome: BatchOutcome;
  readonly elapsedMs: number;
  /** null when the batch ended before Stryker had planned its mutants. */
  readonly planned: number | null;
  readonly tested: number;
  readonly error: string | null;
}

export interface TestInfo {
  readonly id: string;
  readonly name: string;
  /** Repo-relative path with forward slashes. */
  readonly file: string;
}

export interface MutationResult {
  readonly mutants: readonly MutantRecord[];
  readonly tests: readonly TestInfo[];
  readonly batches: readonly BatchReport[];
  readonly notTested: {
    readonly reason: 'budget';
    readonly mutants: number;
    /** Files whose mutants were never planned, so their count is unknown. */
    readonly unplannedFiles: readonly string[];
  };
  readonly staticSkipped: { readonly count: number; readonly reason: string };
  readonly outOfScope: number;
  readonly checker: CheckerDecision;
  readonly strykerVersion: string;
  readonly dryRunNetMs: number | null;
}

export const NOT_TESTED_REASON = 'not tested: budget';
const STATIC_REASON = 'static mutants are skipped because ignoreStatic is on';
const OVER_SHARE_FACTOR = 2;
const FINAL_STATUSES = new Set(['Killed', 'Survived', 'NoCoverage', 'CompileError', 'RuntimeError', 'Timeout', 'Ignored']);

function relativeFile(targetRoot: string, fileName: string): string {
  return toPosix(path.relative(targetRoot, path.resolve(targetRoot, fileName)));
}

function testFileOf(targetRoot: string, test: WireTest): string {
  if (test.fileName !== null) {
    const relative = relativeFile(targetRoot, test.fileName);
    // Tests run inside Stryker's sandbox copy; their path there mirrors the project layout.
    const sandbox = /^\.chimpd\/stryker-tmp\/[^/]+\/(.*)$/.exec(relative);
    return sandbox?.[1] ?? relative;
  }
  return test.id.split('#')[0] ?? test.id;
}

function compareMutants(a: MutantRecord, b: MutantRecord): number {
  const text = (x: string, y: string): number => (x < y ? -1 : x > y ? 1 : 0);
  return (
    text(a.file, b.file) ||
    a.start.line - b.start.line ||
    a.start.column - b.start.column ||
    a.end.line - b.end.line ||
    a.end.column - b.end.column ||
    text(a.mutatorName, b.mutatorName) ||
    text(a.replacement, b.replacement)
  );
}

export interface MutantOutcome {
  readonly mutant: WireMutant;
  readonly status: MutantStatus;
  readonly statusReason: string | null;
}

function finalStatus(mutant: WireMutant | undefined): MutantStatus | null {
  const status = mutant?.status ?? null;
  return status !== null && FINAL_STATUSES.has(status) ? (status as MutantStatus) : null;
}

/** Joins the planned mutants with the results that arrived before the batch ended. */
export function resolveOutcomes(
  planned: ReadonlyMap<string, WireMutant>,
  tested: ReadonlyMap<string, WireMutant>,
): MutantOutcome[] {
  const outcomes: MutantOutcome[] = [];
  for (const id of new Set([...planned.keys(), ...tested.keys()])) {
    const finished = tested.get(id);
    const plan = planned.get(id);
    const finishedStatus = finalStatus(finished);
    const earlyStatus = finalStatus(plan);
    if (finished !== undefined && finishedStatus !== null) {
      outcomes.push({ mutant: finished, status: finishedStatus, statusReason: finished.statusReason });
    } else if (plan !== undefined && earlyStatus !== null) {
      outcomes.push({ mutant: plan, status: earlyStatus, statusReason: plan.statusReason });
    } else if (plan !== undefined) {
      outcomes.push({ mutant: plan, status: 'NotTested', statusReason: NOT_TESTED_REASON });
    }
  }
  return outcomes;
}

interface BatchRun {
  readonly report: BatchReport;
  readonly planned: ReadonlyMap<string, WireMutant>;
  readonly tested: ReadonlyMap<string, WireMutant>;
  readonly tests: readonly WireTest[];
  readonly dryRunNetMs: number | null;
}

async function runBatch(request: MutationRequest, batch: Batch, checker: CheckerDecision, shareMs: number, remainingMs: number): Promise<BatchRun> {
  const planned = new Map<string, WireMutant>();
  const tested = new Map<string, WireMutant>();
  let tests: readonly WireTest[] = [];
  let dryRunNetMs: number | null = null;
  let plannedCount: number | null = null;

  const overShareMs = shareMs * OVER_SHARE_FACTOR;
  const run = await runWorker({
    cwd: request.targetRoot,
    killAfterMs: Math.min(overShareMs, remainingMs),
    ...(request.workerEntry === undefined ? {} : { entry: request.workerEntry }),
    options: buildStrykerOptions({
      batch,
      preset: PRESETS[request.intensity],
      ignoreStatic: request.ignoreStatic,
      checkerEnabled: checker.enabled,
      pluginPath: workerPath(),
      ...(request.concurrency === undefined ? {} : { concurrency: request.concurrency }),
      ...(request.vitestConfigFile === undefined ? {} : { vitestConfigFile: request.vitestConfigFile }),
    }),
    onMessage(message) {
      if (message.type === 'dry-run') {
        tests = message.tests;
        dryRunNetMs = message.netMs;
      } else if (message.type === 'plan') {
        plannedCount = message.mutants.length;
        for (const mutant of message.mutants) planned.set(mutant.id, mutant);
      } else if (message.type === 'mutant') {
        tested.set(message.mutant.id, message.mutant);
      }
    },
  });

  // A killed run never reaches Stryker's own cleanup of its sandbox.
  removeTree(path.join(request.targetRoot, STRYKER_TEMP_DIR));

  const outcome: BatchOutcome =
    run.outcome === 'killed' ? (overShareMs <= remainingMs ? 'killed-over-share' : 'killed-budget') : run.outcome;
  return {
    planned,
    tested,
    tests,
    dryRunNetMs,
    report: {
      index: batch.index,
      files: batch.files.map((entry) => entry.file),
      outcome,
      elapsedMs: Math.round(run.elapsedMs),
      planned: plannedCount,
      tested: tested.size,
      error: run.error,
    },
  };
}

export async function runMutation(request: MutationRequest): Promise<MutationResult> {
  const preset = PRESETS[request.intensity];
  const checker = decideChecker(request.targetRoot);
  const batches = planBatches(request.ranges, preset.maxBatches);
  const budget = startBudget(request.budgetMs);
  ensureWorkDir(request.targetRoot);

  const hashes = new Map<string, string>();
  const sourceHash = (file: string): string => {
    let hash = hashes.get(file);
    if (hash === undefined) {
      hash = createHash('sha256').update(fs.readFileSync(path.join(request.targetRoot, file))).digest('hex');
      hashes.set(file, hash);
    }
    return hash;
  };

  const reports: BatchReport[] = [];
  const records: MutantRecord[] = [];
  const tests = new Map<string, TestInfo>();
  const unplannedFiles: string[] = [];
  let notTested = 0;
  let outOfScope = 0;
  let dryRunNetMs: number | null = null;

  function record(mutant: WireMutant, status: MutantStatus, statusReason: string | null): void {
    const file = relativeFile(request.targetRoot, mutant.fileName);
    const range = rangeForLine(request.ranges, file, mutant.start.line);
    if (range === null) {
      outOfScope += 1;
      return;
    }
    records.push({
      file,
      start: mutant.start,
      end: mutant.end,
      mutatorName: mutant.mutatorName,
      replacement: mutant.replacement,
      status,
      statusReason,
      coveredBy: [...mutant.coveredBy].sort(),
      killedBy: [...mutant.killedBy].sort(),
      static: mutant.static,
      sourceHash: sourceHash(file),
      scopeKind: range.kind,
    });
  }

  for (const batch of batches) {
    const files = batch.files.map((entry) => entry.file);
    if (budget.exhausted()) {
      reports.push({ index: batch.index, files, outcome: 'not-launched', elapsedMs: 0, planned: null, tested: 0, error: null });
      unplannedFiles.push(...files);
      continue;
    }
    const remainingBatches = batches.length - batch.index;
    const remainingMs = budget.remainingMs();
    const run = await runBatch(request, batch, checker, remainingMs / remainingBatches, remainingMs);
    reports.push(run.report);
    dryRunNetMs = dryRunNetMs === null ? run.dryRunNetMs : dryRunNetMs + (run.dryRunNetMs ?? 0);

    for (const test of run.tests) {
      tests.set(test.id, { id: test.id, name: test.name, file: testFileOf(request.targetRoot, test) });
    }
    if (run.report.planned === null && run.report.outcome !== 'completed') unplannedFiles.push(...files);

    for (const outcome of resolveOutcomes(run.planned, run.tested)) {
      if (outcome.status === 'NotTested') notTested += 1;
      record(outcome.mutant, outcome.status, outcome.statusReason);
    }
  }

  const staticSkipped = records.filter((mutant) => mutant.static && mutant.status === 'Ignored').length;
  return {
    mutants: records.sort(compareMutants),
    tests: [...tests.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    batches: reports,
    notTested: { reason: 'budget', mutants: notTested, unplannedFiles: unplannedFiles.sort() },
    staticSkipped: { count: staticSkipped, reason: STATIC_REASON },
    outOfScope,
    checker,
    strykerVersion: strykerVersion(),
    dryRunNetMs,
  };
}
