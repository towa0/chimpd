import type { BaselineEntry } from '../baseline/index.js';
import { PRESETS, type FaultKind } from '../core/index.js';
import { perFaultRunMs, perMutantMs } from '../timings/index.js';
import {
  exitCodeOf,
  LEVELS,
  type ExitOptions,
  type Finding,
  type IgnoredFinding,
  type Item,
  type PhaseReport,
  type RunResult,
} from '../orchestrator/index.js';

/** Bumped on any change that removes, renames or retypes a field; adding a field keeps the version. */
export const SCHEMA_VERSION = 1;

export interface JsonFinding {
  readonly source: Finding['source'];
  readonly kind: Finding['kind'];
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly functionName: string | null;
  readonly message: string;
  readonly severity: { readonly score: number; readonly level: Finding['severity']['level']; readonly base: number; readonly prior: number };
  readonly mutation: {
    readonly mutatorName: string;
    readonly replacement: string;
    readonly status: string;
    readonly endLine: number;
    readonly endColumn: number;
    readonly coveredBy: readonly string[];
    readonly statement: string | null;
  } | null;
  readonly fault: {
    readonly kind: FaultKind;
    readonly verdict: string;
    readonly path: 'fetch' | 'http';
    readonly tests: readonly string[];
    /** The changed functions that put the faulted calls in scope, as "file function": the site's own function when the call itself changed, else the changed callers a wrapper was reached through. */
    readonly reachedFrom: readonly string[];
    /** Changed functions that also reach the site, but through none of the faulted tests. */
    readonly notFaultedFrom: readonly string[];
  } | null;
}

export interface JsonIgnoredFinding extends JsonFinding {
  readonly ignoredBy: IgnoredFinding['by'];
  readonly ignoreReason: string | null;
}

export type JsonBaselineEntry =
  | {
      readonly source: 'mutation';
      readonly file: string;
      readonly mutator: string;
      readonly replacement: string;
      readonly statement: string;
      readonly reason: string | null;
    }
  | { readonly source: 'fault'; readonly file: string; readonly function: string | null; readonly kind: string; readonly reason: string | null };

export interface JsonBaseline {
  readonly file: string;
  readonly present: boolean;
  readonly entries: number;
  readonly stale: readonly JsonBaselineEntry[];
  readonly notEvaluated: readonly JsonBaselineEntry[];
}

export interface JsonItem {
  readonly source: Item['source'];
  readonly file: string;
  readonly line: number | null;
  readonly reason: string;
  /** The fault kind the item is about; null when it applies to every kind or is not about a fault. */
  readonly faultKind: FaultKind | null;
}

export interface JsonPhase {
  readonly name: PhaseReport['name'];
  readonly status: PhaseReport['status'];
  readonly statusReason: string | null;
  /** The full error of a failed phase, such as its stack; null otherwise. */
  readonly detail: string | null;
  readonly budgetMs: number;
  readonly spentMs: number;
  /** Where the phase's time went; null when the phase did not run or failed before reporting it. */
  readonly timings: JsonMutationTimings | JsonFaultTimings | null;
}

export interface JsonMutationTimings {
  readonly batchesStarted: number;
  /** From launching Stryker to the end of its dry run, over the batches that got that far. */
  readonly strykerStartMs: number;
  readonly dryRunNetMs: number;
  readonly mutantsMs: number;
  readonly mutantsRun: number;
  readonly msPerMutant: number | null;
}

export interface JsonFaultTimings {
  readonly discoveryMs: number | null;
  readonly faultRuns: number;
  readonly faultRunsMs: number;
  readonly msPerFaultRun: number | null;
}

function roundOrNull(value: number | null): number | null {
  return value === null ? null : Math.round(value);
}

function phaseTimings(timings: PhaseReport['timings']): JsonPhase['timings'] {
  if (timings === undefined) return null;
  if ('mutantsRun' in timings) {
    const { batchesStarted, strykerStartMs, dryRunNetMs, mutantsMs, mutantsRun } = timings;
    return { batchesStarted, strykerStartMs, dryRunNetMs, mutantsMs, mutantsRun, msPerMutant: roundOrNull(perMutantMs(timings)) };
  }
  const { discoveryMs, faultRuns, faultRunsMs } = timings;
  return { discoveryMs, faultRuns, faultRunsMs, msPerFaultRun: roundOrNull(perFaultRunMs(timings)) };
}

export interface JsonCoverage {
  readonly checked: { readonly mutants: number; readonly invalidMutants: number; readonly callSites: number };
  /** Mutants that could not run, each with "compile error: " or "runtime error: " and the first error line. */
  readonly invalid: readonly JsonItem[];
  /** True when at least one valid mutant ran, so the invalid mutants are listed but are not a gap and do not make the run partial. */
  readonly invalidExcluded: boolean;
  /** Per file, mutants generated but never tested before the budget ran out; mutants is null for a file never planned. */
  readonly notTested: readonly { readonly file: string; readonly mutants: number | null }[];
  readonly skipped: readonly JsonItem[];
  readonly inconclusive: readonly JsonItem[];
  readonly conflicts: readonly { readonly testFile: string; readonly patched: readonly string[] }[];
}

export interface JsonReport {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly status: RunResult['status'];
  /** Why the run is inconclusive or nothing-checkable; null otherwise. */
  readonly statusReason: string | null;
  readonly exitCode: number;
  /** Whether the exit code was computed with --strict, under which a partial run also exits 2. */
  readonly strict: boolean;
  readonly error: string | null;
  readonly level: RunResult['level'];
  readonly preset: { readonly name: string; readonly budgetMs: number; readonly mutationShare: number };
  readonly budgetMs: number;
  readonly spentMs: number;
  readonly seed: number;
  readonly git: { readonly base: string; readonly mergeBase: string; readonly head: string; readonly dirty: boolean } | null;
  readonly scope: {
    readonly mode: 'diff' | 'test-only';
    readonly changedSourceFiles: readonly string[];
    readonly changedTestFiles: readonly string[];
    readonly boundaryFiles: readonly string[];
    readonly ignoredFiles: readonly { readonly file: string; readonly reason: string }[];
    readonly notes: readonly { readonly file: string; readonly line: number; readonly message: string }[];
  } | null;
  readonly phases: readonly JsonPhase[];
  readonly findings: readonly JsonFinding[];
  /** Findings the baseline or an inline comment set aside; they do not count toward the exit code. */
  readonly ignored: readonly JsonIgnoredFinding[];
  readonly baseline: JsonBaseline | null;
  /** What was checked, and everything in scope that was not, each with its reason. */
  readonly coverage: JsonCoverage;
}

function finding(entry: Finding): JsonFinding {
  const { severity, mutation, fault } = entry;
  return {
    source: entry.source,
    kind: entry.kind,
    file: entry.file,
    line: entry.line,
    column: entry.column,
    functionName: entry.functionName,
    message: entry.message,
    severity: { score: severity.score, level: severity.level, base: severity.base, prior: severity.prior },
    mutation:
      mutation === null
        ? null
        : {
            mutatorName: mutation.mutatorName,
            replacement: mutation.replacement,
            status: mutation.status,
            endLine: mutation.endLine,
            endColumn: mutation.endColumn,
            coveredBy: [...mutation.coveredBy],
            statement: mutation.statement,
          },
    fault:
      fault === null
        ? null
        : {
            kind: fault.kind,
            verdict: fault.verdict,
            path: fault.path,
            tests: [...fault.tests],
            reachedFrom: [...fault.reachedFrom],
            notFaultedFrom: [...fault.notFaultedFrom],
          },
  };
}

function baselineEntry(entry: BaselineEntry): JsonBaselineEntry {
  return entry.source === 'mutation'
    ? {
        source: entry.source,
        file: entry.file,
        mutator: entry.mutator,
        replacement: entry.replacement,
        statement: entry.statement,
        reason: entry.reason,
      }
    : { source: entry.source, file: entry.file, function: entry.function, kind: entry.kind, reason: entry.reason };
}

function item(entry: Item): JsonItem {
  return { source: entry.source, file: entry.file, line: entry.line, reason: entry.reason, faultKind: entry.faultKind ?? null };
}

/** The versioned report, built field by field so that a change to the internal types cannot reshape it unnoticed. */
export function toJsonReport(result: RunResult, options: ExitOptions = {}): JsonReport {
  const preset = PRESETS[LEVELS[result.level]];
  const { git, scope, checked } = result;
  return {
    schemaVersion: SCHEMA_VERSION,
    status: result.status,
    statusReason: result.statusReason,
    exitCode: exitCodeOf(result, options),
    strict: options.strict === true,
    error: result.error,
    level: result.level,
    preset: { name: preset.name, budgetMs: preset.budgetMs, mutationShare: preset.mutationShare },
    budgetMs: Math.round(result.budgetMs),
    spentMs: Math.round(result.spentMs),
    seed: result.seed,
    git: git === null ? null : { base: git.base, mergeBase: git.mergeBase, head: git.head, dirty: git.dirty },
    scope:
      scope === null
        ? null
        : {
            mode: scope.mode,
            changedSourceFiles: [...scope.changedSourceFiles],
            changedTestFiles: [...scope.changedTestFiles],
            boundaryFiles: [...scope.boundaryFiles],
            ignoredFiles: scope.ignoredFiles.map(({ file, reason }) => ({ file, reason })),
            notes: scope.notes.map(({ file, line, message }) => ({ file, line, message })),
          },
    phases: result.phases.map(({ name, status, statusReason, detail, budgetMs, spentMs, timings }) => ({
      name,
      status,
      statusReason,
      detail: detail ?? null,
      budgetMs: Math.round(budgetMs),
      spentMs: Math.round(spentMs),
      timings: phaseTimings(timings),
    })),
    findings: result.findings.map(finding),
    ignored: result.ignored.map((entry) => ({ ...finding(entry.finding), ignoredBy: entry.by, ignoreReason: entry.reason })),
    baseline:
      result.baseline === null
        ? null
        : {
            file: result.baseline.file,
            present: result.baseline.present,
            entries: result.baseline.entries,
            stale: result.baseline.stale.map(baselineEntry),
            notEvaluated: result.baseline.notEvaluated.map(baselineEntry),
          },
    coverage: {
      checked: { mutants: checked.mutants, invalidMutants: checked.invalidMutants, callSites: checked.callSites },
      invalid: result.invalid.map(item),
      invalidExcluded: result.invalidExcluded,
      notTested: result.notTested.map(({ file, mutants }) => ({ file, mutants })),
      skipped: result.skipped.map(item),
      inconclusive: result.inconclusive.map(item),
      conflicts: result.conflicts.map(({ testFile, patched }) => ({ testFile, patched: [...patched] })),
    },
  };
}

export function renderJson(result: RunResult, options: ExitOptions = {}): string {
  return `${JSON.stringify(toJsonReport(result, options), null, 2)}\n`;
}
