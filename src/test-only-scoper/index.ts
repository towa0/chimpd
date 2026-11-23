import fs from 'node:fs';
import path from 'node:path';
import { priorOf, seededOrder, type MutantRecord, type ScopeRange } from '../core/index.js';
import { createModuleGraph, type ModuleGraph } from './import-graph.js';

export { createModuleGraph } from './import-graph.js';
export type { ModuleGraph, ModuleInfo } from './import-graph.js';

export interface BoundaryOptions {
  readonly targetRoot: string;
  /** Repo-relative paths of the changed test files. */
  readonly changedTestFiles: readonly string[];
  readonly depth: number;
  readonly fileCap: number;
  readonly tsconfigFile?: string;
  /** Picks among files of equal distance and prior when the file cap forces a choice. */
  readonly seed?: number;
}

export interface BoundaryFile {
  readonly file: string;
  /** Import steps from the nearest changed test, not counting barrels. */
  readonly distance: number;
}

export interface MockedModule {
  readonly testFile: string;
  readonly file: string;
}

export interface Boundary {
  /** Source files to mutate whole: closest to a changed test first, then most sensitive, then by the seed or path. */
  readonly files: readonly BoundaryFile[];
  /** Files that were reachable but dropped by the file cap. */
  readonly truncated: number;
  /** Modules left out because the test that imports them replaces them with vi.mock. */
  readonly mocked: readonly MockedModule[];
  readonly sourceRoot: string;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function reachFromTest(graph: ModuleGraph, testFile: string, depth: number, mockedOut: Set<string>): Map<string, number> {
  const mocks = new Set(graph.info(testFile).mocks);
  const distances = new Map<string, number>();
  const expanded = new Map<string, number>();

  const expand = (file: string, distance: number): void => {
    const seenAt = expanded.get(file);
    if (seenAt !== undefined && seenAt <= distance) return;
    expanded.set(file, distance);

    for (const imported of graph.info(file).imports) {
      if (mocks.has(imported)) {
        if (graph.isSource(imported)) mockedOut.add(imported);
        continue;
      }
      if (!graph.isSource(imported)) continue;
      if (graph.info(imported).isBarrel) {
        expand(imported, distance);
        continue;
      }
      const next = distance + 1;
      if (next > depth) continue;
      if ((distances.get(imported) ?? Infinity) > next) distances.set(imported, next);
      expand(imported, next);
    }
  };

  expand(path.resolve(testFile), 0);
  return distances;
}

export function computeBoundary(options: BoundaryOptions): Boundary {
  const graph = createModuleGraph(options.targetRoot, options.tsconfigFile);
  const nearest = new Map<string, number>();
  const mocked: MockedModule[] = [];

  for (const testFile of [...options.changedTestFiles].sort()) {
    const mockedOut = new Set<string>();
    const reached = reachFromTest(graph, path.join(options.targetRoot, testFile), options.depth, mockedOut);
    for (const [file, distance] of reached) {
      if ((nearest.get(file) ?? Infinity) > distance) nearest.set(file, distance);
    }
    for (const file of mockedOut) mocked.push({ testFile, file: graph.relative(file) });
  }

  const tieBreak = seededOrder(options.seed);
  const ordered = [...nearest]
    .map(([file, distance]) => ({ file: graph.relative(file), distance }))
    .sort((a, b) => a.distance - b.distance || priorOf(b.file) - priorOf(a.file) || tieBreak(a.file, b.file));

  return {
    files: ordered.slice(0, options.fileCap),
    truncated: Math.max(0, ordered.length - options.fileCap),
    mocked: mocked.sort((a, b) => compareText(a.testFile, b.testFile) || compareText(a.file, b.file)),
    sourceRoot: graph.relative(graph.sourceRoot) || '.',
  };
}

/** Whole-file mutate targets for the boundary. */
export function boundaryRanges(targetRoot: string, boundary: Boundary): ScopeRange[] {
  return boundary.files.map(({ file }) => {
    const lines = fs.readFileSync(path.join(targetRoot, file), 'utf8').split('\n').length;
    return { file, startLine: 1, endLine: lines, kind: 'test-boundary', staticRegion: false };
  });
}

export interface TestRef {
  readonly id: string;
  readonly file: string;
}

export interface TestFileCoverage {
  readonly testFile: string;
  readonly covered: number;
  readonly killed: number;
}

export interface TestOnlyReport {
  /** Diff-scoped mutants, plus boundary mutants that a changed test covers. */
  readonly mutants: readonly MutantRecord[];
  /** Boundary mutants dropped because no changed test covers them. */
  readonly droppedUncovered: number;
  readonly perTestFile: readonly TestFileCoverage[];
  readonly total: { readonly covered: number; readonly killed: number; readonly notTested: number };
  /** Mutants a changed test executes that survived the run. */
  readonly coveredNotKilled: readonly MutantRecord[];
}

export function summarizeTestOnly(
  mutants: readonly MutantRecord[],
  tests: readonly TestRef[],
  changedTestFiles: readonly string[],
): TestOnlyReport {
  const changed = new Set(changedTestFiles);
  const fileOf = new Map(tests.map((test) => [test.id, test.file]));
  const testFile = (id: string): string => fileOf.get(id) ?? id.split('#')[0] ?? id;
  const changedFilesOf = (ids: readonly string[]): Set<string> =>
    new Set(ids.map(testFile).filter((file) => changed.has(file)));

  const kept: MutantRecord[] = [];
  const covered = new Map<string, number>([...changed].map((file) => [file, 0]));
  const killed = new Map<string, number>([...changed].map((file) => [file, 0]));
  const coveredNotKilled: MutantRecord[] = [];
  let droppedUncovered = 0;
  let totalCovered = 0;
  let totalKilled = 0;
  let notTested = 0;

  for (const mutant of mutants) {
    const coveringFiles = changedFilesOf(mutant.coveredBy);
    if (coveringFiles.size === 0) {
      if (mutant.scopeKind === 'test-boundary') droppedUncovered += 1;
      else kept.push(mutant);
      continue;
    }
    kept.push(mutant);
    totalCovered += 1;
    for (const file of coveringFiles) covered.set(file, (covered.get(file) ?? 0) + 1);

    const killingFiles = mutant.status === 'Killed' ? changedFilesOf(mutant.killedBy) : new Set<string>();
    if (killingFiles.size > 0) totalKilled += 1;
    for (const file of killingFiles) killed.set(file, (killed.get(file) ?? 0) + 1);

    if (mutant.status === 'Survived') coveredNotKilled.push(mutant);
    if (mutant.status === 'NotTested') notTested += 1;
  }

  return {
    mutants: kept,
    droppedUncovered,
    perTestFile: [...changed].sort().map((file) => ({
      testFile: file,
      covered: covered.get(file) ?? 0,
      killed: killed.get(file) ?? 0,
    })),
    total: { covered: totalCovered, killed: totalKilled, notTested },
    coveredNotKilled,
  };
}
