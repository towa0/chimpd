import { describe, expect, it } from 'vitest';
import { faultProblem, type ProblemInput } from '../../src/fault-run/faulted.js';

const held = {
  requestState: 'aborted' as const,
  deadlineHit: false,
  signalAttached: true,
  signalDeadlineMs: 100,
  socketTimeoutMs: null,
  firedMechanism: 'signal' as const,
  abortKind: 'timeout' as const,
  method: 'GET',
  url: 'http://127.0.0.1/a',
};

const injectedCall = { method: 'GET', url: 'http://127.0.0.1/a', path: 'fetch' as const, errorReachedCaller: true, response: null };

function input(overrides: Partial<ProblemInput> = {}): ProblemInput {
  return {
    kind: 'blackhole',
    started: true,
    end: { targetedCalls: 1, observations: [held], injections: [] },
    crash: null,
    testError: null,
    ...overrides,
  };
}

describe('faultProblem', () => {
  it('finds no problem for a body whose every targeted call was faulted', () => {
    expect(faultProblem(input())).toBeNull();
    expect(faultProblem(input({ kind: 'connection-refused', end: { targetedCalls: 2, observations: [], injections: [injectedCall, injectedCall] } }))).toBeNull();
  });

  it.each([
    ['blackhole', 'held'],
    ['connection-refused', 'faulted'],
  ] as const)('is inconclusive for %s when a targeted call escaped the scoped fault', (kind, word) => {
    const end =
      kind === 'blackhole'
        ? { targetedCalls: 3, observations: [held], injections: [] }
        : { targetedCalls: 3, observations: [], injections: [injectedCall] };
    expect(faultProblem(input({ kind, end }))).toBe(`2 calls to the site could not be ${word}`);
  });

  it.each(['blackhole', 'connection-refused'] as const)('is inconclusive for %s when the body never reached the site', (kind) => {
    expect(faultProblem(input({ kind, end: { targetedCalls: 0, observations: [], injections: [] } }))).toBe(
      'the test did not reach the call site under the fault',
    );
  });

  it.each(['blackhole', 'connection-refused'] as const)('is inconclusive for %s when the worker died', (kind) => {
    expect(faultProblem(input({ kind, end: undefined }))).toBe('the test process ended before the test body finished');
    expect(faultProblem(input({ kind, end: undefined, started: false, crash: 'worker exited' }))).toBe('worker exited');
    expect(faultProblem(input({ kind, end: undefined, started: false }))).toBe('the test did not run under the fault');
  });

  it.each(['blackhole', 'connection-refused'] as const)(
    'names the first line of the error for %s when a hook or the setup failed before the body ran',
    (kind) => {
      const testError = 'expected 404 to be 200\n    at beforeEach (test/pair.test.ts:3:5)';
      expect(faultProblem(input({ kind, started: false, end: undefined, testError }))).toBe(
        'the test failed before its body ran: expected 404 to be 200',
      );
    },
  );

  it('keeps a crash ahead of the test error, and the test error apart from not reaching the site', () => {
    expect(faultProblem(input({ started: false, end: undefined, crash: 'worker exited', testError: 'boom' }))).toBe('worker exited');
    expect(faultProblem(input({ end: { targetedCalls: 0, observations: [], injections: [] }, testError: 'boom' }))).toBe(
      'the test did not reach the call site under the fault',
    );
  });

  it('is inconclusive for the black hole when another test released the request', () => {
    expect(faultProblem(input({ end: { targetedCalls: 1, observations: [{ ...held, requestState: 'released' }], injections: [] } }))).toBe(
      'a held request was ended by the cleanup of another test',
    );
  });
});
