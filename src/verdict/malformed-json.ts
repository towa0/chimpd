import type { InjectedObservation, InjectedVerdict } from '../core/index.js';
import { escapedReason, notEscapedBecause, unattributedReason } from './evidence.js';

const MISHANDLED = { verdict: 'parse-mishandled', findingKind: 'malformed-json-mishandled' } as const;

export function classifyMalformedJson(observation: InjectedObservation): InjectedVerdict {
  const { attempts, failure } = observation;
  if (attempts === 0) return { verdict: 'inconclusive', findingKind: null, reason: 'no call to the site got the malformed body' };
  if (observation.jsonParsed !== true) {
    return {
      verdict: 'inconclusive',
      findingKind: null,
      reason: 'the code never parsed the response as JSON, so malformed-json does not apply',
    };
  }
  const retried = attempts === 1 ? '' : ` after ${attempts} attempts`;
  if (failure === null) {
    return { verdict: 'parse-handled', findingKind: null, reason: `the code caught the parse error${retried} and the test passed` };
  }
  if (failure.kind === 'fault-escaped') return { ...MISHANDLED, reason: escapedReason('the JSON parse error', failure) };
  if (failure.kind === 'unattributed') {
    return { verdict: 'inconclusive', findingKind: null, reason: unattributedReason('the JSON parse error', failure) };
  }
  return { verdict: 'parse-handled', findingKind: null, reason: `the JSON parse error did not escape${retried}; ${notEscapedBecause(failure)}` };
}
