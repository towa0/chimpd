import type { InjectedObservation, InjectedVerdict } from '../core/index.js';
import { escapedReason, notEscapedBecause, unattributedReason } from './evidence.js';

const MISHANDLED = { verdict: 'refusal-mishandled', findingKind: 'refusal-mishandled' } as const;

export function classifyRefused(observation: InjectedObservation): InjectedVerdict {
  const { attempts, failure } = observation;
  if (attempts === 0) return { verdict: 'inconclusive', findingKind: null, reason: 'no call to the site was refused' };
  if (!observation.errorReachedCaller) {
    return { ...MISHANDLED, reason: 'the request had no error listener, so the refusal never reached the caller' };
  }
  const retried = attempts === 1 ? '' : ` after ${attempts} attempts`;
  if (failure === null) {
    return { verdict: 'refusal-handled', findingKind: null, reason: `the caller handled the refused connection${retried} and the test passed` };
  }
  if (failure.kind === 'fault-escaped') {
    const times = attempts === 1 ? '' : ` (refused ${attempts} times)`;
    return { ...MISHANDLED, reason: `${escapedReason("the refused connection's error", failure)}${times}` };
  }
  if (failure.kind === 'unattributed') {
    return { verdict: 'inconclusive', findingKind: null, reason: unattributedReason('the refused connection', failure) };
  }
  return {
    verdict: 'refusal-handled',
    findingKind: null,
    reason: `the refused connection did not escape${retried}; ${notEscapedBecause(failure)}`,
  };
}
