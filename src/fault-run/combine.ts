import type { BlackHoleVerdict, BlackHoleVerdictKind, FaultKind, InjectedVerdict } from '../core/index.js';
import { classifyBlackHole, classifyInjected } from '../verdict/index.js';
import type { TestFaultRun } from './faulted.js';
import type { CallSite, CallSiteResult, TestFaultResult } from './types.js';

const FINDINGS_BY_SEVERITY: readonly BlackHoleVerdictKind[] = [
  'hang',
  'timeout-mishandled',
  'detached',
];

const HANDLED_REASONS: Readonly<Record<FaultKind, string>> = {
  blackhole: 'every held request was aborted and its test passed',
  'connection-refused': 'every test handled the refused connection',
  'http-500': 'every test handled the 500 response',
  'malformed-json': 'every test handled the malformed JSON body',
};

const NO_OBSERVATION = 'no test produced an observation for this site';

export function inconclusiveSite(site: CallSite, reason: string, kind: FaultKind = 'blackhole'): CallSiteResult {
  return { site, kind, verdict: 'inconclusive', findingKind: null, reason, tests: [] };
}

function combineBlackHole(site: CallSite, tests: readonly TestFaultResult[]): CallSiteResult {
  const verdicts: BlackHoleVerdict[] = tests.flatMap((test) => test.observations.map(({ verdict }) => verdict));
  for (const kind of FINDINGS_BY_SEVERITY) {
    const finding = verdicts.find((verdict) => verdict.verdict === kind);
    if (finding !== undefined) {
      return { site, kind: 'blackhole', verdict: kind, findingKind: finding.findingKind, reason: finding.reason, tests };
    }
  }
  const problem = tests.find((test) => test.problem !== null)?.problem;
  const undecided = verdicts.find((verdict) => verdict.verdict === 'inconclusive')?.reason;
  const missing = verdicts.length === 0 ? NO_OBSERVATION : undefined;
  const reason = problem ?? undecided ?? missing;
  if (reason !== undefined) return { site, kind: 'blackhole', verdict: 'inconclusive', findingKind: null, reason, tests };
  return { site, kind: 'blackhole', verdict: 'handled-timeout', findingKind: null, reason: HANDLED_REASONS.blackhole, tests };
}

function combineInjected(site: CallSite, kind: FaultKind, tests: readonly TestFaultResult[]): CallSiteResult {
  const verdicts: InjectedVerdict[] = tests.flatMap((test) => (test.injected === null ? [] : [test.injected.verdict]));
  const finding = verdicts.find((verdict) => verdict.findingKind !== null);
  if (finding !== undefined) return { site, kind, verdict: finding.verdict, findingKind: finding.findingKind, reason: finding.reason, tests };
  const problem = tests.find((test) => test.problem !== null)?.problem;
  const undecided = verdicts.find((verdict) => verdict.verdict === 'inconclusive')?.reason;
  const missing = verdicts.length === 0 || verdicts.length < tests.length ? NO_OBSERVATION : undefined;
  const reason = problem ?? undecided ?? missing;
  if (reason !== undefined) return { site, kind, verdict: 'inconclusive', findingKind: null, reason, tests };
  const handled = verdicts[0]?.verdict ?? 'inconclusive';
  const evidence = [...new Set(verdicts.map((verdict) => verdict.reason))];
  const [only] = evidence;
  const why = evidence.length === 1 && only !== undefined ? only : `${HANDLED_REASONS[kind]}: ${evidence.join('; ')}`;
  return { site, kind, verdict: handled, findingKind: null, reason: why, tests };
}

/**
 * One verdict for a site under one fault kind, from every test that ran against it. A finding
 * outranks everything; without one, a single test that produced no usable observation keeps the
 * site from being handled.
 */
export function combineSite(site: CallSite, runs: readonly TestFaultRun[], kind: FaultKind = 'blackhole'): CallSiteResult {
  const tests: TestFaultResult[] = runs.map((run) => ({
    test: run.test,
    problem: run.problem,
    observations: run.observations.map((observation) => ({ observation, verdict: classifyBlackHole(observation) })),
    injected: run.injected === null ? null : { observation: run.injected, verdict: classifyInjected(run.injected) },
  }));
  return kind === 'blackhole' ? combineBlackHole(site, tests) : combineInjected(site, kind, tests);
}
