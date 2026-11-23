import type { BaselineEntry } from '../baseline/index.js';
import { PRESETS, type FaultKind } from '../core/index.js';
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
}

export interface JsonCoverage {
  readonly checked: { readonly mutants: number; readonly invalidMutants: number; readonly callSites: number };
  /** Mutants that could not run, each with "compile error: " or "runtime error: " and the first error line. */
  readonly invalid: readonly JsonItem[];
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
    fault: fault === null ? null : { kind: fault.kind, verdict: fault.verdict, path: fault.path, tests: [...fault.tests] },
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
    phases: result.phases.map(({ name, status, statusReason, detail, budgetMs, spentMs }) => ({
      name,
      status,
      statusReason,
      detail: detail ?? null,
      budgetMs: Math.round(budgetMs),
      spentMs: Math.round(spentMs),
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
      skipped: result.skipped.map(item),
      inconclusive: result.inconclusive.map(item),
      conflicts: result.conflicts.map(({ testFile, patched }) => ({ testFile, patched: [...patched] })),
    },
  };
}

export function renderJson(result: RunResult, options: ExitOptions = {}): string {
  return `${JSON.stringify(toJsonReport(result, options), null, 2)}\n`;
}
