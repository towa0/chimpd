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

export type RunStatus = 'completed' | 'incomplete' | 'nothing-in-scope' | 'error';

export interface RunResult {
  readonly status: RunStatus;
  /** Set when status is error: why the run could not be carried out. */
  readonly error: string | null;
  readonly level: Level;
  readonly budgetMs: number;
  readonly spentMs: number;
  readonly seed: number;
  readonly git: GitInfo | null;
  readonly scope: RunScope | null;
  readonly phases: readonly PhaseReport[];
  /** Most severe first. */
  readonly findings: readonly Finding[];
  readonly skipped: readonly Item[];
  readonly inconclusive: readonly Item[];
  readonly conflicts: readonly FileConflict[];
}
