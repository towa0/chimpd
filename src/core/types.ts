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
  /** How long the request was held before the test was released: the window in which a deadline of the code's own can be seen to fire. */
  readonly faultWindowMs: number;
}

export type BlackHoleVerdictKind =
  | 'handled-timeout'
  | 'timeout-mishandled'
  | 'hang'
  | 'detached'
  | 'inconclusive';

export type FaultFindingKind =
  | 'abort-mishandled'
  | 'hang-no-timeout'
  | 'fire-and-forget'
  | 'refusal-mishandled'
  | 'error-status-ignored'
  | 'error-status-mishandled'
  | 'malformed-json-mishandled';

export interface BlackHoleVerdict {
  readonly verdict: BlackHoleVerdictKind;
  readonly findingKind: FaultFindingKind | null;
  readonly firedMechanism: DeadlineMechanism | null;
  readonly abortKind: AbortKind | null;
  readonly deadlineMs: number | null;
  readonly reason: string;
}

/** The fault kinds that answer a call at once, where the black hole holds it. */
export type InjectedFaultKind = Exclude<FaultKind, 'blackhole'>;

/** What the code did with a faulted response, over every attempt. */
export interface ResponseUse {
  /** Whether the code read ok, status or statusText, or statusCode or statusMessage for http. */
  readonly statusRead: boolean;
  /** Whether the code read the body: json, text and the like for fetch, its data or stream for http. */
  readonly bodyConsumed: boolean;
  /** Whether a body was consumed before the status of its response was read, if it was read at all. */
  readonly bodyBeforeStatus: boolean;
}

/**
 * What failed a test under a fault, judged by the error itself. fault-escaped: the error the fault raised,
 * or one wrapping it outside project code, failed the test or went unhandled. raised-by-project: project code
 * threw an error of its own, wrapping the fault's or not. raised-by-test: an assertion or the test's own code.
 * unattributed: none of these can be told.
 */
export type FailureKind = 'fault-escaped' | 'raised-by-project' | 'raised-by-test' | 'unattributed';

export interface FailureEvidence {
  readonly kind: FailureKind;
  /** test: the error the test body threw; unhandled: an unhandled rejection or error event. */
  readonly via: 'test' | 'unhandled';
  /** The first line of the error, as "Name: message". */
  readonly error: string;
  /** Where project code raised it, as "file:line"; set for raised-by-project only. */
  readonly raisedAt: string | null;
}

/** One test body under a fault that answers at once, over every call it made to the site. */
export interface InjectedObservation {
  readonly kind: InjectedFaultKind;
  /** Calls the body made to the site; more than one means the code tried again. */
  readonly attempts: number;
  /** false when an http request had no error listener, so its error could not reach the caller. */
  readonly errorReachedCaller: boolean;
  readonly testOutcome: TestOutcome;
  /** Why the test failed, or the fault's error that escaped unhandled; null when the test passed and nothing of the fault escaped. */
  readonly failure: FailureEvidence | null;
  /** For a fault that answers with a response; null when there is none, or none reached the code. */
  readonly response: ResponseUse | null;
  /** Whether the code parsed the faulted body as JSON; null when the fault kind does not watch parsing. */
  readonly jsonParsed: boolean | null;
}

export type InjectedVerdictKind =
  | 'refusal-handled'
  | 'refusal-mishandled'
  | 'status-checked'
  | 'response-unused'
  | 'status-ignored'
  | 'status-mishandled'
  | 'parse-handled'
  | 'parse-mishandled'
  | 'inconclusive';

export interface InjectedVerdict {
  readonly verdict: InjectedVerdictKind;
  readonly findingKind: FaultFindingKind | null;
  readonly reason: string;
}

export type FaultVerdictKind = BlackHoleVerdictKind | InjectedVerdictKind;

