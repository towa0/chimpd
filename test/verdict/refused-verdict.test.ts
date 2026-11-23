import { describe, expect, it } from 'vitest';
import type { InjectedObservation, InjectedVerdict } from '../../src/core/index.js';
import { classifyInjected, classifyRefused } from '../../src/verdict/index.js';

const base: InjectedObservation = {
  kind: 'connection-refused',
  attempts: 1,
  errorReachedCaller: true,
  testOutcome: 'passed',
  errorEscaped: false,
  response: null,
  jsonParsed: null,
};

type Row = [string, Partial<InjectedObservation>, InjectedVerdict];

const rows: Row[] = [
  [
    'refused once, error reached the caller, test passed',
    {},
    { verdict: 'refusal-handled', findingKind: null, reason: 'the caller handled the refused connection and the test passed' },
  ],
  [
    'refused three times, test passed',
    { attempts: 3 },
    {
      verdict: 'refusal-handled',
      findingKind: null,
      reason: 'the caller handled the refused connection after 3 attempts and the test passed',
    },
  ],
  [
    'refused, test failed',
    { testOutcome: 'failed' },
    { verdict: 'refusal-mishandled', findingKind: 'refusal-mishandled', reason: 'the test failed after the connection was refused' },
  ],
  [
    'refused twice, test failed',
    { attempts: 2, testOutcome: 'failed' },
    {
      verdict: 'refusal-mishandled',
      findingKind: 'refusal-mishandled',
      reason: 'the test failed after the connection was refused 2 times',
    },
  ],
  [
    'refused, test passed, an error escaped',
    { errorEscaped: true },
    {
      verdict: 'refusal-mishandled',
      findingKind: 'refusal-mishandled',
      reason: 'an unhandled rejection or error event escaped after the connection was refused',
    },
  ],
  [
    'refused, test failed and an error escaped: the escape is reported',
    { errorEscaped: true, testOutcome: 'failed' },
    {
      verdict: 'refusal-mishandled',
      findingKind: 'refusal-mishandled',
      reason: 'an unhandled rejection or error event escaped after the connection was refused',
    },
  ],
  [
    'refused, no error listener on the request',
    { errorReachedCaller: false, errorEscaped: true },
    {
      verdict: 'refusal-mishandled',
      findingKind: 'refusal-mishandled',
      reason: 'the request had no error listener, so the refusal never reached the caller',
    },
  ],
  [
    'no call was refused',
    { attempts: 0 },
    { verdict: 'inconclusive', findingKind: null, reason: 'no call to the site was refused' },
  ],
];

describe('connection-refused verdict table', () => {
  it.each(rows)('%s', (_label, observation, expected) => {
    expect(classifyRefused({ ...base, ...observation })).toEqual(expected);
  });

  it('is what classifyInjected gives for the connection-refused kind', () => {
    for (const [, observation] of rows) {
      expect(classifyInjected({ ...base, ...observation })).toEqual(classifyRefused({ ...base, ...observation }));
    }
  });

  it('never calls a refusal handled when the test failed or an error escaped', () => {
    for (const testOutcome of ['passed', 'failed'] as const) {
      for (const errorEscaped of [true, false]) {
        for (const errorReachedCaller of [true, false]) {
          for (const attempts of [1, 4]) {
            const { verdict } = classifyRefused({ ...base, testOutcome, errorEscaped, errorReachedCaller, attempts });
            const clean = testOutcome === 'passed' && !errorEscaped && errorReachedCaller;
            expect(verdict === 'refusal-handled').toBe(clean);
          }
        }
      }
    }
  });
});
