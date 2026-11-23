import type { BaselineEntry } from '../baseline/file.js';
import type { BlackHoleVerdictKind, Intensity, MutantStatus } from '../core/index.js';
import type { IgnoredFile, ScopeNote } from '../diff-scoper/index.js';
import type { FileConflict } from '../fault-run/index.js';
import type { FindingKind, Severity } from '../severity/index.js';

export type Level = 'poke' | 'prod' | 'shake';

export const LEVELS: Readonly<Record<Level, Intensity>> = { poke: 1, prod: 2, shake: 3 };

export type PhaseName = 'mutation' | 'faults';

/** not-run means the phase had nothing in scope; every other status other than completed leaves evidence missing. */
export type PhaseStatus = 'completed' | 'budget-exhausted' | 'inconclusive' | 'error' | 'not-run';

export interface PhaseReport {
  readonly name: PhaseName;
  readonly status: PhaseStatus;
  readonly statusReason: string | null;
  /** The full error of a failed phase, such as its stack; the reason holds its first line. */
  readonly detail?: string;
  readonly budgetMs: number;
  readonly spentMs: number;
}

export type FindingSource = 'mutation' | 'fault';

export interface MutationDetail {
  readonly mutatorName: string;
  readonly replacement: string;
  readonly status: MutantStatus;
  readonly endLine: number;
  readonly endColumn: number;
  readonly coveredBy: readonly string[];
  /** Hash of the normalized source of the innermost statement around the mutant; null when none was found. */
  readonly statement: string | null;
}

export interface FaultDetail {
  readonly verdict: BlackHoleVerdictKind;
  readonly path: 'fetch' | 'http';
  readonly tests: readonly string[];
}

export interface Finding {
  readonly source: FindingSource;
  readonly kind: FindingKind;
  /** Repo-relative path with forward slashes. */
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly functionName: string | null;
  readonly message: string;
  readonly severity: Severity;
  readonly mutation: MutationDetail | null;
  readonly fault: FaultDetail | null;
}

/** Something in scope that produced no verdict, with the reason. */
export interface Item {
  readonly source: FindingSource;
  readonly file: string;
  /** null when the item is a whole file, such as one whose mutants were never planned. */
  readonly line: number | null;
  readonly reason: string;
}

export type ScopeModeName = 'diff' | 'test-only';

export interface RunScope {
  readonly mode: ScopeModeName;
  readonly changedSourceFiles: readonly string[];
  readonly changedTestFiles: readonly string[];
  readonly ignoredFiles: readonly IgnoredFile[];
  readonly notes: readonly ScopeNote[];
  /** Source files mutated because a changed test reaches them; empty outside test-only mode. */
  readonly boundaryFiles: readonly string[];
}

export interface GitInfo {
  readonly base: string;
  readonly mergeBase: string;
  readonly head: string;
  readonly dirty: boolean;
}

/**
 * completed: everything in scope was checked. partial: something in scope was not checked, but the
 * run still checked something. inconclusive: a phase failed, or nothing in scope could be checked.
 * nothing-checkable: source was in scope, but it produced no mutant and makes no outgoing call.
 */
export type RunStatus = 'completed' | 'partial' | 'inconclusive' | 'nothing-checkable' | 'nothing-in-scope' | 'error';

export interface Checked {
  /** Mutants that got a verdict: killed, survived, uncovered or timed out. */
  readonly mutants: number;
  /** Mutants Stryker could not run, because they failed to compile or crashed the runner. */
  readonly invalidMutants: number;
  /** Call sites that were faulted and got a verdict. */
  readonly callSites: number;
}

export type IgnoredBy = 'baseline' | 'inline';

/** A finding a baseline entry or a chimpd-ignore comment accepts; it is listed, but not counted. */
export interface IgnoredFinding {
  readonly finding: Finding;
  readonly by: IgnoredBy;
  readonly reason: string | null;
}

export interface BaselineReport {
  /** Path of the baseline file from the repository root. */
  readonly file: string;
  readonly present: boolean;
  readonly entries: number;
  /** Entries that no longer match anything in scope; `chimpd baseline --prune` removes them. */
  readonly stale: readonly BaselineEntry[];
  /** Entries whose code was in scope but not checked well enough to tell whether they still match. */
  readonly notEvaluated: readonly BaselineEntry[];
}

export interface RunResult {
  readonly status: RunStatus;
  /** Why the run is inconclusive or nothing-checkable; null for the other statuses. */
  readonly statusReason: string | null;
  /** Set when status is error: why the run could not be carried out. */
  readonly error: string | null;
  readonly level: Level;
  readonly budgetMs: number;
  readonly spentMs: number;
  readonly seed: number;
  readonly git: GitInfo | null;
  readonly scope: RunScope | null;
  readonly phases: readonly PhaseReport[];
  readonly checked: Checked;
  /** Most severe first. */
  readonly findings: readonly Finding[];
  /** Mutants that could not run, each with whether it failed to compile or crashed, and the first error line. */
  readonly invalid: readonly Item[];
  readonly skipped: readonly Item[];
  readonly inconclusive: readonly Item[];
  readonly conflicts: readonly FileConflict[];
  /** Findings set aside by the baseline or an inline comment; not in `findings` and not in the exit code. */
  readonly ignored: readonly IgnoredFinding[];
  /** null when the run stopped before the baseline was read. */
  readonly baseline: BaselineReport | null;
}
