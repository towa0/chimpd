import { describe, expect, it } from 'vitest';
import type { InjectedObservation, InjectedVerdict } from '../../src/core/index.js';
import { classifyInjected, classifyMalformedJson } from '../../src/verdict/index.js';

const base: InjectedObservation = {
  kind: 'malformed-json',
  attempts: 1,
  errorReachedCaller: true,
  testOutcome: 'passed',
  errorEscaped: false,
  response: { statusRead: false, bodyConsumed: true, bodyBeforeStatus: true },
  jsonParsed: true,
};

type Row = [string, Partial<InjectedObservation>, InjectedVerdict];

const rows: Row[] = [
  [
    'parsed, error caught, test passed',
    {},
    { verdict: 'parse-handled', findingKind: null, reason: 'the code caught the parse error and the test passed' },
  ],
  [
    'parsed on each of 3 attempts, test passed',
    { attempts: 3 },
    { verdict: 'parse-handled', findingKind: null, reason: 'the code caught the parse error after 3 attempts and the test passed' },
  ],
  [
    'parsed, test failed',
    { testOutcome: 'failed' },
    {
      verdict: 'parse-mishandled',
      findingKind: 'malformed-json-mishandled',
      reason: 'the test failed after the JSON body could not be parsed',
    },
  ],
  [
    'parsed, the parse error escaped',
    { errorEscaped: true },
    {
      verdict: 'parse-mishandled',
      findingKind: 'malformed-json-mishandled',
      reason: 'the parse error escaped as an unhandled rejection or error event',
    },
  ],
  [
    'parsed, escaped and the test failed: the escape is reported',
    { errorEscaped: true, testOutcome: 'failed' },
    {
      verdict: 'parse-mishandled',
      findingKind: 'malformed-json-mishandled',
      reason: 'the parse error escaped as an unhandled rejection or error event',
    },
  ],
  [
    'never parsed, test passed',
    { jsonParsed: false },
    {
      verdict: 'inconclusive',
      findingKind: null,
      reason: 'the code never parsed the response as JSON, so malformed-json does not apply',
    },
  ],
  [
    'never parsed, test failed',
    { jsonParsed: false, testOutcome: 'failed' },
    {
      verdict: 'inconclusive',
      findingKind: null,
      reason: 'the code never parsed the response as JSON, so malformed-json does not apply',
    },
  ],
  [
    'parsing not watched',
    { jsonParsed: null },
    {
      verdict: 'inconclusive',
      findingKind: null,
      reason: 'the code never parsed the response as JSON, so malformed-json does not apply',
    },
  ],
  [
    'no call got the body',
    { attempts: 0 },
    { verdict: 'inconclusive', findingKind: null, reason: 'no call to the site got the malformed body' },
  ],
];

describe('malformed-json verdict table', () => {
  it.each(rows)('%s', (_label, observation, expected) => {
    expect(classifyMalformedJson({ ...base, ...observation })).toEqual(expected);
  });

  it('is what classifyInjected gives for the malformed-json kind', () => {
    for (const [, observation] of rows) {
      expect(classifyInjected({ ...base, ...observation })).toEqual(classifyMalformedJson({ ...base, ...observation }));
    }
  });

  it('never calls a site that did not parse the body handled', () => {
    for (const testOutcome of ['passed', 'failed'] as const) {
      for (const errorEscaped of [true, false]) {
        for (const jsonParsed of [false, null]) {
          expect(classifyMalformedJson({ ...base, testOutcome, errorEscaped, jsonParsed }).verdict).toBe('inconclusive');
        }
      }
    }
  });
});
