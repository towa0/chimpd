import { rangeForLine, type Preset, type ScopeRange } from '../core/index.js';
import type { ProjectFrame } from '../fault-recon/call-site.js';
import type { CallSite, ReachingTest, SkippedCallSite } from './types.js';

/** The scope range that makes a call site eligible, decided by its innermost project frame. */
export function scopeOf(frames: readonly ProjectFrame[], ranges: readonly ScopeRange[]): ScopeRange | null {
  const innermost = frames[0];
  return innermost === undefined ? null : rangeForLine(ranges, innermost.file, innermost.line);
}

export type SelectionLimits = Pick<Preset, 'maxFaultedCallSites' | 'testsPerCallSite'>;

export interface PlannedSite {
  readonly site: CallSite;
  readonly tests: readonly ReachingTest[];
}

export interface Selection {
  /** Most severe first. */
  readonly planned: readonly PlannedSite[];
  /** Sites whose every call happened outside a test body. */
  readonly unattributable: readonly CallSite[];
  readonly skipped: readonly SkippedCallSite[];
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function bySeverity(a: CallSite, b: CallSite): number {
  return b.prior - a.prior || compareText(a.key, b.key);
}

function byCost(a: ReachingTest, b: ReachingTest): number {
  return a.durationMs - b.durationMs || compareText(a.test.file, b.test.file) || compareText(a.test.name, b.test.name);
}

export function selectCallSites(sites: readonly CallSite[], limits: SelectionLimits): Selection {
  const unattributable: CallSite[] = [];
  const skipped: SkippedCallSite[] = [];
  const reachable: CallSite[] = [];
  for (const site of sites.toSorted(bySeverity)) {
    if (site.reachedBy.length > 0) reachable.push(site);
    else if (site.unattributedCalls > 0) unattributable.push(site);
    else skipped.push({ site, reason: 'no-passing-test' });
  }

  const planned = reachable.slice(0, limits.maxFaultedCallSites).map((site) => ({
    site,
    tests: site.reachedBy.toSorted(byCost).slice(0, limits.testsPerCallSite),
  }));
  for (const site of reachable.slice(limits.maxFaultedCallSites)) skipped.push({ site, reason: 'over-cap' });

  return { planned, unattributable, skipped };
}
