import { describe, expect, it } from 'vitest';
import type { InjectedObservation, InjectedVerdict } from '../../src/core/index.js';
import { classifyInjected, classifyMalformedJson } from '../../src/verdict/index.js';
import { FAILURE_KINDS, failureOf } from '../helpers/failure-evidence.js';

const base: InjectedObservation = {
  kind: 'malformed-json',
  attempts: 1,
  errorReachedCaller: true,
  testOutcome: 'passed',
  failure: null,
  response: { statusRead: false, bodyConsumed: true, bodyBeforeStatus: true },
  jsonParsed: true,
};

const PARSE_ERROR = "SyntaxError: Expected ',' or '}' after property value in JSON at position 25";

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
    'the parse error failed the test',
    { testOutcome: 'failed', failure: failureOf('fault-escaped', PARSE_ERROR) },
    {
      verdict: 'parse-mishandled',
      findingKind: 'malformed-json-mishandled',
      reason: `the JSON parse error escaped the code and failed the test: ${PARSE_ERROR}`,
    },
  ],
  [
    'the parse error escaped as an unhandled rejection while the test passed',
    { failure: failureOf('fault-escaped', PARSE_ERROR, { via: 'unhandled' }) },
    {
      verdict: 'parse-mishandled',
      findingKind: 'malformed-json-mishandled',
      reason: `the JSON parse error escaped as an unhandled rejection or error event: ${PARSE_ERROR}`,
    },
  ],
  [
    'caught with a fallback, then the test failed on its own assertion',
    { testOutcome: 'failed', failure: failureOf('raised-by-test', 'AssertionError: expected null to deeply equal { rate: 1.5 }') },
    {
      verdict: 'parse-handled',
      findingKind: null,
      reason: 'the JSON parse error did not escape; the test failed on its own check: AssertionError: expected null to deeply equal { rate: 1.5 }',
    },
  ],
  [
    'caught and raised again as the code\'s own error',
    { testOutcome: 'failed', failure: failureOf('raised-by-project', 'Error: bad payload') },
    {
      verdict: 'parse-handled',
      findingKind: null,
      reason: 'the JSON parse error did not escape; the code raised its own error at src/rates.ts:7: Error: bad payload',
    },
  ],
  [
    'the test failed on an error that cannot be attributed',
    { testOutcome: 'failed', failure: failureOf('unattributed', 'Error: Test timed out in 5000ms.') },
    {
      verdict: 'inconclusive',
      findingKind: null,
      reason: 'the test failed on an error that is neither the JSON parse error nor raised by project or test code: Error: Test timed out in 5000ms.',
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
    { jsonParsed: false, testOutcome: 'failed', failure: failureOf('raised-by-test', 'AssertionError: expected 1 to be 2') },
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
    for (const kind of FAILURE_KINDS) {
      for (const jsonParsed of [false, null]) {
        const failure = kind === null ? null : failureOf(kind, PARSE_ERROR);
        expect(classifyMalformedJson({ ...base, failure, jsonParsed }).verdict).toBe('inconclusive');
      }
    }
  });

  it('calls a parse mishandled exactly when the parse error escaped', () => {
    for (const kind of FAILURE_KINDS) {
      const failure = kind === null ? null : failureOf(kind, PARSE_ERROR);
      expect(classifyMalformedJson({ ...base, failure }).findingKind !== null).toBe(kind === 'fault-escaped');
    }
  });
});
