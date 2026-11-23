import type { AbortKind, DeadlineMechanism, FaultKind, ResponseUse, TestOutcome } from '../core/index.js';
import type { StackFrame } from './call-site.js';
import type { Fingerprints } from './conflicts.js';

export interface ReconMode {
  readonly kind: 'recon';
}

export interface FaultMode {
  readonly kind: 'fault';
  readonly targetRoot: string;
  readonly siteKey: string;
  /** Tests whose body runs with the site held; every other test is skipped. */
  readonly testIds: readonly string[];
  readonly deadlineMs: number;
  readonly faultKind: FaultKind;
}

export type RuntimeMode = ReconMode | FaultMode;

export interface RuntimeConfig {
  readonly eventsDir: string;
  readonly pristine: Fingerprints;
  readonly mode: RuntimeMode;
}

/** One held request as it stood when its test body ended or hit the deadline, whichever came first. */
export interface HeldObservation {
  /** released means another test's cleanup ended the request, so its own fate is unknown. */
  readonly requestState: 'pending' | 'aborted' | 'released';
  readonly deadlineHit: boolean;
  readonly signalAttached: boolean | null;
  readonly signalDeadlineMs: number | null;
  readonly socketTimeoutMs: number | null;
  readonly firedMechanism: DeadlineMechanism | null;
  readonly abortKind: AbortKind | null;
  readonly method: string;
  readonly url: string;
}

/** One call to the site that got a fault answering at once. */
export interface InjectedCall {
  readonly method: string;
  readonly url: string;
  readonly path: 'fetch' | 'http' | 'unknown';
  /** false when an http request had no error listener when it got the fault. */
  readonly errorReachedCaller: boolean;
  /** What the code did with the faulted response; null when none reached it. */
  readonly response: ResponseUse | null;
}

interface TestScoped {
  /** null for anything outside a test body: imports and hooks. */
  readonly testId: string | null;
  readonly testFile: string | null;
}

export type RuntimeEvent =
  | (TestScoped & {
      readonly type: 'conflict';
      readonly patched: readonly string[];
      /** The Vitest test environment in effect; set when the entry points were patched before the tests loaded. */
      readonly environment?: string | null;
    })
  | (TestScoped & { readonly type: 'call'; readonly path: 'fetch' | 'http'; readonly frames: readonly StackFrame[] })
  | { readonly type: 'body-start'; readonly testId: string; readonly testFile: string }
  | {
      readonly type: 'body-end';
      readonly testId: string;
      readonly testFile: string;
      readonly outcome: TestOutcome;
      readonly durationMs: number;
      /** Calls the body made to the faulted site; always 0 in a recon run. */
      readonly targetedCalls: number;
      readonly observations: readonly HeldObservation[];
      /** Calls that got a fault answering at once; absent in a recon or black hole run. */
      readonly injections?: readonly InjectedCall[];
      /** Whether the body parsed the malformed JSON body; absent unless the fault is malformed-json. */
      readonly jsonParsed?: boolean;
    };
