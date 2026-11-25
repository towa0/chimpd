import http from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  installBlackHole,
  isSentinel,
  type BlackHoleInterception,
  type InterceptionPath,
} from '../../src/fault-injector/index.js';

const URL_UNDER_TEST = 'http://blackhole.bruise.invalid/resource';
const ABORT_NAMES = ['AbortError', 'TimeoutError'];

type Send = (signal?: AbortSignal) => Promise<unknown>;

const senders: Record<InterceptionPath, Send> = {
  fetch: (signal) => fetch(URL_UNDER_TEST, signal ? { signal } : {}),
  'client-request': (signal) =>
    new Promise((resolve, reject) => {
      const request = http.request(URL_UNDER_TEST, signal ? { signal } : {});
      request.on('response', resolve);
      request.on('error', reject);
      request.end();
    }),
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Settled {
  readonly error: unknown;
  readonly elapsedMs: number;
}

async function rejection(promise: Promise<unknown>, startedAt: number): Promise<Settled> {
  try {
    await promise;
  } catch (error) {
    return { error, elapsedMs: performance.now() - startedAt };
  }
  throw new Error('expected the request to reject, but it resolved');
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

async function waitForHeld(interception: BlackHoleInterception, count: number): Promise<void> {
  const deadline = performance.now() + 2000;
  while (interception.blackHole.pendingCount < count) {
    if (performance.now() > deadline) throw new Error('request never reached the black hole');
    await sleep(5);
  }
}

describe.each<InterceptionPath>(['fetch', 'client-request'])('abort contract: %s', (path) => {
  const send = senders[path];
  let interception: BlackHoleInterception;

  beforeEach(() => {
    interception = installBlackHole([path]);
  });

  afterEach(() => {
    interception.dispose();
  });

  it('rejects with an abort error within 50-500 ms for AbortSignal.timeout(50)', async () => {
    const startedAt = performance.now();
    const { error, elapsedMs } = await rejection(send(AbortSignal.timeout(50)), startedAt);
    expect(ABORT_NAMES).toContain(errorName(error));
    expect(isSentinel(error)).toBe(false);
    expect(elapsedMs).toBeGreaterThanOrEqual(49);
    expect(elapsedMs).toBeLessThanOrEqual(500);
  });

  it('rejects promptly when the controller aborts mid-flight', async () => {
    const controller = new AbortController();
    const pending = send(controller.signal);
    pending.catch(() => undefined);
    await waitForHeld(interception, 1);
    await sleep(100);
    const abortedAt = performance.now();
    controller.abort();
    const { error, elapsedMs } = await rejection(pending, abortedAt);
    expect(errorName(error)).toBe('AbortError');
    expect(elapsedMs).toBeLessThanOrEqual(200);
  });

  it('rejects immediately when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const startedAt = performance.now();
    const { error, elapsedMs } = await rejection(send(controller.signal), startedAt);
    expect(errorName(error)).toBe('AbortError');
    expect(elapsedMs).toBeLessThanOrEqual(100);
    expect(interception.blackHole.pendingCount).toBe(0);
  });

  it('stays pending without a signal until released, then rejects with the sentinel', async () => {
    const pending = send();
    pending.catch(() => undefined);
    await waitForHeld(interception, 1);
    const outcome = await Promise.race([
      pending.then(
        () => 'settled',
        () => 'settled',
      ),
      sleep(300).then(() => 'pending'),
    ]);
    expect(outcome).toBe('pending');
    expect(interception.blackHole.pendingCount).toBe(1);

    const releasedAt = performance.now();
    expect(interception.blackHole.release()).toBe(1);
    const { error, elapsedMs } = await rejection(pending, releasedAt);
    expect(isSentinel(error)).toBe(true);
    expect(elapsedMs).toBeLessThanOrEqual(200);
    expect(interception.blackHole.pendingCount).toBe(0);
  });
});
