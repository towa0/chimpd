import path from 'node:path';
import type { Vite } from 'vitest/node';
import type { BlackHoleObservation } from '../core/index.js';
import type { Fingerprints } from '../fault-recon/conflicts.js';
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
  readonly deadlineMs: number;
  readonly timeoutMs?: number;
}

export interface TestFaultRun {
  readonly test: FaultTestRef;
  /** Empty whenever problem is set. */
  readonly observations: readonly BlackHoleObservation[];
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

export async function runFaultedSite(request: SiteRunRequest): Promise<SiteRun> {
  const { targetRoot, site, tests } = request;
  const run = await runInstrumented({
    targetRoot,
    configFile: request.configFile,
    vitestNode: request.vitestNode,
    pristine: request.pristine,
    mode: {
      kind: 'fault',
      targetRoot,
      siteKey: site.key,
      testIds: tests.map(({ test }) => test.id),
      deadlineMs: request.deadlineMs,
    },
    filters: [...new Set(tests.map(({ test }) => path.join(targetRoot, test.file)))],
    plugins: [raiseTestTimeout(request.deadlineMs)],
    ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
  });

  const started = new Set<string>();
  const ended = new Map<string, BodyEnd>();
  const patched = new Map<string, readonly string[]>();
  let patchedBeforeSetup: readonly string[] | null = null;
  for (const event of run.events) {
    if (event.type === 'body-start') started.add(event.testId);
    else if (event.type === 'body-end') ended.set(event.testId, event);
    else if (event.type === 'conflict') {
      if (event.testId === null) patchedBeforeSetup = event.patched;
      else patched.set(event.testId, event.patched);
    }
  }
  const errorEscaped = run.unhandledErrors.some((error) => !isSerializedSentinel(error));

  function problemOf(test: FaultTestRef, end: BodyEnd | undefined): string | null {
    if (patchedBeforeSetup !== null) {
      return `HTTP entry points were already patched before the tests loaded: ${patchedBeforeSetup.join(', ')}`;
    }
    const conflict = patched.get(test.id);
    if (conflict !== undefined) return `the test replaced HTTP entry points: ${conflict.join(', ')}`;
    if (end === undefined) {
      if (!started.has(test.id)) return run.crash ?? 'the test did not run under the fault';
      return 'the test process ended before the test body finished';
    }
    if (end.targetedCalls === 0) return 'the test did not reach the call site under the fault';
    const escaped = end.targetedCalls - end.observations.length;
    if (escaped > 0) return `${plural(escaped, 'call')} to the site could not be held`;
    if (end.observations.some((held) => held.requestState === 'released')) {
      return 'a held request was ended by the cleanup of another test';
    }
    return null;
  }

  return {
    killed: run.killed,
    tests: tests.map(({ test }) => {
      const end = ended.get(test.id);
      const problem = problemOf(test, end);
      const observations =
        problem !== null || end === undefined
          ? []
          : end.observations.flatMap((held) => toObservation(held, end, errorEscaped) ?? []);
      return { test, observations, problem };
    }),
  };
}
