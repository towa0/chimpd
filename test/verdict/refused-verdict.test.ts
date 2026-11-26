import { describe, expect, it } from 'vitest';
import type { FailureEvidence, FailureKind, InjectedObservation, InjectedVerdict } from '../../src/core/index.js';
import { classifyInjected, classifyRefused } from '../../src/verdict/index.js';

const base: InjectedObservation = {
  kind: 'connection-refused',
  attempts: 1,
  errorReachedCaller: true,
  testOutcome: 'passed',
  failure: null,
  response: null,
  jsonParsed: null,
};

const escaped: FailureEvidence = { kind: 'fault-escaped', via: 'test', error: 'TypeError: fetch failed', raisedAt: null };
const escapedUnhandled: FailureEvidence = { ...escaped, via: 'unhandled' };
const assertion: FailureEvidence = { kind: 'raised-by-test', via: 'test', error: 'AssertionError: expected 1 to be 1.5', raisedAt: null };
const ownError: FailureEvidence = { kind: 'raised-by-project', via: 'test', error: 'Error: rates unavailable', raisedAt: 'src/rates.ts:7' };
const unknown: FailureEvidence = { kind: 'unattributed', via: 'test', error: 'Error: Test timed out in 5000ms.', raisedAt: null };

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
    'the refusal failed the test',
    { testOutcome: 'failed', failure: escaped },
    {
      verdict: 'refusal-mishandled',
      findingKind: 'refusal-mishandled',
      reason: "the refused connection's error escaped the code and failed the test: TypeError: fetch failed",
    },
  ],
  [
    'the refusal failed the test after two attempts',
    { attempts: 2, testOutcome: 'failed', failure: escaped },
    {
      verdict: 'refusal-mishandled',
      findingKind: 'refusal-mishandled',
      reason: "the refused connection's error escaped the code and failed the test: TypeError: fetch failed (refused 2 times)",
    },
  ],
  [
    'the refusal escaped as an unhandled rejection while the test passed',
    { failure: escapedUnhandled },
    {
      verdict: 'refusal-mishandled',
      findingKind: 'refusal-mishandled',
      reason: "the refused connection's error escaped as an unhandled rejection or error event: TypeError: fetch failed",
    },
  ],
  [
    'caught with a fallback, then the test failed on its own assertion',
    { testOutcome: 'failed', failure: assertion },
    {
      verdict: 'refusal-handled',
      findingKind: null,
      reason: 'the refused connection did not escape; the test failed on its own check: AssertionError: expected 1 to be 1.5',
    },
  ],
  [
    'caught and raised again as the code\'s own error',
    { testOutcome: 'failed', failure: ownError },
    {
      verdict: 'refusal-handled',
      findingKind: null,
      reason: 'the refused connection did not escape; the code raised its own error at src/rates.ts:7: Error: rates unavailable',
    },
  ],
  [
    'the test failed on an error that cannot be attributed',
    { testOutcome: 'failed', failure: unknown },
    {
      verdict: 'inconclusive',
      findingKind: null,
      reason:
        'the test failed on an error that is neither the refused connection nor raised by project or test code: Error: Test timed out in 5000ms.',
    },
  ],
  [
    'refused, no error listener on the request',
    { errorReachedCaller: false, failure: escapedUnhandled },
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

  it('calls a refusal mishandled exactly when its error escaped or never reached the caller', () => {
    const kinds: (FailureKind | null)[] = [null, 'fault-escaped', 'raised-by-project', 'raised-by-test', 'unattributed'];
    for (const kind of kinds) {
      for (const errorReachedCaller of [true, false]) {
        for (const attempts of [1, 4]) {
          const failure = kind === null ? null : { ...escaped, kind };
          const { findingKind } = classifyRefused({ ...base, failure, errorReachedCaller, attempts });
          expect(findingKind === 'refusal-mishandled').toBe(kind === 'fault-escaped' || !errorReachedCaller);
        }
      }
    }
  });
});
