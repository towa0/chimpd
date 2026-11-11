import type { ScopeKind, ScopeRange } from './types.js';

export interface LineInterval {
  readonly startLine: number;
  readonly endLine: number;
}

const KIND_RANK: Record<ScopeKind, number> = {
  changed: 0,
  'enclosing-function': 1,
  'deletion-expanded': 2,
  'test-boundary': 3,
};

/** Unions the ranges of each file into disjoint intervals, so no line is listed twice. */
export function mergeRangesByFile(ranges: readonly ScopeRange[]): Map<string, LineInterval[]> {
  const byFile = new Map<string, ScopeRange[]>();
  for (const range of ranges) {
    const list = byFile.get(range.file) ?? [];
    list.push(range);
    byFile.set(range.file, list);
  }

  const merged = new Map<string, LineInterval[]>();
  for (const file of [...byFile.keys()].sort()) {
    const intervals: { startLine: number; endLine: number }[] = [];
    const sorted = (byFile.get(file) ?? []).toSorted((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);
    for (const range of sorted) {
      const last = intervals.at(-1);
      if (last !== undefined && range.startLine <= last.endLine + 1) {
        last.endLine = Math.max(last.endLine, range.endLine);
      } else {
        intervals.push({ startLine: range.startLine, endLine: range.endLine });
      }
    }
    merged.set(file, intervals);
  }
  return merged;
}

/** The narrowest range containing the line: changed before enclosing-function before deletion-expanded. */
export function rangeForLine(ranges: readonly ScopeRange[], file: string, line: number): ScopeRange | null {
  let best: ScopeRange | null = null;
  for (const range of ranges) {
    if (range.file !== file || line < range.startLine || line > range.endLine) continue;
    if (best === null) {
      best = range;
      continue;
    }
    const byKind = KIND_RANK[range.kind] - KIND_RANK[best.kind];
    const bySize = range.endLine - range.startLine - (best.endLine - best.startLine);
    if (byKind < 0 || (byKind === 0 && (bySize < 0 || (bySize === 0 && range.startLine < best.startLine)))) {
      best = range;
    }
  }
  return best;
}

export function countLines(intervals: readonly LineInterval[]): number {
  return intervals.reduce((total, interval) => total + interval.endLine - interval.startLine + 1, 0);
}
