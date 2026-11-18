import { randomInt } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  countLines,
  decideIgnoreStatic,
  git,
  mergeRangesByFile,
  PRESETS,
  realNow,
  resolveSha,
  startBudget,
  type Preset,
  type ScopeRange,
} from '../core/index.js';
import { DEFAULT_BASE, scopeDiff, type DiffScope, type DiffScopeOptions } from '../diff-scoper/index.js';
import { runFaults, type FaultRunRequest, type FaultRunResult } from '../fault-run/index.js';
import { runMutation, type MutationRequest, type MutationResult } from '../stryker-adapter/index.js';
import {
  boundaryRanges,
  computeBoundary,
  summarizeTestOnly,
  type Boundary,
  type BoundaryOptions,
} from '../test-only-scoper/index.js';
import { mutationBudgetMs } from './budget.js';
import { faultItems, mutationItems, type PhaseItems } from './findings.js';
import {
  ChimpdError,
  findVitestConfig,
  loadTargetVitest,
  missingConfigMessage,
  type TargetVitest,
} from './target.js';
import {
  LEVELS,
  type Finding,
  type GitInfo,
  type Item,
  type Level,
  type PhaseReport,
  type PhaseStatus,
  type RunResult,
  type RunScope,
} from './types.js';

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
}

const DEFAULT_DEPS: OrchestratorDeps = { scopeDiff, computeBoundary, runMutation, runFaults, loadVitest: loadTargetVitest };

export interface RunOptions {
  readonly cwd: string;
  readonly level: Level;
  readonly base?: string;
  readonly seed?: number;
  readonly now?: () => number;
  readonly deps?: Partial<OrchestratorDeps>;
}

const MAX_SEED = 2 ** 31 - 1;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function checkTarget(cwd: string, base: string): Promise<void> {
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

function staticLines(ranges: readonly ScopeRange[]): number {
  const merged = mergeRangesByFile(ranges.filter((range) => range.staticRegion));
  return [...merged.values()].reduce((total, intervals) => total + countLines(intervals), 0);
}

function mutationPhaseStatus(result: MutationResult): { status: PhaseStatus; reason: string | null } {
  const failed = result.batches.find((batch) => batch.outcome === 'failed');
  if (failed !== undefined) {
    return { status: 'error', reason: `mutation batch ${failed.index} failed: ${failed.error ?? 'no error reported'}` };
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

interface Plan {
  readonly scope: RunScope;
  readonly mutationRanges: readonly ScopeRange[];
  readonly faultRanges: readonly ScopeRange[];
  readonly changedTestFiles: readonly string[] | null;
  readonly scopeItems: readonly Item[];
}

function planScope(targetRoot: string, scope: DiffScope, preset: Preset, deps: OrchestratorDeps): Plan {
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

  let gitInfo: GitInfo | null = null;
  let runScope: RunScope | null = null;
  const result = (partial: Pick<RunResult, 'status' | 'error'> & Partial<RunResult>): RunResult => ({
    level,
    budgetMs: preset.budgetMs,
    seed,
    git: gitInfo,
    scope: runScope,
    phases: [],
    findings: [],
    skipped: [],
    inconclusive: [],
    conflicts: [],
    ...partial,
    spentMs: Math.round(budget.spentMs()),
  });
  const failed = (error: unknown): RunResult => result({ status: 'error', error: messageOf(error) });

  let plan: Plan;
  try {
    await checkTarget(targetRoot, base);
    const scope = await deps.scopeDiff({ repoRoot: targetRoot, mode: preset.scopeMode, base });
    gitInfo = { base: scope.base, mergeBase: scope.mergeBase, head: scope.head, dirty: scope.dirty };
    plan = planScope(targetRoot, scope, preset, deps);
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
    });
  }

  let configFile: string;
  let vitest: TargetVitest | null = null;
  try {
    const found = findVitestConfig(targetRoot);
    if (found === null) throw new ChimpdError(missingConfigMessage(targetRoot));
    configFile = found;
    if (faultsInScope) vitest = await deps.loadVitest(targetRoot);
  } catch (error) {
    return failed(error);
  }

  const phases: PhaseReport[] = [];
  const collected: PhaseItems[] = [{ findings: [], skipped: plan.scopeItems, inconclusive: [] }];
  const conflicts: FaultRunResult['conflicts'][number][] = [];

  const mutationMs = mutationBudgetMs({
    remainingMs: budget.remainingMs(),
    mutationShare: preset.mutationShare,
    mutationInScope,
    faultsInScope,
  });
  if (!mutationInScope) {
    const reason =
      plan.scope.mode === 'test-only'
        ? 'no source file is reachable from the changed tests'
        : 'no TypeScript source in scope to mutate';
    phases.push({ name: 'mutation', status: 'not-run', statusReason: reason, budgetMs: 0, spentMs: 0 });
  } else {
    const startedAt = now();
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
      });
      const { status, reason } = mutationPhaseStatus(mutation);
      phases.push({ name: 'mutation', status, statusReason: reason, budgetMs: mutationMs, spentMs: Math.round(now() - startedAt) });
      if (plan.changedTestFiles === null) {
        collected.push(mutationItems(mutation, mutation.mutants, null));
      } else {
        const report = summarizeTestOnly(mutation.mutants, mutation.tests, plan.changedTestFiles);
        collected.push(mutationItems(mutation, report.mutants, report.coveredNotKilled));
      }
    } catch (error) {
      phases.push({
        name: 'mutation',
        status: 'error',
        statusReason: messageOf(error),
        budgetMs: mutationMs,
        spentMs: Math.round(now() - startedAt),
      });
    }
  }

  if (!faultsInScope || vitest === null) {
    const reason =
      plan.scope.mode === 'test-only'
        ? 'only test files changed; the fault phase faults calls made from changed source code'
        : 'no TypeScript source in scope to fault';
    phases.push({ name: 'faults', status: 'not-run', statusReason: reason, budgetMs: 0, spentMs: 0 });
  } else {
    const faultMs = budget.remainingMs();
    const startedAt = now();
    if (faultMs <= 0) {
      phases.push({
        name: 'faults',
        status: 'budget-exhausted',
        statusReason: 'no budget was left for the fault phase',
        budgetMs: 0,
        spentMs: 0,
      });
      collected.push({
        findings: [],
        skipped: scopedFiles(plan.faultRanges).map((file) => ({
          source: 'fault',
          file,
          line: null,
          reason: 'not faulted: no budget was left for the fault phase',
        })),
        inconclusive: [],
      });
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
        });
        phases.push({
          name: 'faults',
          status: faults.status,
          statusReason: faults.statusReason,
          budgetMs: faultMs,
          spentMs: Math.round(now() - startedAt),
        });
        conflicts.push(...faults.conflicts);
        collected.push(faultItems(faults, preset));
      } catch (error) {
        phases.push({
          name: 'faults',
          status: 'error',
          statusReason: messageOf(error),
          budgetMs: faultMs,
          spentMs: Math.round(now() - startedAt),
        });
      }
    }
  }

  const findings = collected.flatMap((items) => items.findings).sort(bySeverity);
  const skipped = collected.flatMap((items) => items.skipped).sort(byLocation);
  const inconclusive = collected.flatMap((items) => items.inconclusive).sort(byLocation);
  // Calls made under a conflicting test file are never faulted, so a conflict is missing evidence too.
  const incomplete =
    phases.some((phase) => phase.status !== 'completed' && phase.status !== 'not-run') ||
    skipped.length > 0 ||
    inconclusive.length > 0 ||
    conflicts.length > 0;
  return result({
    status: incomplete ? 'incomplete' : 'completed',
    error: null,
    phases,
    findings,
    skipped,
    inconclusive,
    conflicts,
  });
}

export const EXIT_CLEAN = 0;
export const EXIT_FINDINGS = 1;
export const EXIT_INCONCLUSIVE = 2;

/** An incomplete run exits 2 even with findings, so a partial result is never read as the whole story. */
export function exitCodeOf(result: RunResult): number {
  if (result.status === 'error' || result.status === 'incomplete') return EXIT_INCONCLUSIVE;
  return result.findings.length > 0 ? EXIT_FINDINGS : EXIT_CLEAN;
}
