import { describe, expect, it } from 'vitest';
import type { BlackHoleObservation, BlackHoleVerdict } from '../../src/core/index.js';
import { classifyBlackHole, hasDeadline } from '../../src/verdict/index.js';

const base: BlackHoleObservation = {
  metadataCaptured: true,
  signalAttached: false,
  signalDeadlineMs: null,
  socketTimeoutMs: null,
  requestState: 'pending',
  firedMechanism: null,
  abortKind: null,
  testOutcome: 'passed',
  errorEscaped: false,
  deadlineHit: false,
  faultWindowMs: 2000,
};

type Row = [string, Partial<BlackHoleObservation>, Partial<BlackHoleVerdict>];

const rows: Row[] = [
  [
    'signal timeout fired, test passed',
    { signalAttached: true, signalDeadlineMs: 100, requestState: 'aborted', firedMechanism: 'signal', abortKind: 'timeout' },
    { verdict: 'handled-timeout', findingKind: null, firedMechanism: 'signal', abortKind: 'timeout', deadlineMs: 100 },
  ],
  [
    'socket timeout fired, test passed',
    { socketTimeoutMs: 50, requestState: 'aborted', firedMechanism: 'socket-timeout', abortKind: 'timeout' },
    { verdict: 'handled-timeout', findingKind: null, firedMechanism: 'socket-timeout', deadlineMs: 50 },
  ],
  [
    'controller abort, test passed, deadline not known',
    { signalAttached: true, requestState: 'aborted', firedMechanism: 'signal', abortKind: 'abort' },
    { verdict: 'handled-timeout', findingKind: null, abortKind: 'abort', deadlineMs: null },
  ],
  [
    'signal fired, test failed',
    { signalAttached: true, requestState: 'aborted', firedMechanism: 'signal', abortKind: 'timeout', testOutcome: 'failed' },
    { verdict: 'timeout-mishandled', findingKind: 'abort-mishandled', firedMechanism: 'signal' },
  ],
  [
    'socket timeout fired, test passed but an error escaped',
    { socketTimeoutMs: 50, requestState: 'aborted', firedMechanism: 'socket-timeout', abortKind: 'timeout', errorEscaped: true },
    { verdict: 'timeout-mishandled', findingKind: 'abort-mishandled', firedMechanism: 'socket-timeout' },
  ],
  [
    'no signal, no socket timeout, deadline hit',
    { deadlineHit: true, testOutcome: 'failed' },
    { verdict: 'hang', findingKind: 'hang-no-timeout' },
  ],
  [
    'a 5 s signal timeout outlasts the 2 s fault window: not observed, not a finding',
    { signalAttached: true, signalDeadlineMs: 5000, deadlineHit: true, testOutcome: 'failed' },
    {
      verdict: 'inconclusive',
      findingKind: null,
      deadlineMs: 5000,
      reason: "the code's own timeout (5000 ms) is longer than the fault window (2000 ms); not observed",
    },
  ],
  [
    'signal with unknown deadline never fired, deadline hit',
    { signalAttached: true, deadlineHit: true, testOutcome: 'failed' },
    {
      verdict: 'inconclusive',
      findingKind: null,
      deadlineMs: null,
      reason: 'the code has a timeout of its own whose length is unknown, and it did not fire within the fault window (2000 ms); not observed',
    },
  ],
  [
    'socket timeout outlasts the fault window, deadline hit',
    { socketTimeoutMs: 60_000, deadlineHit: true, testOutcome: 'failed' },
    {
      verdict: 'inconclusive',
      findingKind: null,
      deadlineMs: 60_000,
      reason: "the code's own timeout (60000 ms) is longer than the fault window (2000 ms); not observed",
    },
  ],
  [
    'a timeout inside the fault window that did not fire',
    { signalAttached: true, signalDeadlineMs: 1500, deadlineHit: true },
    {
      verdict: 'inconclusive',
      findingKind: null,
      deadlineMs: 1500,
      reason: "the code's own timeout (1500 ms) did not fire within the fault window (2000 ms); not observed",
    },
  ],
  [
    'signal and socket timeout both set, deadline hit: shortest is reported',
    { signalAttached: true, signalDeadlineMs: 30_000, socketTimeoutMs: 20_000, deadlineHit: true },
    { verdict: 'inconclusive', deadlineMs: 20_000 },
  ],
  [
    'signal undeterminable, deadline hit',
    { signalAttached: null, deadlineHit: true, testOutcome: 'failed' },
    { verdict: 'inconclusive', findingKind: null },
  ],
  [
    'signal undeterminable but socket timeout set, deadline hit',
    { signalAttached: null, socketTimeoutMs: 9000, deadlineHit: true },
    { verdict: 'inconclusive', findingKind: null, deadlineMs: 9000 },
  ],
  [
    'manual destroy, test passed',
    { requestState: 'aborted', firedMechanism: 'manual-destroy', abortKind: 'abort' },
    { verdict: 'handled-timeout', findingKind: null, firedMechanism: 'manual-destroy', deadlineMs: null },
  ],
  [
    'manual destroy, test failed',
    { requestState: 'aborted', firedMechanism: 'manual-destroy', abortKind: 'abort', testOutcome: 'failed' },
    { verdict: 'timeout-mishandled', findingKind: 'abort-mishandled', firedMechanism: 'manual-destroy' },
  ],
  [
    'no captured metadata, deadline hit',
    { metadataCaptured: false, signalAttached: null, deadlineHit: true, testOutcome: 'failed' },
    { verdict: 'inconclusive', findingKind: null },
  ],
  [
    'no captured metadata, deadline hit, even if fields claim no signal',
    { metadataCaptured: false, signalAttached: false, socketTimeoutMs: null, deadlineHit: true },
    { verdict: 'inconclusive', findingKind: null },
  ],
  ['test passed, request pending', {}, { verdict: 'detached', findingKind: 'fire-and-forget' }],
  [
    'test failed before the deadline, request pending',
    { testOutcome: 'failed' },
    { verdict: 'inconclusive', findingKind: null },
  ],
];

function pendingStates(): Partial<BlackHoleObservation>[] {
  const states: Partial<BlackHoleObservation>[] = [];
  for (const metadataCaptured of [true, false]) {
    for (const signalAttached of [true, false, null]) {
      for (const socketTimeoutMs of [null, 50]) {
        for (const deadlineHit of [true, false]) {
          for (const testOutcome of ['passed', 'failed'] as const) {
            states.push({ metadataCaptured, signalAttached, socketTimeoutMs, deadlineHit, testOutcome });
          }
        }
      }
    }
  }
  return states;
}

describe('black hole verdict table', () => {
  it.each(rows)('%s', (_label, observation, expected) => {
    expect(classifyBlackHole({ ...base, ...observation })).toMatchObject(expected);
  });

  it('never classifies a request with a signal or socket timeout as a hang', () => {
    let hangs = 0;
    for (const state of pendingStates()) {
      const observation = { ...base, ...state };
      const { verdict } = classifyBlackHole(observation);
      const mayHang =
        observation.metadataCaptured && observation.signalAttached === false && !hasDeadline(observation);
      if (!mayHang) expect(verdict, JSON.stringify(state)).not.toBe('hang');
      if (verdict === 'hang') hangs += 1;
    }
    expect(hangs).toBeGreaterThan(0);
  });

  it('never reaches hang for a request without captured metadata', () => {
    for (const state of pendingStates()) {
      const { verdict } = classifyBlackHole({ ...base, ...state, metadataCaptured: false });
      expect(verdict, JSON.stringify(state)).not.toBe('hang');
    }
  });

  it('gives the same verdict whether a socket timeout or a manual destroy ended the request', () => {
    for (const socketTimeoutMs of [null, 50]) {
      for (const signalAttached of [true, false, null]) {
        for (const testOutcome of ['passed', 'failed'] as const) {
          for (const errorEscaped of [true, false]) {
            const aborted = {
              ...base,
              socketTimeoutMs,
              signalAttached,
              testOutcome,
              errorEscaped,
              requestState: 'aborted' as const,
            };
            const bySocket = classifyBlackHole({ ...aborted, firedMechanism: 'socket-timeout', abortKind: 'timeout' });
            const byDestroy = classifyBlackHole({ ...aborted, firedMechanism: 'manual-destroy', abortKind: 'abort' });
            expect(byDestroy.verdict).toBe(bySocket.verdict);
            expect(byDestroy.findingKind).toBe(bySocket.findingKind);
          }
        }
      }
    }
  });

  it('words the hang reason without claiming the call never returns', () => {
    const { reason } = classifyBlackHole({ ...base, deadlineHit: true });
    expect(reason).toBe('the call has no timeout of its own and relies on runtime transport defaults');
  });
});
