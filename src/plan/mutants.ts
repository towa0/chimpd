import { Instrumenter } from '@stryker-mutator/instrumenter';
import fs from 'node:fs';
import path from 'node:path';
import {
  excludedMutators,
  firstErrorLine,
  mergeRangesByFile,
  PRESETS,
  rangeForLine,
  type Intensity,
  type ScopeRange,
} from '../core/index.js';

export interface MutantCountRequest {
  readonly targetRoot: string;
  readonly ranges: readonly ScopeRange[];
  readonly intensity: Intensity;
}

export interface MutantCount {
  /** Repo-relative path with forward slashes. */
  readonly file: string;
  /** null when the count is unavailable; the reason says why. */
  readonly mutants: number | null;
  /** Mutants in module-level code, which Stryker may only judge static after a test run. */
  readonly moduleLevel: number | null;
  readonly reason: string | null;
}

type Logger = ConstructorParameters<typeof Instrumenter>[0];

const SILENT: Logger = {
  isTraceEnabled: () => false,
  isDebugEnabled: () => false,
  isInfoEnabled: () => false,
  isWarnEnabled: () => false,
  isErrorEnabled: () => false,
  isFatalEnabled: () => false,
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  fatal: () => undefined,
};

function messageOf(error: unknown): string {
  return firstErrorLine(error instanceof Error ? error.message : String(error)) ?? 'no error reported';
}

/**
 * Generates the mutants Stryker would test in each scoped file, in memory: no test runs and no file
 * is written. Mutants of the preset's excluded mutators, and mutants Stryker ignores, are not counted.
 */
export async function countMutants(request: MutantCountRequest): Promise<MutantCount[]> {
  const excludedMutations = excludedMutators(PRESETS[request.intensity]);
  const instrumenter = new Instrumenter(SILENT);
  const counts: MutantCount[] = [];
  for (const [file, intervals] of mergeRangesByFile(request.ranges)) {
    const name = path.join(request.targetRoot, file);
    try {
      const content = fs.readFileSync(name, 'utf8');
      // Stryker's own ranges are zero-based lines; a range of whole lines ends at the largest column.
      const mutate = intervals.map((interval) => ({
        start: { line: interval.startLine - 1, column: 0 },
        end: { line: interval.endLine - 1, column: Number.MAX_SAFE_INTEGER },
      }));
      const { mutants } = await instrumenter.instrument([{ name, mutate, content }], {
        plugins: null,
        excludedMutations,
        ignorers: [],
      });
      let total = 0;
      let moduleLevel = 0;
      for (const mutant of mutants) {
        if (mutant.status === 'Ignored') continue;
        const range = rangeForLine(request.ranges, file, mutant.location.start.line + 1);
        if (range === null) continue;
        total += 1;
        if (range.staticRegion) moduleLevel += 1;
      }
      counts.push({ file, mutants: total, moduleLevel, reason: null });
    } catch (error) {
      counts.push({ file, mutants: null, moduleLevel: null, reason: `count unavailable: ${messageOf(error)}` });
    }
  }
  return counts;
}
