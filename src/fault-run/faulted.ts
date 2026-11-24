import path from 'node:path';
import type { Vite } from 'vitest/node';
import {
  firstErrorLine,
  type BlackHoleObservation,
  type FaultKind,
  type InjectedObservation,
  type ResponseUse,
  type ScopeRange,
} from '../core/index.js';
import { patchedBeforeTestsReason, type Fingerprints } from '../fault-recon/conflicts.js';
import type { VitestNodeModule } from '../fault-recon/index.js';
import type { HeldObservation, RuntimeEvent } from '../fault-recon/protocol.js';
import { runInstrumented } from './instrumented.js';
import type { CallSite, FaultTestRef, ReachingTest } from './types.js';

export interface SiteRunRequest {
  /** Real path of the target. */
  readonly targetRoot: string;
  readonly configFile: string;
  readonly vitestNode: VitestNodeModule;
  readonly pristine: Fingerprints;
  readonly site: CallSite;
  readonly tests: readonly ReachingTest[];
  /** The diff scope; only calls to the site that pass through it are faulted. */
  readonly ranges: readonly ScopeRange[];
  readonly deadlineMs: number;
  /** The fault the site gets; the black hole when omitted. */
  readonly kind?: FaultKind;
  readonly timeoutMs?: number;
  /** Receives what the target's own tests write to stdout and stderr; it is discarded without one. */
  readonly onTargetOutput?: (text: string) => void;
}

export interface TestFaultRun {
  readonly test: FaultTestRef;
  /** Black hole only; empty whenever problem is set. */
  readonly observations: readonly BlackHoleObservation[];
  /** For a fault that answers at once: what the body did with it; null for the black hole or when problem is set. */
  readonly injected: InjectedObservation | null;
  /** Why this test produced no usable observation; null when it did. */
  readonly problem: string | null;
}

export interface SiteRun {
  readonly tests: readonly TestFaultRun[];
  /** True when the run was closed at its timeout before every test finished. */
  readonly killed: boolean;
}

/** Room for a released request to settle before Vitest's own timeout would fail the test instead. */
export const TEST_TIMEOUT_MARGIN_MS = 2000;

const SENTINEL_NAME = 'ChimpdBlackHoleReleased';
const MAX_CAUSE_DEPTH = 5;

// Errors cross the worker boundary as plain objects, so the sentinel is recognised by name.
function isSerializedSentinel(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (typeof current !== 'object' || current === null) return false;
    const { name, cause } = current as { name?: unknown; cause?: unknown };
    if (name === SENTINEL_NAME) return true;
    current = cause;
  }
  return false;
}

function raiseTestTimeout(deadlineMs: number): Vite.Plugin {
  return {
    name: 'chimpd:test-timeout',
    configureVitest({ project }) {
      project.config.testTimeout = Math.max(project.config.testTimeout, deadlineMs + TEST_TIMEOUT_MARGIN_MS);
    },
  };
}

type BodyEnd = Extract<RuntimeEvent, { type: 'body-end' }>;

function toObservation(held: HeldObservation, end: BodyEnd, errorEscaped: boolean): BlackHoleObservation | null {
  if (held.requestState === 'released') return null;
  return {
    metadataCaptured: true,
    signalAttached: held.signalAttached,
    signalDeadlineMs: held.signalDeadlineMs,
    socketTimeoutMs: held.socketTimeoutMs,
    requestState: held.requestState,
    firedMechanism: held.firedMechanism,
    abortKind: held.abortKind,
    testOutcome: end.outcome,
    errorEscaped,
    deadlineHit: held.deadlineHit,
  };
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

export interface ProblemInput {
  readonly kind: FaultKind;
  readonly started: boolean;
  readonly end: Pick<BodyEnd, 'targetedCalls' | 'observations' | 'injections'> | undefined;
  readonly crash: string | null;
  /** The error Vitest recorded for the test; it explains a body that never started, as when a hook threw. */
  readonly testError: string | null;
}

/** Why a test body gave no usable observation of the fault; null when it gave one. */
export function faultProblem(input: ProblemInput): string | null {
  const { end } = input;
  if (end === undefined) {
    if (!input.started) {
      if (input.crash !== null) return input.crash;
      const reason = input.testError === null ? null : firstErrorLine(input.testError);
      return reason === null ? 'the test did not run under the fault' : `the test failed before its body ran: ${reason}`;
    }
    return 'the test process ended before the test body finished';
  }
  if (end.targetedCalls === 0) return 'the test did not reach the call site under the fault';
  const faulted = input.kind === 'blackhole' ? end.observations.length : (end.injections ?? []).length;
  const escaped = end.targetedCalls - faulted;
  if (escaped > 0) return `${plural(escaped, 'call')} to the site could not be ${input.kind === 'blackhole' ? 'held' : 'faulted'}`;
  if (input.kind === 'blackhole' && end.observations.some((held) => held.requestState === 'released')) {
    return 'a held request was ended by the cleanup of another test';
  }
  return null;
}

export async function runFaultedSite(request: SiteRunRequest): Promise<SiteRun> {
  const { targetRoot, site, tests } = request;
  const kind = request.kind ?? 'blackhole';
  const run = await runInstrumented({
    targetRoot,
    configFile: request.configFile,
    vitestNode: request.vitestNode,
    pristine: request.pristine,
    mode: {
      kind: 'fault',
      targetRoot,
      siteKey: site.key,
      ranges: request.ranges,
      testIds: tests.map(({ test }) => test.id),
      deadlineMs: request.deadlineMs,
      faultKind: kind,
    },
    filters: [...new Set(tests.map(({ test }) => path.join(targetRoot, test.file)))],
    plugins: [raiseTestTimeout(request.deadlineMs)],
    ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
    ...(request.onTargetOutput === undefined ? {} : { onTargetOutput: request.onTargetOutput }),
  });

  const started = new Set<string>();
  const ended = new Map<string, BodyEnd>();
  const patched = new Map<string, readonly string[]>();
  let patchedBeforeSetup: Extract<RuntimeEvent, { type: 'conflict' }> | null = null;
  for (const event of run.events) {
    if (event.type === 'body-start') started.add(event.testId);
    else if (event.type === 'body-end') ended.set(event.testId, event);
    else if (event.type === 'conflict') {
      if (event.testId === null) patchedBeforeSetup = event;
      else patched.set(event.testId, event.patched);
    }
  }
  const errorEscaped = run.unhandledErrors.some((error) => !isSerializedSentinel(error));

  function problemOf(test: FaultTestRef, end: BodyEnd | undefined): string | null {
    if (patchedBeforeSetup !== null) return patchedBeforeTestsReason(patchedBeforeSetup.patched, patchedBeforeSetup.environment);
    const conflict = patched.get(test.id);
    if (conflict !== undefined) return `the test replaced HTTP entry points: ${conflict.join(', ')}`;
    const testError = run.tests.find((record) => record.id === test.id)?.error ?? null;
    return faultProblem({ kind, started: started.has(test.id), end, crash: run.crash, testError });
  }

  function responseOf(end: BodyEnd): ResponseUse | null {
    const used = (end.injections ?? []).flatMap((call) => (call.response === null ? [] : [call.response]));
    if (used.length === 0) return null;
    return {
      statusRead: used.some((use) => use.statusRead),
      bodyConsumed: used.some((use) => use.bodyConsumed),
      bodyBeforeStatus: used.some((use) => use.bodyBeforeStatus),
    };
  }

  function injectedOf(end: BodyEnd): InjectedObservation | null {
    if (kind === 'blackhole') return null;
    const injections = end.injections ?? [];
    return {
      kind,
      attempts: injections.length,
      errorReachedCaller: injections.every((call) => call.errorReachedCaller),
      testOutcome: end.outcome,
      errorEscaped,
      response: responseOf(end),
      jsonParsed: kind === 'malformed-json' ? (end.jsonParsed ?? false) : null,
    };
  }

  return {
    killed: run.killed,
    tests: tests.map(({ test }) => {
      const end = ended.get(test.id);
      const problem = problemOf(test, end);
      const usable = problem === null && end !== undefined ? end : undefined;
      const observations =
        usable === undefined || kind !== 'blackhole'
          ? []
          : usable.observations.flatMap((held) => toObservation(held, usable, errorEscaped) ?? []);
      return { test, observations, injected: usable === undefined ? null : injectedOf(usable), problem };
    }),
  };
}
