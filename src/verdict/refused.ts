import type { InjectedObservation, InjectedVerdict } from '../core/index.js';

const MISHANDLED = { verdict: 'refusal-mishandled', findingKind: 'refusal-mishandled' } as const;

export function classifyRefused(observation: InjectedObservation): InjectedVerdict {
  const { attempts } = observation;
  if (attempts === 0) return { verdict: 'inconclusive', findingKind: null, reason: 'no call to the site was refused' };
  if (!observation.errorReachedCaller) {
    return { ...MISHANDLED, reason: 'the request had no error listener, so the refusal never reached the caller' };
  }
  if (observation.errorEscaped) {
    return { ...MISHANDLED, reason: 'an unhandled rejection or error event escaped after the connection was refused' };
  }
  if (observation.testOutcome === 'failed') {
    const times = attempts === 1 ? '' : ` ${attempts} times`;
    return { ...MISHANDLED, reason: `the test failed after the connection was refused${times}` };
  }
  const retried = attempts === 1 ? '' : ` after ${attempts} attempts`;
  return { verdict: 'refusal-handled', findingKind: null, reason: `the caller handled the refused connection${retried} and the test passed` };
}
