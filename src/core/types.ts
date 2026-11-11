export type DeadlineMechanism = 'signal' | 'socket-timeout';

export type AbortKind = 'timeout' | 'abort';

export type TestOutcome = 'passed' | 'failed';

export interface BlackHoleObservation {
  /** null when the caller's intent cannot be determined, as with a Request object passed to fetch. */
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
