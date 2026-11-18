import type { BlackHoleVerdict, BlackHoleVerdictKind } from '../core/index.js';
import { classifyBlackHole } from '../verdict/index.js';
import type { TestFaultRun } from './faulted.js';
import type { CallSite, CallSiteResult, TestFaultResult } from './types.js';

const FINDINGS_BY_SEVERITY: readonly BlackHoleVerdictKind[] = [
  'hang',
  'timeout-mishandled',
  'long-timeout',
  'detached',
];

export function inconclusiveSite(site: CallSite, reason: string): CallSiteResult {
  return { site, verdict: 'inconclusive', findingKind: null, reason, tests: [] };
}

/**
 * One verdict for a call site from every test that ran against it. A finding outranks everything;
 * without one, a single test that produced no usable observation keeps the site from being handled.
 */
export function combineSite(site: CallSite, runs: readonly TestFaultRun[]): CallSiteResult {
  const tests: TestFaultResult[] = runs.map((run) => ({
    test: run.test,
    problem: run.problem,
    observations: run.observations.map((observation) => ({ observation, verdict: classifyBlackHole(observation) })),
  }));
  const verdicts: BlackHoleVerdict[] = tests.flatMap((test) => test.observations.map(({ verdict }) => verdict));

  for (const kind of FINDINGS_BY_SEVERITY) {
    const finding = verdicts.find((verdict) => verdict.verdict === kind);
    if (finding !== undefined) {
      return { site, verdict: kind, findingKind: finding.findingKind, reason: finding.reason, tests };
    }
  }

  const problem = tests.find((test) => test.problem !== null)?.problem;
  const undecided = verdicts.find((verdict) => verdict.verdict === 'inconclusive')?.reason;
  const missing = verdicts.length === 0 ? 'no test produced an observation for this site' : undefined;
  const reason = problem ?? undecided ?? missing;
  if (reason !== undefined) return { site, verdict: 'inconclusive', findingKind: null, reason, tests };

  return {
    site,
    verdict: 'handled-timeout',
    findingKind: null,
    reason: 'every held request was aborted and its test passed',
    tests,
  };
}
