import type {
  BlackHoleObservation,
  BlackHoleVerdict,
  FaultFindingKind,
  FaultKind,
  FaultVerdictKind,
  InjectedObservation,
  InjectedVerdict,
  ScopeKind,
} from '../core/index.js';
import type { ProjectFrame } from '../fault-recon/call-site.js';
import type { FaultTimings } from '../timings/index.js';

export interface FaultTestRef {
  readonly id: string;
  /** Repo-relative path with forward slashes. */
  readonly file: string;
  readonly name: string;
}

export interface ReachingTest {
  readonly test: FaultTestRef;
  /** Duration of the test body in the unfaulted run. */
  readonly durationMs: number;
  readonly calls: number;
  /** The changed functions this test's calls went through, for a site outside the diff; empty for a call made in changed code. */
  readonly reachedFrom: readonly string[];
}

export interface CallSite {
  /** File, line and column of the innermost project frame. */
  readonly key: string;
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly functionName: string | null;
  readonly path: 'fetch' | 'http';
  /** Every project frame seen under this site, innermost first. */
  readonly frames: readonly ProjectFrame[];
  /**
   * For a site outside the diff, such as a client wrapper, the changed functions its in-scope calls went
   * through, as "file function"; empty when the call itself is in changed code.
   */
  readonly reachedFrom: readonly string[];
  readonly scopeKind: ScopeKind;
  readonly prior: number;
  /** Passing tests whose body made the call, cheapest first. */
  readonly reachedBy: readonly ReachingTest[];
  /** Calls made outside any test body: at import time or from a hook. */
  readonly unattributedCalls: number;
}

export type SkipReason = 'budget' | 'over-cap' | 'no-passing-test';

export interface SkippedCallSite {
  readonly site: CallSite;
  /** The fault kind that was skipped; null when the site was skipped for every kind. */
  readonly kind: FaultKind | null;
  readonly reason: SkipReason;
}

export interface FileConflict {
  readonly testFile: string;
  readonly patched: readonly string[];
}

export interface Discovery {
  readonly status: 'completed' | 'inconclusive';
  readonly statusReason: string | null;
  /** True when the run was stopped at its time limit, which is why it is inconclusive. */
  readonly budgetExhausted: boolean;
  readonly sites: readonly CallSite[];
  readonly outOfScopeSites: number;
  readonly conflicts: readonly FileConflict[];
}

export interface TestFaultResult {
  readonly test: FaultTestRef;
  readonly observations: readonly {
    readonly observation: BlackHoleObservation;
    readonly verdict: BlackHoleVerdict;
  }[];
  /** For a fault that answers at once: the body's observation and its verdict. */
  readonly injected: { readonly observation: InjectedObservation; readonly verdict: InjectedVerdict } | null;
  /** Why the test produced no usable observation; null when it did. */
  readonly problem: string | null;
}

/** One result per site and fault kind. */
export interface CallSiteResult {
  readonly site: CallSite;
  readonly kind: FaultKind;
  readonly verdict: FaultVerdictKind;
  readonly findingKind: FaultFindingKind | null;
  readonly reason: string;
  readonly tests: readonly TestFaultResult[];
}

export interface FaultRunResult {
  readonly status: 'completed' | 'budget-exhausted' | 'inconclusive';
  readonly statusReason: string | null;
  /** One entry per call site and fault kind that was faulted, or per site and kind that could not be attributed to a test. */
  readonly results: readonly CallSiteResult[];
  /** Call sites that were never faulted, each with the reason. */
  readonly skipped: readonly SkippedCallSite[];
  /** Test files that replace HTTP entry points; calls under them are never faulted. */
  readonly conflicts: readonly FileConflict[];
  readonly outOfScopeSites: number;
  readonly spentMs: number;
  /** Where the phase's time went: the discovery run, and the faulted runs that finished. */
  readonly timings: FaultTimings;
}
