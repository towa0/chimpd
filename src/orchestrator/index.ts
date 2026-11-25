import { randomInt } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  countLines,
  decideIgnoreStatic,
  firstErrorLine,
  git,
  isValidSeed,
  MAX_SEED,
  mergeRangesByFile,
  PRESETS,
  realNow,
  resolveSha,
  seedError,
  startBudget,
  type Preset,
  type MutantRecord,
  type ScopeRange,
} from '../core/index.js';
import { applyIgnores, BASELINE_FILE, loadBaseline, type Baseline } from '../baseline/index.js';
import { DEFAULT_BASE, findOutgoingCalls, scopeDiff, type DiffScope, type DiffScopeOptions } from '../diff-scoper/index.js';
import { runFaults, type CallSiteResult, type FaultRunRequest, type FaultRunResult } from '../fault-run/index.js';
import { runMutation, type MutationRequest, type MutationResult } from '../stryker-adapter/index.js';
import type { ProgressListener } from '../progress/events.js';
import { recordTimings, type FaultTimings, type MutationTimings, type RunTimings } from '../timings/index.js';
import {
  boundaryRanges,
  computeBoundary,
  summarizeTestOnly,
  type Boundary,
  type BoundaryOptions,
} from '../test-only-scoper/index.js';
import { mutationBudgetMs } from './budget.js';
import { faultItems, mutationItems, notTestedFiles, NOTHING_CHECKED, SUITE_FAILS, tallyOf, type PhaseItems } from './findings.js';
import {
  ChimpdError,
  findVitestConfig,
  loadTargetVitest,
  missingConfigMessage,
  type TargetVitest,
} from './target.js';
import {
  LEVELS,
  type Checked,
  type Finding,
  type GitInfo,
  type Item,
  type Level,
  type NotTestedFile,
  type PhaseReport,
  type PhaseStatus,
  type RunResult,
  type RunScope,
  type RunStatus,
} from './types.js';
import { discoveryFinished, unreachedCalls } from './unreached.js';

export { mutationBudgetMs } from './budget.js';
export type { BudgetSplitInput } from './budget.js';
export { ChimpdError, findVitestConfig, isSupportedVitest, loadTargetVitest, SUPPORTED_VITEST } from './target.js';
export type { TargetVitest } from './target.js';
export * from './types.js';

export interface OrchestratorDeps {
  readonly scopeDiff: (options: DiffScopeOptions) => Promise<DiffScope>;
  readonly computeBoundary: (options: BoundaryOptions) => Boundary;
  readonly runMutation: (request: MutationRequest) => Promise<MutationResult>;
  readonly runFaults: (request: FaultRunRequest) => Promise<FaultRunResult>;
  readonly loadVitest: (targetRoot: string) => Promise<TargetVitest>;
  readonly loadBaseline: (targetRoot: string) => Promise<Baseline>;
  readonly recordTimings: (targetRoot: string, run: RunTimings) => void;
}

const DEFAULT_DEPS: OrchestratorDeps = {
  scopeDiff,
  computeBoundary,
  runMutation,
  runFaults,
  loadVitest: loadTargetVitest,
  loadBaseline,
  recordTimings,
};

export interface RunOptions {
  readonly cwd: string;
  readonly level: Level;
  readonly base?: string;
  readonly seed?: number;
  readonly now?: () => number;
  readonly deps?: Partial<OrchestratorDeps>;
  /** Receives what the target's own tests write to stdout and stderr in either phase; discarded without one. */
  readonly onTargetOutput?: (text: string) => void;
  /** Hears each phase start and end, and each mutant and faulted run that finishes. */
  readonly onProgress?: ProgressListener;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function reasonOf(error: unknown): string {
  return firstErrorLine(messageOf(error)) ?? 'no error reported';
}

function detailOf(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

export async function checkTarget(cwd: string, base: string): Promise<void> {
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new ChimpdError(`${cwd} is not a directory`);
  try {
    await git(cwd, ['rev-parse', '--is-inside-work-tree']);
  } catch {
    throw new ChimpdError(`${cwd} is not inside a git repository`);
  }
  try {
    await resolveSha(cwd, base);
  } catch {
    throw new ChimpdError(`base ref '${base}' does not resolve to a commit in ${cwd}; fetch it or pass --base <ref>`);
  }
}

/** The reason a completed fault phase carries when the changed code made no outgoing call at all. */
export const NO_OUTGOING_CALL = 'the changed code reached no outgoing call in the tests related to it, directly or through other code';

export const TEST_ONLY_NO_FAULTS = 'only test files changed; the fault phase faults calls made from changed source code';

export function staticLines(ranges: readonly ScopeRange[]): number {
  const merged = mergeRangesByFile(ranges.filter((range) => range.staticRegion));
  return [...merged.values()].reduce((total, intervals) => total + countLines(intervals), 0);
}

function mutationPhaseStatus(result: MutationResult): { status: PhaseStatus; reason: string | null; detail?: string } {
  const red = result.batches.find((batch) => batch.outcome === 'dry-run-failed');
  if (red !== undefined) {
    const detail = firstErrorLine(red.error);
    return { status: 'inconclusive', reason: detail === null ? SUITE_FAILS : `${SUITE_FAILS}: ${detail}` };
  }
  const failed = result.batches.find((batch) => batch.outcome === 'failed');
  if (failed !== undefined) {
    const reason = `mutation batch ${failed.index} failed: ${firstErrorLine(failed.error) ?? 'no error reported'}`;
    return failed.error === null ? { status: 'error', reason } : { status: 'error', reason, detail: failed.error };
  }
  if (result.batches.some((batch) => batch.outcome === 'killed-over-share')) {
    return { status: 'budget-exhausted', reason: 'a mutation batch was stopped at twice its share of the budget' };
  }
  const outOfBudget =
    result.batches.some((batch) => batch.outcome === 'killed-budget' || batch.outcome === 'not-launched') ||
    result.notTested.mutants > 0 ||
    result.notTested.unplannedFiles.length > 0;
  if (outOfBudget) return { status: 'budget-exhausted', reason: 'the budget ran out before every mutant was tested' };
  return { status: 'completed', reason: null };
}

function scopedFiles(ranges: readonly ScopeRange[]): string[] {
  return [...new Set(ranges.map((range) => range.file))].sort();
}

const EMPTY_TALLY = { killed: 0, survived: 0, faults: [] };

const EMPTY_ITEMS: PhaseItems = { checked: NOTHING_CHECKED, findings: [], invalid: [], skipped: [], inconclusive: [] };

/** A phase that produced no per-item results still leaves every file it was given listed as not checked. */
function filesNotChecked(source: Item['source'], ranges: readonly ScopeRange[], reason: string): PhaseItems {
  return {
    checked: NOTHING_CHECKED,
    findings: [],
    invalid: [],
    skipped: scopedFiles(ranges).map((file) => ({ source, file, line: null, reason })),
    inconclusive: [],
  };
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function bySeverity(a: Finding, b: Finding): number {
  return (
    b.severity.score - a.severity.score ||
    compareText(a.file, b.file) ||
    a.line - b.line ||
    a.column - b.column ||
    compareText(a.source, b.source) ||
    compareText(a.message, b.message)
  );
}

function byLocation(a: Item, b: Item): number {
  return (
    compareText(a.file, b.file) ||
    (a.line ?? 0) - (b.line ?? 0) ||
    compareText(a.source, b.source) ||
    compareText(a.reason, b.reason)
  );
}

/** What a run checks: the scope, and the ranges each phase is given. */
export interface ScopePlan {
  readonly scope: RunScope;
  readonly mutationRanges: readonly ScopeRange[];
  readonly faultRanges: readonly ScopeRange[];
  readonly changedTestFiles: readonly string[] | null;
  readonly scopeItems: readonly Item[];
}

export function planScope(
  targetRoot: string,
  scope: DiffScope,
  preset: Preset,
  deps: Pick<OrchestratorDeps, 'computeBoundary'>,
  seed: number,
): ScopePlan {
  const base = {
    changedSourceFiles: scope.changedSourceFiles,
    changedTestFiles: scope.changedTestFiles,
    ignoredFiles: scope.ignoredFiles,
    notes: scope.notes,
  };
  const testOnly = scope.changedSourceFiles.length === 0 && scope.changedTestFiles.length > 0;
  if (!testOnly) {
    return {
      scope: { ...base, mode: 'diff', boundaryFiles: [] },
      mutationRanges: scope.ranges,
      faultRanges: scope.ranges,
      changedTestFiles: null,
      scopeItems: [],
    };
  }
  const boundary = deps.computeBoundary({
    targetRoot,
    changedTestFiles: scope.changedTestFiles,
    depth: preset.testOnlyDepth,
    fileCap: preset.testOnlyFileCap,
    seed,
  });
  const scopeItems: Item[] =
    boundary.truncated > 0
      ? [
          {
            source: 'mutation',
            file: boundary.sourceRoot,
            line: null,
            reason: `${boundary.truncated} more source files reachable from the changed tests are over the preset cap of ${preset.testOnlyFileCap}`,
          },
        ]
      : [];
  return {
    scope: { ...base, mode: 'test-only', boundaryFiles: boundary.files.map(({ file }) => file) },
    mutationRanges: boundaryRanges(targetRoot, boundary),
    faultRanges: [],
    changedTestFiles: scope.changedTestFiles,
    scopeItems,
  };
}

export async function runChimpd(options: RunOptions): Promise<RunResult> {
  const deps: OrchestratorDeps = { ...DEFAULT_DEPS, ...options.deps };
  const { level } = options;
  const intensity = LEVELS[level];
  const preset = PRESETS[intensity];
  const now = options.now ?? realNow;
  const budget = startBudget(preset.budgetMs, now);
  const seed = options.seed ?? randomInt(0, MAX_SEED);
  const base = options.base ?? DEFAULT_BASE;
  const targetRoot = path.resolve(options.cwd);
  const output = {
    ...(options.onTargetOutput === undefined ? {} : { onTargetOutput: options.onTargetOutput }),
    ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
  };

  let gitInfo: GitInfo | null = null;
  let runScope: RunScope | null = null;
  const result = (partial: Pick<RunResult, 'status' | 'error'> & Partial<RunResult>): RunResult => ({
    level,
    statusReason: null,
    budgetMs: preset.budgetMs,
    seed,
    git: gitInfo,
    scope: runScope,
    phases: [],
    checked: NOTHING_CHECKED,
    findings: [],
    invalid: [],
    invalidExcluded: false,
    tally: EMPTY_TALLY,
    notTested: [],
    skipped: [],
    inconclusive: [],
    conflicts: [],
    ignored: [],
    baseline: null,
    ...partial,
    spentMs: Math.round(budget.spentMs()),
  });
  const failed = (error: unknown): RunResult => result({ status: 'error', error: messageOf(error) });

  if (!isValidSeed(seed)) return failed(seedError(seed));

  let plan: ScopePlan;
  let baseline: Baseline;
  try {
    await checkTarget(targetRoot, base);
    // A baseline that cannot be read would silently stop ignoring what it lists, so it ends the run first.
    baseline = await deps.loadBaseline(targetRoot);
    const scope = await deps.scopeDiff({ repoRoot: targetRoot, mode: preset.scopeMode, base });
    gitInfo = { base: scope.base, mergeBase: scope.mergeBase, head: scope.head, dirty: scope.dirty };
    plan = planScope(targetRoot, scope, preset, deps, seed);
    runScope = plan.scope;
  } catch (error) {
    return failed(error);
  }

  const mutationInScope = plan.mutationRanges.length > 0;
  const faultsInScope = plan.faultRanges.length > 0;
  if (!mutationInScope && !faultsInScope) {
    const reason = 'no TypeScript source in scope';
    return result({
      status: 'nothing-in-scope',
      error: null,
      phases: [
        { name: 'mutation', status: 'not-run', statusReason: reason, budgetMs: 0, spentMs: 0 },
        { name: 'faults', status: 'not-run', statusReason: reason, budgetMs: 0, spentMs: 0 },
      ],
      skipped: plan.scopeItems,
      baseline: { file: BASELINE_FILE, present: baseline.present, entries: baseline.entries.length, stale: [], notEvaluated: [] },
    });
  }

  let configFile: string;
  let vitest: TargetVitest | null = null;
  try {
    const found = findVitestConfig(targetRoot);
    if (found === null) throw new ChimpdError(missingConfigMessage(targetRoot));
    configFile = found;
    // Loading the target's Vitest also checks its version, which the mutation phase depends on as well.
    vitest = await deps.loadVitest(targetRoot);
  } catch (error) {
    return failed(error);
  }

  const phases: PhaseReport[] = [];
  const endPhase = (report: PhaseReport): void => {
    phases.push(report);
    options.onProgress?.({ type: 'phase-end', phase: report.name, status: report.status, spentMs: report.spentMs, at: now() });
  };
  const collected: PhaseItems[] = [{ checked: NOTHING_CHECKED, findings: [], invalid: [], skipped: plan.scopeItems, inconclusive: [] }];
  const conflicts: FaultRunResult['conflicts'][number][] = [];
  const considered: MutantRecord[] = [];
  const faulted: CallSiteResult[] = [];
  const notTested: NotTestedFile[] = [];
  let mutationTimings: MutationTimings | null = null;
  let faultTimings: FaultTimings | null = null;

  const mutationMs = Math.round(mutationBudgetMs({
    remainingMs: budget.remainingMs(),
    mutationShare: preset.mutationShare,
    mutationInScope,
    faultsInScope,
  }));
  if (!mutationInScope) {
    const reason =
      plan.scope.mode === 'test-only'
        ? 'no source file is reachable from the changed tests'
        : 'no TypeScript source in scope to mutate';
    phases.push({ name: 'mutation', status: 'not-run', statusReason: reason, budgetMs: 0, spentMs: 0 });
  } else {
    const startedAt = now();
    options.onProgress?.({ type: 'phase-start', phase: 'mutation', budgetMs: mutationMs, at: startedAt });
    try {
      const mutation = await deps.runMutation({
        targetRoot,
        ranges: plan.mutationRanges,
        intensity,
        // The test baseline is only known after Stryker's dry run, so the preset and the line limit decide.
        ignoreStatic: decideIgnoreStatic({
          intensity,
          staticRegionLines: staticLines(plan.mutationRanges),
          baselineMs: 0,
          mutationBudgetMs: mutationMs,
        }).ignoreStatic,
        budgetMs: mutationMs,
        seed,
        ...output,
      });
      const { status, reason, detail } = mutationPhaseStatus(mutation);
      endPhase({
        name: 'mutation',
        status,
        statusReason: reason,
        ...(detail === undefined ? {} : { detail }),
        budgetMs: mutationMs,
        spentMs: Math.round(now() - startedAt),
        timings: mutation.timings,
      });
      mutationTimings = mutation.timings;
      if (plan.changedTestFiles === null) {
        considered.push(...mutation.mutants);
        notTested.push(...notTestedFiles(mutation, mutation.mutants));
        collected.push(mutationItems(mutation, mutation.mutants, null));
      } else {
        const report = summarizeTestOnly(mutation.mutants, mutation.tests, plan.changedTestFiles);
        considered.push(...report.mutants);
        notTested.push(...notTestedFiles(mutation, report.mutants));
        collected.push(mutationItems(mutation, report.mutants, report.coveredNotKilled));
      }
    } catch (error) {
      endPhase({
        name: 'mutation',
        status: 'error',
        statusReason: reasonOf(error),
        detail: detailOf(error),
        budgetMs: mutationMs,
        spentMs: Math.round(now() - startedAt),
      });
      collected.push(filesNotChecked('mutation', plan.mutationRanges, `not mutated: the mutation phase failed: ${reasonOf(error)}`));
    }
  }

  if (!faultsInScope || vitest === null) {
    const reason = plan.scope.mode === 'test-only' ? TEST_ONLY_NO_FAULTS : 'no TypeScript source in scope to fault';
    phases.push({ name: 'faults', status: 'not-run', statusReason: reason, budgetMs: 0, spentMs: 0 });
  } else {
    const faultMs = Math.round(budget.remainingMs());
    const startedAt = now();
    options.onProgress?.({ type: 'phase-start', phase: 'faults', budgetMs: Math.max(0, faultMs), at: startedAt });
    if (faultMs <= 0) {
      endPhase({
        name: 'faults',
        status: 'budget-exhausted',
        statusReason: 'no budget was left for the fault phase',
        budgetMs: 0,
        spentMs: 0,
      });
      collected.push(filesNotChecked('fault', plan.faultRanges, 'not faulted: no budget was left for the fault phase'));
    } else {
      try {
        const faults = await deps.runFaults({
          targetRoot,
          configFile,
          ranges: plan.faultRanges,
          intensity,
          budgetMs: faultMs,
          vitestNode: vitest.node,
          now,
          seed,
          ...output,
        });
        const spentMs = Math.round(now() - startedAt);
        const unreached = discoveryFinished(faults)
          ? unreachedCalls(findOutgoingCalls(targetRoot, plan.faultRanges), faults, plan.faultRanges)
          : [];
        const reachedNothing =
          faults.status === 'completed' &&
          faults.results.length + faults.skipped.length + faults.conflicts.length + unreached.length === 0;
        endPhase({
          name: 'faults',
          status: faults.status,
          statusReason: reachedNothing ? NO_OUTGOING_CALL : faults.statusReason,
          budgetMs: faultMs,
          spentMs,
          timings: faults.timings,
        });
        faultTimings = faults.timings;
        conflicts.push(...faults.conflicts);
        faulted.push(...faults.results);
        collected.push(faultItems(faults, preset));
        collected.push({ ...EMPTY_ITEMS, skipped: unreached });
        if (faults.status !== 'completed' && faults.results.length === 0 && faults.skipped.length === 0) {
          collected.push(filesNotChecked('fault', plan.faultRanges, `not faulted: ${faults.statusReason ?? faults.status}`));
        }
      } catch (error) {
        endPhase({
          name: 'faults',
          status: 'error',
          statusReason: reasonOf(error),
          detail: detailOf(error),
          budgetMs: faultMs,
          spentMs: Math.round(now() - startedAt),
        });
        collected.push(filesNotChecked('fault', plan.faultRanges, `not faulted: the fault phase failed: ${reasonOf(error)}`));
      }
    }
  }

  if (mutationTimings !== null || faultTimings !== null) {
    deps.recordTimings(targetRoot, { at: new Date().toISOString(), level, mutation: mutationTimings, faults: faultTimings });
  }

  const ignores = applyIgnores({
    targetRoot,
    baseline,
    findings: collected.flatMap((items) => items.findings),
    mutants: considered,
    mutationRanges: plan.mutationRanges,
    faultRanges: plan.faultRanges,
    faulted,
  });
  const findings = [...ignores.findings].sort(bySeverity);
  const invalid = collected.flatMap((items) => items.invalid).sort(byLocation);
  const skipped = collected.flatMap((items) => items.skipped).sort(byLocation);
  const inconclusive = collected.flatMap((items) => items.inconclusive).sort(byLocation);
  const checked = collected.reduce<Checked>(
    (total, items) => ({
      mutants: total.mutants + items.checked.mutants,
      invalidMutants: total.invalidMutants + items.checked.invalidMutants,
      callSites: total.callSites + items.checked.callSites,
    }),
    NOTHING_CHECKED,
  );
  const { status, statusReason, invalidExcluded } = runStatus({ phases, checked, findings, invalid, skipped, inconclusive, conflicts }, plan.scope.mode);
  return result({
    status,
    statusReason,
    error: null,
    phases,
    checked,
    findings,
    invalid,
    invalidExcluded,
    tally: tallyOf(considered, faulted),
    notTested,
    skipped,
    inconclusive,
    conflicts,
    ignored: ignores.ignored.toSorted((a, b) => bySeverity(a.finding, b.finding)),
    baseline: {
      file: BASELINE_FILE,
      present: baseline.present,
      entries: baseline.entries.length,
      stale: ignores.stale,
      notEvaluated: ignores.notEvaluated,
    },
  });
}

interface Outcome {
  readonly phases: readonly PhaseReport[];
  readonly checked: Checked;
  readonly findings: readonly Finding[];
  readonly invalid: readonly Item[];
  readonly skipped: readonly Item[];
  readonly inconclusive: readonly Item[];
  readonly conflicts: readonly unknown[];
}

interface Status {
  readonly status: RunStatus;
  readonly statusReason: string | null;
  readonly invalidExcluded: boolean;
}

function runStatus(outcome: Outcome, mode: RunScope['mode']): Status {
  const invalidExcluded = outcome.invalid.length > 0 && outcome.checked.mutants > 0;
  const failedPhase = outcome.phases.find((phase) => phase.status === 'error');
  if (failedPhase !== undefined) return { status: 'inconclusive', statusReason: `the ${failedPhase.name} phase failed`, invalidExcluded };
  const unfinishedPhase = outcome.phases.some((phase) => phase.status !== 'completed' && phase.status !== 'not-run');
  const listedGaps = outcome.skipped.length + outcome.inconclusive.length + outcome.conflicts.length;
  // Calls made under a conflicting test file are never faulted, so they are a gap. Invalid mutants are one only
  // when no valid mutant ran, since then the mutation phase verified nothing.
  const gaps = unfinishedPhase || listedGaps > 0 || (outcome.invalid.length > 0 && !invalidExcluded);
  const nothingChecked = outcome.checked.mutants + outcome.checked.callSites === 0 && outcome.findings.length === 0;
  if (gaps && nothingChecked) {
    const onlyInvalid = !unfinishedPhase && listedGaps === 0;
    const statusReason = onlyInvalid ? 'no mutant in scope could run' : 'nothing in scope could be checked';
    return { status: 'inconclusive', statusReason, invalidExcluded };
  }
  if (gaps) return { status: 'partial', statusReason: null, invalidExcluded };
  if (nothingChecked) {
    const statusReason =
      mode === 'test-only'
        ? 'the source the changed tests reach produces no mutants at this level'
        : 'the changed code produces no mutants at this level and makes no outgoing calls';
    return { status: 'nothing-checkable', statusReason, invalidExcluded };
  }
  return { status: 'completed', statusReason: null, invalidExcluded };
}

export const EXIT_CLEAN = 0;
export const EXIT_FINDINGS = 1;
export const EXIT_INCONCLUSIVE = 2;

export interface ExitOptions {
  /** A partial run exits 2 as well, so that any gap in coverage fails the check. */
  readonly strict?: boolean;
}

export function exitCodeOf(result: RunResult, options: ExitOptions = {}): number {
  if (result.status === 'error' || result.status === 'inconclusive') return EXIT_INCONCLUSIVE;
  if ((result.status === 'partial' || result.status === 'nothing-checkable') && options.strict === true) return EXIT_INCONCLUSIVE;
  return result.findings.length > 0 ? EXIT_FINDINGS : EXIT_CLEAN;
}
