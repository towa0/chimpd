import { describe, expect, it } from 'vitest';
import type { InjectedObservation, InjectedVerdict, ResponseUse } from '../../src/core/index.js';
import { classifyInjected, classifyServerError } from '../../src/verdict/index.js';

const checked: ResponseUse = { statusRead: true, bodyConsumed: false, bodyBeforeStatus: false };

const base: InjectedObservation = {
  kind: 'http-500',
  attempts: 1,
  errorReachedCaller: true,
  testOutcome: 'passed',
  errorEscaped: false,
  response: checked,
  jsonParsed: null,
};

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
    'body consumed without a status check, test passed',
    { response: { statusRead: false, bodyConsumed: true, bodyBeforeStatus: true } },
    {
      verdict: 'status-ignored',
      findingKind: 'error-status-ignored',
      reason: 'the code consumed the body of the 500 response before checking res.ok or res.status',
    },
  ],
  [
    'body consumed first and the status read later, test failed',
    { response: { statusRead: true, bodyConsumed: true, bodyBeforeStatus: true }, testOutcome: 'failed' },
    {
      verdict: 'status-ignored',
      findingKind: 'error-status-ignored',
      reason: 'the code consumed the body of the 500 response before checking res.ok or res.status',
    },
  ],
  [
    'body consumed without a status check and an error escaped',
    { response: { statusRead: false, bodyConsumed: true, bodyBeforeStatus: true }, errorEscaped: true },
    {
      verdict: 'status-ignored',
      findingKind: 'error-status-ignored',
      reason: 'the code consumed the body of the 500 response before checking res.ok or res.status',
    },
  ],
  [
    'status checked, test failed',
    { testOutcome: 'failed' },
    {
      verdict: 'status-mishandled',
      findingKind: 'error-status-mishandled',
      reason: 'the code checked the status of the 500 response, but the test failed',
    },
  ],
  [
    'status checked, an error escaped',
    { errorEscaped: true },
    {
      verdict: 'status-mishandled',
      findingKind: 'error-status-mishandled',
      reason: 'an unhandled rejection or error event escaped after the 500 response',
    },
  ],
  [
    'response not used, test failed',
    { response: { statusRead: false, bodyConsumed: false, bodyBeforeStatus: false }, testOutcome: 'failed' },
    { verdict: 'status-mishandled', findingKind: 'error-status-mishandled', reason: 'the test failed after the 500 response' },
  ],
  [
    'response not used, test passed',
    { response: { statusRead: false, bodyConsumed: false, bodyBeforeStatus: false } },
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
    const response: ResponseUse = { statusRead: false, bodyConsumed: true, bodyBeforeStatus: true };
    for (const testOutcome of ['passed', 'failed'] as const) {
      for (const errorEscaped of [true, false]) {
        expect(classifyServerError({ ...base, response, testOutcome, errorEscaped }).findingKind).toBe('error-status-ignored');
      }
    }
  });
});
