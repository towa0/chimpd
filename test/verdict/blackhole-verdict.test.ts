import { describe, expect, it } from 'vitest';
import type { BlackHoleObservation, BlackHoleVerdict } from '../../src/core/index.js';
import { classifyBlackHole, hasDeadline } from '../../src/verdict/index.js';

const base: BlackHoleObservation = {
  signalAttached: false,
  signalDeadlineMs: null,
  socketTimeoutMs: null,
  requestState: 'pending',
  firedMechanism: null,
  abortKind: null,
  testOutcome: 'passed',
  errorEscaped: false,
  deadlineHit: false,
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
    'signal with tagged deadline never fired, deadline hit',
    { signalAttached: true, signalDeadlineMs: 30_000, deadlineHit: true, testOutcome: 'failed' },
    { verdict: 'long-timeout', findingKind: 'timeout-exceeds-budget', deadlineMs: 30_000 },
  ],
  [
    'signal with unknown deadline never fired, deadline hit',
    { signalAttached: true, deadlineHit: true, testOutcome: 'failed' },
    { verdict: 'long-timeout', findingKind: 'timeout-exceeds-budget', deadlineMs: null },
  ],
  [
    'socket timeout never fired, deadline hit',
    { socketTimeoutMs: 60_000, deadlineHit: true, testOutcome: 'failed' },
    { verdict: 'long-timeout', findingKind: 'timeout-exceeds-budget', deadlineMs: 60_000 },
  ],
  [
    'signal and socket timeout both set, deadline hit: shortest is reported',
    { signalAttached: true, signalDeadlineMs: 30_000, socketTimeoutMs: 20_000, deadlineHit: true },
    { verdict: 'long-timeout', deadlineMs: 20_000 },
  ],
  [
    'signal undeterminable, deadline hit',
    { signalAttached: null, deadlineHit: true, testOutcome: 'failed' },
    { verdict: 'inconclusive', findingKind: null },
  ],
  [
    'signal undeterminable but socket timeout set, deadline hit',
    { signalAttached: null, socketTimeoutMs: 9000, deadlineHit: true },
    { verdict: 'long-timeout', findingKind: 'timeout-exceeds-budget', deadlineMs: 9000 },
  ],
  ['test passed, request pending', {}, { verdict: 'detached', findingKind: 'fire-and-forget' }],
  [
    'test failed before the deadline, request pending',
    { testOutcome: 'failed' },
    { verdict: 'inconclusive', findingKind: null },
  ],
];

describe('black hole verdict table', () => {
  it.each(rows)('%s', (_label, observation, expected) => {
    expect(classifyBlackHole({ ...base, ...observation })).toMatchObject(expected);
  });

  it('never classifies a request with a signal or socket timeout as a hang', () => {
    const states: Partial<BlackHoleObservation>[] = [];
    for (const signalAttached of [true, false, null]) {
      for (const socketTimeoutMs of [null, 50]) {
        for (const deadlineHit of [true, false]) {
          for (const testOutcome of ['passed', 'failed'] as const) {
            states.push({ signalAttached, socketTimeoutMs, deadlineHit, testOutcome });
          }
        }
      }
    }
    for (const state of states) {
      const observation = { ...base, ...state };
      const { verdict } = classifyBlackHole(observation);
      if (hasDeadline(observation) || observation.signalAttached === null) {
        expect(verdict, JSON.stringify(state)).not.toBe('hang');
      }
    }
  });

  it('words the hang reason without claiming the call never returns', () => {
    const { reason } = classifyBlackHole({ ...base, deadlineHit: true });
    expect(reason).toBe('the call has no timeout of its own and relies on runtime transport defaults');
  });
});
