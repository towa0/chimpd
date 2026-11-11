import type { BlackHoleObservation, BlackHoleVerdict } from '../core/index.js';

function knownDeadlineMs(observation: BlackHoleObservation): number | null {
  const candidates = [observation.signalDeadlineMs, observation.socketTimeoutMs].filter(
    (value): value is number => value !== null,
  );
  return candidates.length > 0 ? Math.min(...candidates) : null;
}

function firedDeadlineMs(observation: BlackHoleObservation): number | null {
  if (observation.firedMechanism === 'signal') return observation.signalDeadlineMs;
  if (observation.firedMechanism === 'socket-timeout') return observation.socketTimeoutMs;
  return null;
}

export function hasDeadline(observation: BlackHoleObservation): boolean {
  return observation.signalAttached === true || observation.socketTimeoutMs !== null;
}

function deadlineUndeterminable(observation: BlackHoleObservation): boolean {
  return !observation.metadataCaptured || observation.signalAttached === null;
}

export function classifyBlackHole(observation: BlackHoleObservation): BlackHoleVerdict {
  const { firedMechanism, abortKind } = observation;
  const testFailed = observation.testOutcome === 'failed' || observation.errorEscaped;

  if (observation.requestState === 'aborted') {
    const base = { firedMechanism, abortKind, deadlineMs: firedDeadlineMs(observation) };
    return testFailed
      ? {
          ...base,
          verdict: 'timeout-mishandled',
          findingKind: 'abort-mishandled',
          reason: 'the request was aborted and the test failed or an error escaped',
        }
      : {
          ...base,
          verdict: 'handled-timeout',
          findingKind: null,
          reason: 'the request was aborted and the test passed',
        };
  }

  const pending = { firedMechanism: null, abortKind: null };

  if (observation.deadlineHit) {
    if (hasDeadline(observation)) {
      const deadlineMs = knownDeadlineMs(observation);
      return {
        ...pending,
        verdict: 'long-timeout',
        findingKind: 'timeout-exceeds-budget',
        deadlineMs,
        reason:
          deadlineMs === null
            ? 'the call has a deadline that did not fire within the test deadline; deadline unknown'
            : `the call has a ${deadlineMs} ms deadline that did not fire within the test deadline`,
      };
    }
    if (deadlineUndeterminable(observation)) {
      return {
        ...pending,
        verdict: 'inconclusive',
        findingKind: null,
        deadlineMs: null,
        reason: 'the request was still pending at the test deadline and its deadline could not be determined',
      };
    }
    return {
      ...pending,
      verdict: 'hang',
      findingKind: 'hang-no-timeout',
      deadlineMs: null,
      reason: 'the call has no timeout of its own and relies on runtime transport defaults',
    };
  }

  if (testFailed) {
    return {
      ...pending,
      verdict: 'inconclusive',
      findingKind: null,
      deadlineMs: null,
      reason: 'the test failed before its deadline while the request was pending and not aborted',
    };
  }

  return {
    ...pending,
    verdict: 'detached',
    findingKind: 'fire-and-forget',
    deadlineMs: null,
    reason: 'the test passed while the request was still pending',
  };
}
