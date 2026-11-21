import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  ensureWorkDir,
  realClock,
  excludedMutators,
  PRESETS,
  rangeForLine,
  removeTree,
  startBudget,
  toPosix,
  type Clock,
  type Intensity,
  type MutantRecord,
  type MutantStatus,
  type ScopeRange,
} from '../core/index.js';
import { planBatches, type Batch } from './batches.js';
import { decideChecker, strykerVersion, type CheckerDecision } from './checker.js';
import { buildStrykerOptions, STRYKER_TEMP_DIR } from './options.js';
import { runWorker, workerPath } from './process.js';
import type { WireMutant, WireTest, WorkerMessage } from './worker.js';

export { escapeGlob, mutatePatterns, planBatches } from './batches.js';
export type { Batch, BatchFile } from './batches.js';
export { decideChecker, resolveCheckerTypeScript, strykerVersion } from './checker.js';
export type { CheckerDecision } from './checker.js';
export { buildStrykerOptions, STRYKER_TEMP_DIR } from './options.js';
export type { WireMutant, WorkerMessage } from './worker.js';

export interface MutationRequest {
  readonly targetRoot: string;
  readonly ranges: readonly ScopeRange[];
  readonly intensity: Intensity;
  readonly ignoreStatic: boolean;
  readonly budgetMs: number;
  readonly concurrency?: number;
  readonly vitestConfigFile?: string;
  /** Replaces the Stryker child process entry point; it must also be loadable as the reporter plugin. */
  readonly workerEntry?: string;
  /** Measures the budget and times the kills; wall time when omitted. */
  readonly clock?: Clock;
  /** Sees every progress message of a batch after the adapter has recorded it. */
  readonly onWorkerMessage?: (message: WorkerMessage) => void;
  /** Receives what Stryker and the target's tests write to stdout and stderr; it is discarded without one. */
  readonly onTargetOutput?: (text: string) => void;
}

/** dry-run-failed: the target's own tests failed or errored with no mutant active, so no mutant was judged. */
export type BatchOutcome = 'completed' | 'failed' | 'dry-run-failed' | 'killed-over-share' | 'killed-budget' | 'not-launched';

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
  /** Mutants Stryker listed for mutators the preset excludes; they are not part of the results. */
  readonly excludedByPreset: number;
  readonly checker: CheckerDecision;
  /** Name of the target's own Stryker config file, which chimpd does not load; null when there is none. */
  readonly targetConfigIgnored: string | null;
  readonly strykerVersion: string;
  readonly dryRunNetMs: number | null;
}

export const NOT_TESTED_REASON = 'not tested: budget';
const STATIC_REASON = 'static mutants are skipped because ignoreStatic is on';
const OVER_SHARE_FACTOR = 2;
const FINAL_STATUSES = new Set(['Killed', 'Survived', 'NoCoverage', 'CompileError', 'RuntimeError', 'Timeout', 'Ignored']);
const TYPE_CHECK_FAILURE = 'Typescript error(s) found in dry run compilation';
/** What Stryker throws when the initial test run, with no mutant active, has failing tests or errors. */
const DRY_RUN_FAILURES = ['There were failed tests in the initial test run', 'Something went wrong in the initial test run'];
const EMPTY_CONFIG_FILE = 'stryker.config.json';

/** The names Stryker searches for in the working directory, in its order. */
export const TARGET_CONFIG_NAMES: readonly string[] = ['', '.'].flatMap((prefix) =>
  ['.conf', '.config'].flatMap((suffix) =>
    ['json', 'js', 'mjs', 'cjs'].map((extension) => `${prefix}stryker${suffix}.${extension}`),
  ),
);

export function findTargetConfig(targetRoot: string): string | null {
  return TARGET_CONFIG_NAMES.find((name) => fs.existsSync(path.join(targetRoot, name))) ?? null;
}

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

export const UNCOVERED_REASON = 'no test runs this mutant: Stryker reported no coverage for its batch';

/**
 * Stryker's Vitest runner reports no coverage at all when no test executes any mutant of the batch.
 * Stryker then treats coverage analysis as off and runs every test against each mutant, which
 * reports an unexecuted mutant as Survived. A kill under that missing coverage would instead mean
 * coverage collection itself broke, so the survivors are only reclassified when nothing was killed.
 */
export function reclassifyUncovered(outcomes: readonly MutantOutcome[], coverageReported: boolean | null): MutantOutcome[] {
  const executed = outcomes.some((outcome) => outcome.status === 'Killed' || outcome.status === 'Timeout');
  if (coverageReported !== false || executed) return [...outcomes];
  return outcomes.map((outcome) =>
    outcome.status === 'Survived' ? { ...outcome, status: 'NoCoverage', statusReason: UNCOVERED_REASON } : outcome,
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
  readonly coverageReported: boolean | null;
}

interface BatchContext {
  readonly request: MutationRequest;
  readonly configFile: string;
  readonly checkerEnabled: boolean;
  readonly shareMs: number;
  readonly remainingMs: number;
}

async function runBatch(batch: Batch, context: BatchContext): Promise<BatchRun> {
  const { request, remainingMs } = context;
  const planned = new Map<string, WireMutant>();
  const tested = new Map<string, WireMutant>();
  let tests: readonly WireTest[] = [];
  let dryRunNetMs: number | null = null;
  let coverageReported: boolean | null = null;
  let plannedCount: number | null = null;

  const entry = request.workerEntry ?? workerPath();
  const overShareMs = context.shareMs * OVER_SHARE_FACTOR;
  const run = await runWorker({
    cwd: request.targetRoot,
    killAfterMs: Math.min(overShareMs, remainingMs),
    entry,
    clock: request.clock ?? realClock,
    ...(request.onTargetOutput === undefined ? {} : { onOutput: request.onTargetOutput }),
    options: buildStrykerOptions({
      batch,
      preset: PRESETS[request.intensity],
      ignoreStatic: request.ignoreStatic,
      checkerEnabled: context.checkerEnabled,
      pluginPath: entry,
      configFile: context.configFile,
      ...(request.concurrency === undefined ? {} : { concurrency: request.concurrency }),
      ...(request.vitestConfigFile === undefined ? {} : { vitestConfigFile: request.vitestConfigFile }),
    }),
    onMessage(message) {
      if (message.type === 'dry-run') {
        tests = message.tests;
        dryRunNetMs = message.netMs;
        coverageReported = message.coverageReported ?? null;
      } else if (message.type === 'plan') {
        plannedCount = message.mutants.length;
        for (const mutant of message.mutants) planned.set(mutant.id, mutant);
      } else if (message.type === 'mutant') {
        tested.set(message.mutant.id, message.mutant);
      }
      request.onWorkerMessage?.(message);
    },
  });

  // A killed run never reaches Stryker's own cleanup of its sandbox.
  removeTree(path.join(request.targetRoot, STRYKER_TEMP_DIR));

  const dryRunFailed = run.outcome === 'failed' && DRY_RUN_FAILURES.some((text) => (run.error ?? '').includes(text));
  const outcome: BatchOutcome =
    run.outcome === 'killed'
      ? overShareMs <= remainingMs
        ? 'killed-over-share'
        : 'killed-budget'
      : dryRunFailed
        ? 'dry-run-failed'
        : run.outcome;
  return {
    planned,
    tested,
    tests,
    dryRunNetMs,
    coverageReported,
    report: {
      index: batch.index,
      files: batch.files.map((file) => file.file),
      outcome,
      elapsedMs: Math.round(run.elapsedMs),
      planned: plannedCount,
      tested: tested.size,
      error: run.error,
    },
  };
}

function failedTypeCheck(run: BatchRun): boolean {
  return run.report.outcome === 'failed' && (run.report.error ?? '').includes(TYPE_CHECK_FAILURE);
}

export async function runMutation(request: MutationRequest): Promise<MutationResult> {
  const preset = PRESETS[request.intensity];
  const batches = planBatches(request.ranges, preset.maxBatches);
  const clock = request.clock ?? realClock;
  const budget = startBudget(request.budgetMs, () => clock.now());
  const configFile = path.join(ensureWorkDir(request.targetRoot), EMPTY_CONFIG_FILE);
  fs.writeFileSync(configFile, '{}\n');
  let checker = decideChecker(request.targetRoot);

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
  let excludedByPreset = 0;
  const excluded = new Set<string>(excludedMutators(preset));
  let dryRunNetMs: number | null = null;

  function record(mutant: WireMutant, status: MutantStatus, statusReason: string | null): void {
    if (status === 'Ignored' && excluded.has(mutant.mutatorName)) {
      excludedByPreset += 1;
      return;
    }
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
      // The failure message of a killed mutant is whichever killing test ran first, so it is not kept.
      statusReason: status === 'Killed' ? null : statusReason,
      coveredBy: [...mutant.coveredBy].sort(),
      killedBy: [...mutant.killedBy].sort(),
      static: mutant.static,
      sourceHash: sourceHash(file),
      scopeKind: range.kind,
    });
  }

  async function runWithinBudget(batch: Batch): Promise<BatchRun> {
    const remainingBatches = batches.length - batch.index;
    const attempt = (): Promise<BatchRun> => {
      const remainingMs = budget.remainingMs();
      return runBatch(batch, {
        request,
        configFile,
        checkerEnabled: checker.enabled,
        shareMs: remainingMs / remainingBatches,
        remainingMs,
      });
    };
    const first = await attempt();
    if (!checker.enabled || !failedTypeCheck(first) || budget.exhausted()) return first;
    checker = {
      ...checker,
      enabled: false,
      reason: `type checker disabled: target does not type-check under chimpd's TypeScript ${checker.typescriptVersion ?? 'copy'}`,
    };
    return attempt();
  }

  for (const batch of batches) {
    const files = batch.files.map((entry) => entry.file);
    if (budget.exhausted()) {
      reports.push({ index: batch.index, files, outcome: 'not-launched', elapsedMs: 0, planned: null, tested: 0, error: null });
      unplannedFiles.push(...files);
      continue;
    }
    const run = await runWithinBudget(batch);
    reports.push(run.report);
    dryRunNetMs = dryRunNetMs === null ? run.dryRunNetMs : dryRunNetMs + (run.dryRunNetMs ?? 0);

    for (const test of run.tests) {
      tests.set(test.id, { id: test.id, name: test.name, file: testFileOf(request.targetRoot, test) });
    }
    if (run.report.planned === null && run.report.outcome !== 'completed') unplannedFiles.push(...files);

    for (const outcome of reclassifyUncovered(resolveOutcomes(run.planned, run.tested), run.coverageReported)) {
      if (outcome.status === 'NotTested') notTested += 1;
      record(outcome.mutant, outcome.status, outcome.statusReason);
    }
  }

  fs.rmSync(configFile, { force: true });
  const staticSkipped = records.filter((mutant) => mutant.static && mutant.status === 'Ignored').length;
  return {
    mutants: records.sort(compareMutants),
    tests: [...tests.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    batches: reports,
    notTested: { reason: 'budget', mutants: notTested, unplannedFiles: unplannedFiles.sort() },
    staticSkipped: { count: staticSkipped, reason: STATIC_REASON },
    outOfScope,
    excludedByPreset,
    checker,
    targetConfigIgnored: findTargetConfig(request.targetRoot),
    strykerVersion: strykerVersion(),
    dryRunNetMs,
  };
}
