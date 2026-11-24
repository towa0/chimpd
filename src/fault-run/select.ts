import { seededOrder, type Preset, type ScopeRange } from '../core/index.js';
import { scopedFrame, type ProjectFrame } from '../fault-recon/call-site.js';
import type { CallSite, ReachingTest, SkippedCallSite } from './types.js';

/** The scope range that makes a call eligible: the one around the innermost project frame that lies in any range. */
export function scopeOf(frames: readonly ProjectFrame[], ranges: readonly ScopeRange[]): ScopeRange | null {
  return scopedFrame(frames, ranges)?.range ?? null;
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

function testId(entry: ReachingTest): string {
  return `${entry.test.file}\0${entry.test.name}`;
}

/**
 * The cheapest tests, except that a test through a changed caller no picked test goes through comes
 * before a cheaper one through callers already covered, so a shared wrapper is faulted from each caller the cap allows.
 */
function pickTests(cheapestFirst: readonly ReachingTest[], limit: number): ReachingTest[] {
  const picked = new Set<ReachingTest>();
  const covered = new Set<string>();
  for (const entry of cheapestFirst) {
    if (picked.size >= limit) break;
    if (!entry.reachedFrom.some((caller) => !covered.has(caller))) continue;
    picked.add(entry);
    for (const caller of entry.reachedFrom) covered.add(caller);
  }
  for (const entry of cheapestFirst) {
    if (picked.size >= limit) break;
    picked.add(entry);
  }
  return cheapestFirst.filter((entry) => picked.has(entry));
}

/** Without a seed, ties fall back to key order for sites and to file, then name, for tests. */
export function selectCallSites(sites: readonly CallSite[], limits: SelectionLimits, seed?: number): Selection {
  const tieBreak = seededOrder(seed);
  const bySeverity = (a: CallSite, b: CallSite): number => b.prior - a.prior || tieBreak(a.key, b.key);
  const byCost = (a: ReachingTest, b: ReachingTest): number => a.durationMs - b.durationMs || tieBreak(testId(a), testId(b));
  const unattributable: CallSite[] = [];
  const skipped: SkippedCallSite[] = [];
  const reachable: CallSite[] = [];
  for (const site of sites.toSorted(bySeverity)) {
    if (site.reachedBy.length > 0) reachable.push(site);
    else if (site.unattributedCalls > 0) unattributable.push(site);
    else skipped.push({ site, kind: null, reason: 'no-passing-test' });
  }

  const planned = reachable.slice(0, limits.maxFaultedCallSites).map((site) => ({
    site,
    tests: pickTests(site.reachedBy.toSorted(byCost), limits.testsPerCallSite),
  }));
  for (const site of reachable.slice(limits.maxFaultedCallSites)) skipped.push({ site, kind: null, reason: 'over-cap' });

  return { planned, unattributable, skipped };
}
