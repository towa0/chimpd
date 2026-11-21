import fs from 'node:fs';
import { PRESETS, realNow, startBudget, type Intensity, type ScopeRange } from '../core/index.js';
import { pristineFingerprints } from '../fault-recon/conflicts.js';
import type { VitestNodeModule } from '../fault-recon/index.js';
import { combineSite, inconclusiveSite } from './combine.js';
import { discoverCallSites } from './discover.js';
import { runFaultedSite } from './faulted.js';
import { selectCallSites } from './select.js';
import type { CallSiteResult, FaultRunResult, SkippedCallSite } from './types.js';

export interface FaultRunRequest {
  readonly targetRoot: string;
  readonly configFile: string;
  /** The diff scope; only calls made from inside it are faulted. */
  readonly ranges: readonly ScopeRange[];
  readonly intensity: Intensity;
  readonly budgetMs: number;
  /** How long a held request may stay pending before its test is released. */
  readonly testDeadlineMs?: number;
  readonly vitestNode: VitestNodeModule;
  readonly now?: () => number;
  /** Receives what the target's own tests write to stdout and stderr; it is discarded without one. */
  readonly onTargetOutput?: (text: string) => void;
}

export const DEFAULT_TEST_DEADLINE_MS = 2000;

const OUTSIDE_TEST_BODY = 'every call to this site was made outside a test body, at import time or from a hook';

export async function runFaults(request: FaultRunRequest): Promise<FaultRunResult> {
  const budget = startBudget(request.budgetMs, request.now ?? realNow);
  const deadlineMs = request.testDeadlineMs ?? DEFAULT_TEST_DEADLINE_MS;
  const targetRoot = fs.realpathSync.native(request.targetRoot);
  const pristine = await pristineFingerprints(targetRoot);
  const shared = {
    targetRoot,
    configFile: request.configFile,
    vitestNode: request.vitestNode,
    pristine,
    ...(request.onTargetOutput === undefined ? {} : { onTargetOutput: request.onTargetOutput }),
  };

  const discovery = await discoverCallSites({ ...shared, ranges: request.ranges, timeoutMs: budget.remainingMs() });
  const { conflicts, outOfScopeSites } = discovery;
  if (discovery.status === 'inconclusive') {
    return {
      status: discovery.budgetExhausted ? 'budget-exhausted' : 'inconclusive',
      statusReason: discovery.statusReason,
      results: [],
      skipped: [],
      conflicts,
      outOfScopeSites,
      spentMs: budget.spentMs(),
    };
  }

  const selection = selectCallSites(discovery.sites, PRESETS[request.intensity]);
  const results: CallSiteResult[] = [];
  const skipped: SkippedCallSite[] = [...selection.skipped];
  let outOfBudget = false;

  for (const { site, tests } of selection.planned) {
    const remainingMs = budget.remainingMs();
    const neededMs = tests.reduce((total, test) => total + test.durationMs, 0) + deadlineMs;
    if (outOfBudget || remainingMs < neededMs) {
      outOfBudget = true;
      skipped.push({ site, reason: 'budget' });
      continue;
    }
    const run = await runFaultedSite({ ...shared, site, tests, deadlineMs, timeoutMs: remainingMs });
    if (run.killed) {
      outOfBudget = true;
      skipped.push({ site, reason: 'budget' });
    } else {
      results.push(combineSite(site, run.tests));
    }
  }
  for (const site of selection.unattributable) results.push(inconclusiveSite(site, OUTSIDE_TEST_BODY));

  return {
    status: outOfBudget ? 'budget-exhausted' : 'completed',
    statusReason: outOfBudget ? 'the budget ran out before every call site was faulted' : null,
    results,
    skipped,
    conflicts,
    outOfScopeSites,
    spentMs: budget.spentMs(),
  };
}
