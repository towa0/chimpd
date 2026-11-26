import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { threadId } from 'node:worker_threads';
import { realClearTimeout, realNow, realSetTimeout } from '../core/clock.js';
import type { FailureEvidence, TestOutcome } from '../core/types.js';
import type { RequestObservation } from '../fault-injector/blackhole.js';
import { installCallCapture, type CallMetadata } from '../fault-injector/call-capture.js';
import { installBlackHole } from '../fault-injector/interception.js';
import { parseStack, targetsSite } from './call-site.js';
import { createPatchGuard, patchedSince, testEnvironmentName } from './conflicts.js';
import { startInjection } from './inject-session.js';
import type { FaultMode, HeldObservation, InjectedCall, RuntimeConfig, RuntimeEvent } from './protocol.js';

export interface RunnerTask {
  readonly id: string;
  readonly file: { readonly filepath: string };
  readonly context?: { skip(): void };
}

export interface RunnerPrototype {
  runTask?: (task: RunnerTask) => unknown;
}

/** The target's own Vitest, handed in so hooks register with the runner that executes the tests. */
export interface RuntimeHooks {
  afterAll(listener: () => void): void;
  readonly runner: RunnerPrototype;
  getTestFn(task: RunnerTask): (() => unknown) | undefined;
}

export interface TestBody {
  readonly testId: string;
  readonly testFile: string;
}

export interface BodyReport {
  readonly targetedCalls: number;
  readonly observations: readonly HeldObservation[];
  readonly injections?: readonly InjectedCall[];
  readonly jsonParsed?: boolean;
  readonly failure?: FailureEvidence | null;
}

/** How a test body ended: with the error it threw, or without one. */
export type BodyEnding = { readonly threw: false } | { readonly threw: true; readonly error: unknown };

export interface Session {
  includes(task: RunnerTask): boolean;
  begin(current: TestBody): void;
  end(current: TestBody, ending: BodyEnding): BodyReport | Promise<BodyReport>;
  dispose(): void;
}

type Write = (event: RuntimeEvent) => void;

const body = new AsyncLocalStorage<TestBody>();

function createWriter(eventsDir: string): Write {
  const file = path.join(eventsDir, `${process.pid}-${threadId}-${randomUUID()}.jsonl`);
  return (event) => fs.appendFileSync(file, `${JSON.stringify(event)}\n`);
}

function startRecon(write: Write): Session {
  const capture = installCallCapture({
    onCall(metadata) {
      const current = body.getStore();
      write({
        type: 'call',
        testId: current?.testId ?? null,
        testFile: current?.testFile ?? null,
        path: metadata.path,
        frames: parseStack(metadata.stack),
      });
    },
  });
  return {
    includes: () => true,
    begin: () => undefined,
    end: () => ({ targetedCalls: 0, observations: [] }),
    dispose: () => capture.restore(),
  };
}

interface RunningBody {
  readonly calls: CallMetadata[];
  targetedCalls: number;
  frozen: HeldObservation[] | null;
  timer: ReturnType<typeof setTimeout> | null;
}

function toHeld(observation: RequestObservation, atDeadline: boolean): HeldObservation {
  return {
    requestState: observation.outcome,
    deadlineHit: atDeadline && observation.outcome === 'pending',
    signalAttached: observation.signalAttached,
    signalDeadlineMs: observation.signalDeadlineMs,
    socketTimeoutMs: observation.socketTimeoutMs,
    firedMechanism: observation.firedMechanism,
    abortKind: observation.abortKind,
    method: observation.method,
    url: observation.url,
  };
}

const HOLD_GRACE_MS = 500;
const HOLD_POLL_MS = 5;

function startFault(mode: FaultMode): Session {
  const selected = new Set(mode.testIds);
  const running = new Map<TestBody, RunningBody>();
  const owners = new WeakMap<CallMetadata, TestBody>();

  const interception = installBlackHole(['fetch', 'client-request'], {
    onCall(metadata) {
      const current = body.getStore();
      const active = current === undefined ? undefined : running.get(current);
      if (current === undefined || active === undefined) return;
      if (!targetsSite(metadata.stack, mode)) return;
      active.targetedCalls += 1;
      active.calls.push(metadata);
      owners.set(metadata, current);
    },
    shouldHold: (metadata) => metadata !== null && owners.has(metadata),
  });

  function snapshot(current: TestBody, atDeadline: boolean): HeldObservation[] {
    return interception.blackHole.observations
      .filter(({ metadata }) => metadata !== null && owners.get(metadata) === current)
      .map((observation) => toHeld(observation, atDeadline));
  }

  return {
    includes: (task) => selected.has(task.id),
    begin(current) {
      const active: RunningBody = { calls: [], targetedCalls: 0, frozen: null, timer: null };
      running.set(current, active);
      active.timer = realSetTimeout(() => {
        const atDeadline = snapshot(current, true);
        if (!atDeadline.some((observation) => observation.deadlineHit)) return;
        active.frozen = atDeadline;
        interception.blackHole.release();
      }, mode.deadlineMs);
    },
    async end(current) {
      const active = running.get(current);
      if (active === undefined) return { targetedCalls: 0, observations: [] };
      running.delete(current);
      // A body that does not wait for its request can end before the request reaches the black hole.
      const giveUpAt = realNow() + HOLD_GRACE_MS;
      while (active.frozen === null && snapshot(current, false).length < active.targetedCalls && realNow() < giveUpAt) {
        await new Promise((resolve) => realSetTimeout(resolve, HOLD_POLL_MS));
      }
      if (active.timer !== null) realClearTimeout(active.timer);
      const observations = active.frozen ?? snapshot(current, false);
      interception.blackHole.release();
      // Client pools reconnect later in the async context of these calls; holding them past the body would black-hole whoever reuses the connection.
      for (const metadata of active.calls) owners.delete(metadata);
      return { targetedCalls: active.targetedCalls, observations };
    },
    dispose: () => interception.dispose(),
  };
}

export function startRuntime(hooks: RuntimeHooks, config: RuntimeConfig): void {
  const write = createWriter(config.eventsDir);

  const patched = patchedSince(config.pristine);
  if (patched.length > 0) {
    write({ type: 'conflict', testId: null, testFile: null, patched, environment: testEnvironmentName() });
    return;
  }

  const { mode } = config;
  const session =
    mode.kind === 'recon'
      ? startRecon(write)
      : mode.faultKind === 'blackhole'
        ? startFault(mode)
        : startInjection(
            mode,
            () => body.getStore(),
            (owner, failure) => write({ type: 'escaped', testId: owner.testId, failure }),
          );
  const guard = createPatchGuard(config.pristine);

  async function runBody(current: TestBody, fn: () => unknown): Promise<unknown> {
    write({ type: 'body-start', ...current });
    session.begin(current);
    const startedAt = realNow();
    let outcome: TestOutcome = 'failed';
    let ending: BodyEnding = { threw: false };
    try {
      const value = await body.run(current, fn);
      outcome = 'passed';
      return value;
    } catch (error) {
      ending = { threw: true, error };
      throw error;
    } finally {
      const report = await session.end(current, ending);
      const changed = guard.changed();
      if (changed.length > 0) write({ type: 'conflict', ...current, patched: changed });
      write({ type: 'body-end', ...current, outcome, durationMs: realNow() - startedAt, ...report });
    }
  }

  // runTask is the runner's own seam around the test function alone, with hooks outside it.
  // TestRunner.setTestFn cannot be used instead: Vitest 4.1 and 5.1 alias it to the getter.
  const { runner } = hooks;
  const previous = runner.runTask;
  runner.runTask = function (this: unknown, task: RunnerTask): unknown {
    if (!session.includes(task)) task.context?.skip();
    const fn = previous === undefined ? hooks.getTestFn(task) : () => previous.call(this, task);
    if (fn === undefined) throw new Error(`bruise found no test function for ${task.id}`);
    return session.includes(task) ? runBody({ testId: task.id, testFile: task.file.filepath }, fn) : fn();
  };

  hooks.afterAll(() => {
    session.dispose();
    if (previous === undefined) delete runner.runTask;
    else runner.runTask = previous;
  });
}
