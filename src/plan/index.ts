import { randomInt } from 'node:crypto';
import path from 'node:path';
import { loadBaseline, type Baseline } from '../baseline/index.js';
import {
  countLines,
  decideIgnoreStatic,
  isValidSeed,
  MAX_SEED,
  mergeRangesByFile,
  PRESETS,
  rangeForLine,
  seedError,
  toPosix,
  type FaultKind,
  type Preset,
  type ScopeKind,
  type ScopeRange,
} from '../core/index.js';
import { DEFAULT_BASE, findOutgoingCalls, scopeDiff, type DiffScope, type DiffScopeOptions, type OutgoingCallee } from '../diff-scoper/index.js';
import { DEFAULT_TEST_DEADLINE_MS, isRunnableKind } from '../fault-run/index.js';
import {
  checkTarget,
  EXIT_CLEAN,
  EXIT_INCONCLUSIVE,
  LEVELS,
  mutationBudgetMs,
  planScope,
  staticLines,
  TEST_ONLY_NO_FAULTS,
  type GitInfo,
  type Item,
  type Level,
  type RunScope,
} from '../orchestrator/index.js';
import { findVitestConfig, missingConfigMessage } from '../orchestrator/target.js';
import { planBatches } from '../stryker-adapter/index.js';
import { computeBoundary, type Boundary, type BoundaryOptions } from '../test-only-scoper/index.js';
import { countMutants, type MutantCount, type MutantCountRequest } from './mutants.js';

export { countMutants } from './mutants.js';
export type { MutantCount, MutantCountRequest } from './mutants.js';

/** Assumed costs behind the time estimate; none of them is measured. */
export const ASSUMED_STRYKER_START_MS = 10_000;
export const ASSUMED_MS_PER_MUTANT = 500;
export const ASSUMED_DISCOVERY_MS = 10_000;
export const ASSUMED_TEST_MS = 1_000;

export interface PlanDeps {
  readonly scopeDiff: (options: DiffScopeOptions) => Promise<DiffScope>;
  readonly computeBoundary: (options: BoundaryOptions) => Boundary;
  readonly countMutants: (request: MutantCountRequest) => Promise<MutantCount[]>;
  readonly loadBaseline: (targetRoot: string) => Promise<Baseline>;
}

const DEFAULT_DEPS: PlanDeps = { scopeDiff, computeBoundary, countMutants, loadBaseline };

export interface PlanOptions {
  readonly cwd: string;
  readonly level: Level;
  readonly base?: string;
  readonly seed?: number;
  readonly deps?: Partial<PlanDeps>;
}

export interface PlanMutation {
  readonly files: readonly MutantCount[];
  /** null when any file's count is unavailable. */
  readonly total: number | null;
  /** The files of each batch, in the order a run with the same seed would run them. */
  readonly batches: readonly (readonly string[])[];
  readonly ignoreStatic: boolean;
  readonly staticReason: string;
  /** Why the phase would not run; null when it would. */
  readonly notRun: string | null;
}

export interface PlanCall {
  readonly file: string;
  readonly line: number;
  readonly callee: OutgoingCallee;
  readonly scopeKind: ScopeKind;
}

export interface PlanFaults {
  readonly calls: readonly PlanCall[];
  /** The fault kinds a run would use, in the order it would run them. */
  readonly kinds: readonly FaultKind[];
  readonly maxCallSites: number;
  readonly testsPerCallSite: number;
  readonly notRun: string | null;
}

export interface PlanBudget {
  readonly totalMs: number;
  readonly mutationMs: number;
  /** The fault phase also gets whatever the mutation phase leaves unused. */
  readonly faultMs: number;
}

export interface PlanEstimate {
  readonly totalMs: number;
  readonly mutationMs: number;
  readonly faultMs: number;
  /** How each part was derived, assumptions included. */
  readonly derivation: readonly string[];
}

export type PlanStatus = 'planned' | 'nothing-in-scope' | 'error';

export interface RunPlan {
  readonly status: PlanStatus;
  readonly error: string | null;
  readonly level: Level;
  readonly seed: number;
  readonly git: GitInfo | null;
  readonly scope: RunScope | null;
  /** Scope gaps a run would list as not checked, such as boundary files over the cap. */
  readonly scopeItems: readonly Item[];
  /** Repo-relative path of the Vitest config a run would use; null when there is none. */
  readonly vitestConfig: string | null;
  /** Why a run would stop with a tool error after scoping; null when nothing known stops it. */
  readonly runWouldFail: string | null;
  readonly mutation: PlanMutation | null;
  readonly faults: PlanFaults | null;
  readonly budget: PlanBudget;
  readonly estimate: PlanEstimate | null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function firstLine(text: string): string {
  return text.split('\n').find((line) => line.trim() !== '')?.trim() ?? text;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

function linesByFile(ranges: readonly ScopeRange[]): Map<string, number> {
  return new Map([...mergeRangesByFile(ranges)].map(([file, intervals]) => [file, countLines(intervals)]));
}

async function mutantCounts(request: MutantCountRequest, deps: PlanDeps): Promise<MutantCount[]> {
  try {
    return await deps.countMutants(request);
  } catch (error) {
    const reason = `count unavailable: ${firstLine(messageOf(error))}`;
    return [...mergeRangesByFile(request.ranges).keys()].map((file) => ({ file, mutants: null, moduleLevel: null, reason }));
  }
}

function estimateMutation(mutation: PlanMutation, ranges: readonly ScopeRange[], preset: Preset, budgetMs: number): { ms: number; lines: string[] } {
  if (mutation.notRun !== null) return { ms: 0, lines: [`mutation: 0 s, the phase would not run`] };
  const lines = linesByFile(ranges);
  let counted = 0;
  let guessed = 0;
  let guessedFiles = 0;
  for (const entry of mutation.files) {
    if (entry.mutants === null) {
      guessed += (lines.get(entry.file) ?? 0) * preset.estimatedMutantsPerLine;
      guessedFiles += 1;
    } else {
      counted += entry.mutants;
    }
  }
  const batches = mutation.batches.length;
  const rawMs = batches * ASSUMED_STRYKER_START_MS + (counted + guessed) * ASSUMED_MS_PER_MUTANT;
  const ms = Math.min(rawMs, budgetMs);
  const mutants = guessedFiles === 0
    ? plural(counted, 'mutant')
    : `${plural(counted, 'counted mutant')} + ${guessed} guessed for ${plural(guessedFiles, 'file')} without a count, at the preset's ${plural(preset.estimatedMutantsPerLine, 'mutant')} per scoped line`;
  const capped = rawMs > budgetMs ? `, capped at the mutation budget of ${seconds(budgetMs)}` : '';
  return {
    ms,
    lines: [
      `mutation: ${batches} ${batches === 1 ? 'batch' : 'batches'} x ${seconds(ASSUMED_STRYKER_START_MS)} assumed Stryker start and dry run + ${mutants} x ${seconds(ASSUMED_MS_PER_MUTANT)} assumed each = ${seconds(rawMs)}${capped}`,
    ],
  };
}

function estimateFaults(faults: PlanFaults, budgetMs: number): { ms: number; lines: string[] } {
  if (faults.notRun !== null) return { ms: 0, lines: ['faults: 0 s, the phase would not run'] };
  const sites = Math.min(faults.calls.length, faults.maxCallSites);
  const testsMs = faults.testsPerCallSite * ASSUMED_TEST_MS;
  const others = faults.kinds.filter((kind) => kind !== 'blackhole').length;
  const perSiteMs = DEFAULT_TEST_DEADLINE_MS + testsMs + others * testsMs;
  const rawMs = ASSUMED_DISCOVERY_MS + sites * perSiteMs;
  const ms = Math.max(0, Math.min(rawMs, budgetMs));
  const capped = rawMs > budgetMs ? `, capped at the ${seconds(budgetMs)} left` : '';
  const tests = `${plural(faults.testsPerCallSite, 'test')} x ${seconds(ASSUMED_TEST_MS)} assumed`;
  const more = others === 0 ? '' : `, then ${tests} for each of ${others} more fault ${others === 1 ? 'kind' : 'kinds'}`;
  return {
    ms,
    lines: [
      `faults: ${seconds(ASSUMED_DISCOVERY_MS)} assumed discovery run + ${plural(sites, 'call site')} found in the source x (${seconds(DEFAULT_TEST_DEADLINE_MS)} fault deadline + ${tests}${more}) = ${seconds(rawMs)}${capped}`,
      `faults: ${plural(faults.kinds.length, 'fault kind')}, run kind by kind: ${faults.kinds.join(', ')}`,
      'faults: calls through client libraries are only found when a test makes them, so the real count can be higher',
    ],
  };
}

export async function planRun(options: PlanOptions): Promise<RunPlan> {
  const deps: PlanDeps = { ...DEFAULT_DEPS, ...options.deps };
  const { level } = options;
  const intensity = LEVELS[level];
  const preset = PRESETS[intensity];
  const seed = options.seed ?? randomInt(0, MAX_SEED);
  const base = options.base ?? DEFAULT_BASE;
  const targetRoot = path.resolve(options.cwd);
  const empty: RunPlan = {
    status: 'error',
    error: null,
    level,
    seed,
    git: null,
    scope: null,
    scopeItems: [],
    vitestConfig: null,
    runWouldFail: null,
    mutation: null,
    faults: null,
    budget: { totalMs: preset.budgetMs, mutationMs: 0, faultMs: 0 },
    estimate: null,
  };
  if (!isValidSeed(seed)) return { ...empty, error: seedError(seed) };

  let scope: DiffScope;
  try {
    await checkTarget(targetRoot, base);
    scope = await deps.scopeDiff({ repoRoot: targetRoot, mode: preset.scopeMode, base });
  } catch (error) {
    return { ...empty, error: messageOf(error) };
  }
  const git: GitInfo = { base: scope.base, mergeBase: scope.mergeBase, head: scope.head, dirty: scope.dirty };
  let planned: ReturnType<typeof planScope>;
  try {
    planned = planScope(targetRoot, scope, preset, deps, seed);
  } catch (error) {
    return { ...empty, git, error: messageOf(error) };
  }
  let baselineProblem: string | null = null;
  try {
    await deps.loadBaseline(targetRoot);
  } catch (error) {
    baselineProblem = messageOf(error);
  }
  const config = findVitestConfig(targetRoot);
  const found = {
    ...empty,
    git,
    scope: planned.scope,
    scopeItems: planned.scopeItems,
    vitestConfig: config === null ? null : toPosix(path.relative(targetRoot, config)),
  };

  const mutationInScope = planned.mutationRanges.length > 0;
  const faultsInScope = planned.faultRanges.length > 0;
  if (!mutationInScope && !faultsInScope) return { ...found, status: 'nothing-in-scope' };

  const mutationMs = Math.round(mutationBudgetMs({ remainingMs: preset.budgetMs, mutationShare: preset.mutationShare, mutationInScope, faultsInScope }));
  const budget: PlanBudget = { totalMs: preset.budgetMs, mutationMs, faultMs: faultsInScope ? preset.budgetMs - mutationMs : 0 };

  const files = mutationInScope ? await mutantCounts({ targetRoot, ranges: planned.mutationRanges, intensity }, deps) : [];
  const staticDecision = decideIgnoreStatic({ intensity, staticRegionLines: staticLines(planned.mutationRanges), baselineMs: 0, mutationBudgetMs: mutationMs });
  const mutation: PlanMutation = {
    files,
    total: files.some((entry) => entry.mutants === null) ? null : files.reduce((total, entry) => total + (entry.mutants ?? 0), 0),
    batches: planBatches(planned.mutationRanges, preset.maxBatches, seed).map((batch) => batch.files.map((entry) => entry.file)),
    ignoreStatic: staticDecision.ignoreStatic,
    staticReason: staticDecision.reason,
    notRun: mutationInScope
      ? null
      : planned.scope.mode === 'test-only'
        ? 'no source file is reachable from the changed tests'
        : 'no TypeScript source in scope to mutate',
  };

  const calls = faultsInScope
    ? findOutgoingCalls(targetRoot, planned.faultRanges).map((call) => ({
        file: call.file,
        line: call.line,
        callee: call.callee,
        scopeKind: rangeForLine(planned.faultRanges, call.file, call.line)?.kind ?? 'changed',
      }))
    : [];
  const faults: PlanFaults = {
    calls,
    kinds: preset.faultKinds.filter(isRunnableKind),
    maxCallSites: preset.maxFaultedCallSites,
    testsPerCallSite: preset.testsPerCallSite,
    notRun: faultsInScope ? null : planned.scope.mode === 'test-only' ? TEST_ONLY_NO_FAULTS : 'no TypeScript source in scope to fault',
  };

  const mutationEstimate = estimateMutation(mutation, planned.mutationRanges, preset, budget.mutationMs);
  const faultEstimate = estimateFaults(faults, preset.budgetMs - mutationEstimate.ms);
  return {
    ...found,
    status: 'planned',
    runWouldFail: baselineProblem ?? (config === null ? missingConfigMessage(targetRoot) : null),
    mutation,
    faults,
    budget,
    estimate: {
      mutationMs: mutationEstimate.ms,
      faultMs: faultEstimate.ms,
      totalMs: mutationEstimate.ms + faultEstimate.ms,
      derivation: [...mutationEstimate.lines, ...faultEstimate.lines],
    },
  };
}

export function exitCodeOfPlan(plan: RunPlan): number {
  return plan.status === 'error' ? EXIT_INCONCLUSIVE : EXIT_CLEAN;
}
