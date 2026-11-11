export type ScopeKind = 'changed' | 'enclosing-function' | 'deletion-expanded';

export interface ScopeRange {
  /** Repo-relative path with forward slashes. */
  readonly file: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly kind: ScopeKind;
  readonly staticRegion: boolean;
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
