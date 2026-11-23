import type { InjectedObservation, InjectedVerdict } from '../core/index.js';

const MISHANDLED = { verdict: 'parse-mishandled', findingKind: 'malformed-json-mishandled' } as const;

export function classifyMalformedJson(observation: InjectedObservation): InjectedVerdict {
  const { attempts } = observation;
  if (attempts === 0) return { verdict: 'inconclusive', findingKind: null, reason: 'no call to the site got the malformed body' };
  if (observation.jsonParsed !== true) {
    return {
      verdict: 'inconclusive',
      findingKind: null,
      reason: 'the code never parsed the response as JSON, so malformed-json does not apply',
    };
  }
  if (observation.errorEscaped) return { ...MISHANDLED, reason: 'the parse error escaped as an unhandled rejection or error event' };
  if (observation.testOutcome === 'failed') return { ...MISHANDLED, reason: 'the test failed after the JSON body could not be parsed' };
  const retried = attempts === 1 ? '' : ` after ${attempts} attempts`;
  return { verdict: 'parse-handled', findingKind: null, reason: `the code caught the parse error${retried} and the test passed` };
}
