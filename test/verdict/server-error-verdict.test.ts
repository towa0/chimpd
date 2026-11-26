import { describe, expect, it } from 'vitest';
import type { InjectedObservation, InjectedVerdict, ResponseUse } from '../../src/core/index.js';
import { classifyInjected, classifyServerError } from '../../src/verdict/index.js';
import { FAILURE_KINDS, failureOf } from '../helpers/failure-evidence.js';

const checked: ResponseUse = { statusRead: true, bodyConsumed: false, bodyBeforeStatus: false };
const unused: ResponseUse = { statusRead: false, bodyConsumed: false, bodyBeforeStatus: false };
const bodyFirst: ResponseUse = { statusRead: false, bodyConsumed: true, bodyBeforeStatus: true };

const base: InjectedObservation = {
  kind: 'http-500',
  attempts: 1,
  errorReachedCaller: true,
  testOutcome: 'passed',
  failure: null,
  response: checked,
  jsonParsed: null,
};

const ownError = failureOf('raised-by-project', 'Error: rate request failed with 500');
const assertion = failureOf('raised-by-test', 'AssertionError: expected 0 to be 200');
const PARSE_ERROR = 'SyntaxError: Unexpected token \'I\', "Internal S"... is not valid JSON';

type Row = [string, Partial<InjectedObservation>, InjectedVerdict];

const rows: Row[] = [
  [
    'status checked, test passed',
    {},
    { verdict: 'status-checked', findingKind: null, reason: 'the code checked the status of the 500 response and the test passed' },
  ],
  [
    'status checked on each of 3 attempts, test passed',
    { attempts: 3 },
    {
      verdict: 'status-checked',
      findingKind: null,
      reason: 'the code checked the status of the 500 response after 3 attempts and the test passed',
    },
  ],
  [
    'status checked before the body was read, test passed',
    { response: { statusRead: true, bodyConsumed: true, bodyBeforeStatus: false } },
    { verdict: 'status-checked', findingKind: null, reason: 'the code checked the status of the 500 response and the test passed' },
  ],
  [
    'status checked, then the code raised its own error and failed the test',
    { testOutcome: 'failed', failure: ownError },
    {
      verdict: 'status-checked',
      findingKind: null,
      reason: 'the code checked the status of the 500 response; the code raised its own error at src/rates.ts:7: Error: rate request failed with 500',
    },
  ],
  [
    'status checked, then the test failed on its own assertion',
    { testOutcome: 'failed', failure: assertion },
    {
      verdict: 'status-checked',
      findingKind: null,
      reason: 'the code checked the status of the 500 response; the test failed on its own check: AssertionError: expected 0 to be 200',
    },
  ],
  [
    'status read, then the 500 body parsed as JSON and its parse error failed the test',
    { testOutcome: 'failed', response: { statusRead: true, bodyConsumed: true, bodyBeforeStatus: false }, failure: failureOf('fault-escaped', PARSE_ERROR) },
    {
      verdict: 'status-mishandled',
      findingKind: 'error-status-mishandled',
      reason: `the error from parsing the body of the 500 response as JSON escaped the code and failed the test: ${PARSE_ERROR}`,
    },
  ],
  [
    'status checked, the test failed on an error that cannot be attributed',
    { testOutcome: 'failed', failure: failureOf('unattributed', 'Error: Test timed out in 5000ms.') },
    {
      verdict: 'inconclusive',
      findingKind: null,
      reason:
        'the test failed on an error that is neither an error from the 500 response nor raised by project or test code: Error: Test timed out in 5000ms.',
    },
  ],
  [
    'body consumed without a status check, test passed',
    { response: bodyFirst },
    {
      verdict: 'status-ignored',
      findingKind: 'error-status-ignored',
      reason: 'the code consumed the body of the 500 response before checking res.ok or res.status',
    },
  ],
  [
    'body consumed first and the status read later, test failed',
    { response: { statusRead: true, bodyConsumed: true, bodyBeforeStatus: true }, testOutcome: 'failed', failure: assertion },
    {
      verdict: 'status-ignored',
      findingKind: 'error-status-ignored',
      reason: 'the code consumed the body of the 500 response before checking res.ok or res.status',
    },
  ],
  [
    'response not used, test failed on its own assertion',
    { response: unused, testOutcome: 'failed', failure: assertion },
    {
      verdict: 'response-unused',
      findingKind: null,
      reason: 'the code did not use the 500 response; the test failed on its own check: AssertionError: expected 0 to be 200',
    },
  ],
  [
    'response not used, test passed',
    { response: unused },
    { verdict: 'response-unused', findingKind: null, reason: 'the code did not use the 500 response and the test passed' },
  ],
  [
    'the response never reached the code',
    { response: null },
    {
      verdict: 'inconclusive',
      findingKind: null,
      reason: 'the 500 response never reached the code, so its use could not be observed',
    },
  ],
  [
    'no call got the response',
    { attempts: 0 },
    { verdict: 'inconclusive', findingKind: null, reason: 'no call to the site got the 500 response' },
  ],
];

describe('http-500 verdict table', () => {
  it.each(rows)('%s', (_label, observation, expected) => {
    expect(classifyServerError({ ...base, ...observation })).toEqual(expected);
  });

  it('is what classifyInjected gives for the http-500 kind', () => {
    for (const [, observation] of rows) {
      expect(classifyInjected({ ...base, ...observation })).toEqual(classifyServerError({ ...base, ...observation }));
    }
  });

  it('reports a body consumed before the status whatever the test did', () => {
    for (const kind of FAILURE_KINDS) {
      const failure = kind === null ? null : failureOf(kind, PARSE_ERROR);
      expect(classifyServerError({ ...base, response: bodyFirst, failure }).findingKind).toBe('error-status-ignored');
    }
  });

  it('calls a checked or unused response mishandled exactly when an error from the 500 body escaped', () => {
    for (const response of [checked, unused]) {
      for (const kind of FAILURE_KINDS) {
        const failure = kind === null ? null : failureOf(kind, PARSE_ERROR);
        expect(classifyServerError({ ...base, response, failure }).findingKind !== null).toBe(kind === 'fault-escaped');
      }
    }
  });
});
