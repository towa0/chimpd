import { countLines, mergeRangesByFile, type LineInterval, type ScopeRange } from '../core/index.js';
import { priorOf } from '../severity/index.js';

export interface BatchFile {
  readonly file: string;
  readonly intervals: readonly LineInterval[];
}

export interface Batch {
  readonly index: number;
  readonly files: readonly BatchFile[];
}

function linesOf(files: readonly BatchFile[]): number {
  return files.reduce((total, entry) => total + countLines(entry.intervals), 0);
}

/**
 * Orders files by severity prior, then path, and cuts that order into at most `maxBatches`
 * contiguous groups of roughly equal scoped line counts.
 */
export function planBatches(ranges: readonly ScopeRange[], maxBatches: number): Batch[] {
  const files: BatchFile[] = [...mergeRangesByFile(ranges)]
    .map(([file, intervals]) => ({ file, intervals }))
    .sort((a, b) => priorOf(b.file) - priorOf(a.file) || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));

  const batchCount = Math.min(maxBatches, files.length);
  const batches: Batch[] = [];
  let next = 0;
  for (let index = 0; index < batchCount; index += 1) {
    const remainingBatches = batchCount - index;
    const target = linesOf(files.slice(next)) / remainingBatches;
    const group: BatchFile[] = [];
    while (next < files.length && files.length - next > remainingBatches - 1) {
      const candidate = files[next];
      if (candidate === undefined) break;
      if (group.length > 0 && remainingBatches > 1 && linesOf(group) + countLines(candidate.intervals) / 2 > target) {
        break;
      }
      group.push(candidate);
      next += 1;
    }
    batches.push({ index, files: group });
  }
  return batches;
}

const GLOB_CHARACTERS = /[[\]{}()*?]/g;

// Stryker turns backslashes into slashes before matching, so a bracket class is the only escape that survives.
export function escapeGlob(file: string): string {
  return file.replace(GLOB_CHARACTERS, '[$&]');
}

export function mutatePatterns(batch: Batch): string[] {
  return batch.files.flatMap(({ file, intervals }) =>
    intervals.map((interval) => `${escapeGlob(file)}:${interval.startLine}-${interval.endLine}`),
  );
}
