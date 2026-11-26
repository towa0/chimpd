import type { InjectedObservation, InjectedVerdict } from '../core/index.js';
import { escapedReason, notEscapedBecause, unattributedReason } from './evidence.js';

function after(attempts: number): string {
  return attempts === 1 ? '' : ` after ${attempts} attempts`;
}

export function classifyServerError(observation: InjectedObservation): InjectedVerdict {
  const { attempts, response, failure } = observation;
  if (attempts === 0) return { verdict: 'inconclusive', findingKind: null, reason: 'no call to the site got the 500 response' };
  if (response === null) {
    return { verdict: 'inconclusive', findingKind: null, reason: 'the 500 response never reached the code, so its use could not be observed' };
  }
  if (response.bodyBeforeStatus) {
    return {
      verdict: 'status-ignored',
      findingKind: 'error-status-ignored',
      reason: 'the code consumed the body of the 500 response before checking res.ok or res.status',
    };
  }
  if (failure?.kind === 'fault-escaped') {
    return {
      verdict: 'status-mishandled',
      findingKind: 'error-status-mishandled',
      reason: escapedReason('the error from parsing the body of the 500 response as JSON', failure),
    };
  }
  if (failure?.kind === 'unattributed') {
    return { verdict: 'inconclusive', findingKind: null, reason: unattributedReason('an error from the 500 response', failure) };
  }
  if (response.statusRead) {
    const checked = `the code checked the status of the 500 response${after(attempts)}`;
    return {
      verdict: 'status-checked',
      findingKind: null,
      reason: failure === null ? `${checked} and the test passed` : `${checked}; ${notEscapedBecause(failure)}`,
    };
  }
  return {
    verdict: 'response-unused',
    findingKind: null,
    reason:
      failure === null
        ? 'the code did not use the 500 response and the test passed'
        : `the code did not use the 500 response; ${notEscapedBecause(failure)}`,
  };
}
