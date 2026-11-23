import type { InjectedObservation, InjectedVerdict } from '../core/index.js';

const MISHANDLED = { verdict: 'status-mishandled', findingKind: 'error-status-mishandled' } as const;

function after(attempts: number): string {
  return attempts === 1 ? '' : ` after ${attempts} attempts`;
}

export function classifyServerError(observation: InjectedObservation): InjectedVerdict {
  const { attempts, response } = observation;
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
  if (observation.errorEscaped) {
    return { ...MISHANDLED, reason: 'an unhandled rejection or error event escaped after the 500 response' };
  }
  if (observation.testOutcome === 'failed') {
    const what = response.statusRead ? 'the code checked the status of the 500 response, but the test failed' : 'the test failed after the 500 response';
    return { ...MISHANDLED, reason: what };
  }
  if (response.statusRead) {
    return { verdict: 'status-checked', findingKind: null, reason: `the code checked the status of the 500 response${after(attempts)} and the test passed` };
  }
  return { verdict: 'response-unused', findingKind: null, reason: 'the code did not use the 500 response and the test passed' };
}
