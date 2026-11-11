export type Intensity = 1 | 2 | 3;

export type ScopeMode = 'changed-lines' | 'enclosing-functions';

export type FaultKind = 'blackhole' | 'http-500' | 'malformed-json' | 'connection-refused';

export type ScopeKind = 'changed' | 'enclosing-function' | 'deletion-expanded' | 'test-boundary';

export interface ScopeRange {
  /** Repo-relative path with forward slashes. */
  readonly file: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly kind: ScopeKind;
  readonly staticRegion: boolean;
}

/** One-based line and column, as Stryker reports them. */
export interface Position {
  readonly line: number;
  readonly column: number;
}

export type MutantStatus =
  | 'Killed'
  | 'Survived'
  | 'NoCoverage'
  | 'CompileError'
  | 'RuntimeError'
  | 'Timeout'
  | 'Ignored'
  | 'Pending'
  | 'NotTested';

export interface MutantRecord {
  /** Repo-relative path with forward slashes. */
  readonly file: string;
  readonly start: Position;
  /** Exclusive. */
  readonly end: Position;
  readonly mutatorName: string;
  readonly replacement: string;
  readonly status: MutantStatus;
  readonly statusReason: string | null;
  readonly coveredBy: readonly string[];
  readonly killedBy: readonly string[];
  readonly static: boolean;
  readonly sourceHash: string;
  readonly scopeKind: ScopeKind;
}

export type DeadlineMechanism = 'signal' | 'socket-timeout' | 'manual-destroy';

export type AbortKind = 'timeout' | 'abort';

export type TestOutcome = 'passed' | 'failed';

export interface BlackHoleObservation {
  /** false when the request bypassed the call wrappers, so its signal and socket timeout are both unknown. */
  readonly metadataCaptured: boolean;
  /** null when the caller's intent cannot be determined, as with a Request built before the wrappers were installed. */
  readonly signalAttached: boolean | null;
  readonly signalDeadlineMs: number | null;
  readonly socketTimeoutMs: number | null;
  readonly requestState: 'pending' | 'aborted';
  readonly firedMechanism: DeadlineMechanism | null;
  readonly abortKind: AbortKind | null;
  readonly testOutcome: TestOutcome;
  readonly errorEscaped: boolean;
  readonly deadlineHit: boolean;
}

export type BlackHoleVerdictKind =
  | 'handled-timeout'
  | 'timeout-mishandled'
  | 'hang'
  | 'long-timeout'
  | 'detached'
  | 'inconclusive';

export type FaultFindingKind =
  | 'abort-mishandled'
  | 'hang-no-timeout'
  | 'timeout-exceeds-budget'
  | 'fire-and-forget';

export interface BlackHoleVerdict {
  readonly verdict: BlackHoleVerdictKind;
  readonly findingKind: FaultFindingKind | null;
  readonly firedMechanism: DeadlineMechanism | null;
  readonly abortKind: AbortKind | null;
  readonly deadlineMs: number | null;
  readonly reason: string;
}
