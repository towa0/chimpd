import { describe, expect, it } from 'vitest';
import type { BlackHoleObservation } from '../../src/core/index.js';
import { combineSite, inconclusiveSite } from '../../src/fault-run/combine.js';
import type { TestFaultRun } from '../../src/fault-run/faulted.js';
import type { CallSite } from '../../src/fault-run/types.js';

const site: CallSite = {
  key: 'src/a.ts:3:10',
  file: 'src/a.ts',
  line: 3,
  column: 10,
  functionName: 'call',
  path: 'fetch',
  frames: [{ file: 'src/a.ts', line: 3, column: 10, functionName: 'call' }],
  scopeKind: 'changed',
  prior: 0,
  reachedBy: [],
  unattributedCalls: 0,
};

const handled: BlackHoleObservation = {
  metadataCaptured: true,
  signalAttached: true,
  signalDeadlineMs: 100,
  socketTimeoutMs: null,
  requestState: 'aborted',
  firedMechanism: 'signal',
  abortKind: 'timeout',
  testOutcome: 'passed',
  errorEscaped: false,
  deadlineHit: false,
};
const mishandled: BlackHoleObservation = { ...handled, testOutcome: 'failed' };
const pending: BlackHoleObservation = {
  ...handled,
  signalAttached: false,
  signalDeadlineMs: null,
  requestState: 'pending',
  firedMechanism: null,
  abortKind: null,
};
const hang: BlackHoleObservation = { ...pending, deadlineHit: true, testOutcome: 'failed' };
const longTimeout: BlackHoleObservation = { ...hang, signalAttached: true, signalDeadlineMs: 60_000 };
const detached: BlackHoleObservation = pending;
const undecided: BlackHoleObservation = { ...pending, testOutcome: 'failed' };

let nextTest = 0;
function ran(observations: readonly BlackHoleObservation[], problem: string | null = null): TestFaultRun {
  nextTest += 1;
  return { test: { id: `t${nextTest}`, file: 'test/a.test.ts', name: `test ${nextTest}` }, observations, problem };
}

describe('combineSite', () => {
  it.each([
    ['handled-timeout', [handled], null],
    ['timeout-mishandled', [mishandled], 'abort-mishandled'],
    ['hang', [hang], 'hang-no-timeout'],
    ['long-timeout', [longTimeout], 'timeout-exceeds-budget'],
    ['detached', [detached], 'fire-and-forget'],
    ['inconclusive', [undecided], null],
  ] as const)('gives %s for a single observation of that kind', (verdict, observations, findingKind) => {
    const result = combineSite(site, [ran(observations)]);
    expect(result).toMatchObject({ site, verdict, findingKind });
    expect(result.tests[0]?.observations[0]?.verdict.verdict).toBe(verdict);
  });

  it('is handled only when every observation of every test is handled', () => {
    expect(combineSite(site, [ran([handled, handled]), ran([handled])]).verdict).toBe('handled-timeout');
  });

  it('reports the most severe finding across tests', () => {
    expect(combineSite(site, [ran([handled]), ran([detached]), ran([mishandled])]).verdict).toBe('timeout-mishandled');
    expect(combineSite(site, [ran([detached]), ran([longTimeout]), ran([hang])]).verdict).toBe('hang');
  });

  it('keeps a finding when another test produced nothing usable', () => {
    const result = combineSite(site, [ran([], 'the test did not run under the fault'), ran([hang])]);
    expect(result.verdict).toBe('hang');
    expect(result.tests[0]?.problem).toBe('the test did not run under the fault');
  });

  it('is inconclusive, not handled, when one test has no observation', () => {
    const result = combineSite(site, [
      ran([handled]),
      ran([], 'the test did not reach the call site under the fault'),
    ]);
    expect(result).toMatchObject({
      verdict: 'inconclusive',
      findingKind: null,
      reason: 'the test did not reach the call site under the fault',
    });
  });

  it('is inconclusive, not handled, when the test process died mid-test', () => {
    const result = combineSite(site, [
      ran([handled]),
      ran([], 'the test process ended before the test body finished'),
    ]);
    expect(result.verdict).toBe('inconclusive');
    expect(result.reason).toBe('the test process ended before the test body finished');
  });

  it('is inconclusive, not handled, when an observation could not be classified', () => {
    expect(combineSite(site, [ran([handled, undecided])]).verdict).toBe('inconclusive');
  });

  it('is inconclusive when a test ran but observed nothing, or no test ran', () => {
    expect(combineSite(site, [ran([])]).verdict).toBe('inconclusive');
    expect(combineSite(site, [])).toMatchObject({
      verdict: 'inconclusive',
      reason: 'no test produced an observation for this site',
    });
  });

  it('builds an inconclusive result for a site that was never faulted', () => {
    expect(inconclusiveSite(site, 'why')).toEqual({
      site,
      verdict: 'inconclusive',
      findingKind: null,
      reason: 'why',
      tests: [],
    });
  });
});
