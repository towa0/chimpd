import fs from 'node:fs';
import path from 'node:path';
import { priorOf, toPosix, type ScopeRange } from '../core/index.js';
import { callSiteKey, projectFrames, type ProjectFrame } from '../fault-recon/call-site.js';
import { pristineFingerprints, type Fingerprints } from '../fault-recon/conflicts.js';
import type { VitestNodeModule } from '../fault-recon/index.js';
import { runInstrumented, type TestRecord } from './instrumented.js';
import { scopeOf } from './select.js';
import type { CallSite, Discovery, FileConflict, ReachingTest } from './types.js';

export interface DiscoveryRequest {
  readonly targetRoot: string;
  readonly configFile: string;
  readonly ranges: readonly ScopeRange[];
  readonly vitestNode: VitestNodeModule;
  /** Taken from this process when omitted. */
  readonly pristine?: Fingerprints;
  readonly timeoutMs?: number;
}

// A call inside a callback, such as a Promise executor, is named after the function around it.
function enclosingFunctionName(frames: readonly ProjectFrame[]): string | null {
  const file = frames[0]?.file;
  return frames.find((frame) => frame.file === file && frame.functionName !== null)?.functionName ?? null;
}

interface SiteBuilder {
  readonly innermost: ProjectFrame;
  readonly functionName: string | null;
  readonly path: 'fetch' | 'http';
  readonly range: ScopeRange;
  readonly frames: Map<string, ProjectFrame>;
  readonly callsByTest: Map<string, number>;
  unattributedCalls: number;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const EMPTY: Discovery = {
  status: 'completed',
  statusReason: null,
  budgetExhausted: false,
  sites: [],
  outOfScopeSites: 0,
  conflicts: [],
};

export async function discoverCallSites(request: DiscoveryRequest): Promise<Discovery> {
  const { ranges } = request;
  const targetRoot = fs.realpathSync.native(request.targetRoot);
  const scopedFiles = [...new Set(ranges.map((range) => range.file))];
  if (scopedFiles.length === 0) return EMPTY;

  const run = await runInstrumented({
    targetRoot,
    configFile: request.configFile,
    vitestNode: request.vitestNode,
    pristine: request.pristine ?? (await pristineFingerprints()),
    mode: { kind: 'recon' },
    options: { related: scopedFiles.map((file) => path.join(targetRoot, file)), passWithNoTests: true },
    ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
  });
  if (run.killed) {
    return {
      ...EMPTY,
      status: 'inconclusive',
      statusReason: 'the budget ran out before call sites were discovered',
      budgetExhausted: true,
    };
  }
  if (run.crash !== null) {
    return { ...EMPTY, status: 'inconclusive', statusReason: `the unfaulted test run failed: ${run.crash}` };
  }

  const patchedByFile = new Map<string, Set<string>>();
  for (const event of run.events) {
    if (event.type !== 'conflict') continue;
    if (event.testFile === null) {
      return {
        ...EMPTY,
        status: 'inconclusive',
        statusReason: `HTTP entry points were already patched before the tests loaded: ${event.patched.join(', ')}`,
      };
    }
    const file = toPosix(path.relative(targetRoot, event.testFile));
    const patched = patchedByFile.get(file) ?? new Set<string>();
    for (const name of event.patched) patched.add(name);
    patchedByFile.set(file, patched);
  }
  const conflicts: FileConflict[] = [...patchedByFile.entries()]
    .map(([testFile, patched]) => ({ testFile, patched: [...patched].sort() }))
    .sort((a, b) => compareText(a.testFile, b.testFile));

  const tests = new Map<string, TestRecord>(run.tests.map((test) => [test.id, test]));
  const durations = new Map<string, number>();
  for (const event of run.events) {
    if (event.type === 'body-end') durations.set(event.testId, event.durationMs);
  }

  const builders = new Map<string, SiteBuilder>();
  const outOfScope = new Set<string>();
  for (const event of run.events) {
    if (event.type !== 'call') continue;
    const frames = projectFrames(event.frames, targetRoot);
    const innermost = frames[0];
    if (innermost === undefined) continue;
    const key = callSiteKey(innermost);
    const range = scopeOf(frames, ranges);
    if (range === null) {
      outOfScope.add(key);
      continue;
    }
    const builder = builders.get(key) ?? {
      innermost,
      functionName: enclosingFunctionName(frames),
      path: event.path,
      range,
      frames: new Map<string, ProjectFrame>(),
      callsByTest: new Map<string, number>(),
      unattributedCalls: 0,
    };
    builders.set(key, builder);
    for (const frame of frames) builder.frames.set(callSiteKey(frame), frame);

    const test = event.testId === null ? undefined : tests.get(event.testId);
    if (event.testId === null) builder.unattributedCalls += 1;
    else if (test?.state === 'pass' && !patchedByFile.has(test.file)) {
      builder.callsByTest.set(test.id, (builder.callsByTest.get(test.id) ?? 0) + 1);
    }
  }

  const sites: CallSite[] = [...builders.entries()]
    .sort(([a], [b]) => compareText(a, b))
    .map(([key, builder]) => {
      const reachedBy: ReachingTest[] = [...builder.callsByTest.entries()]
        .flatMap(([id, calls]) => {
          const test = tests.get(id);
          const durationMs = durations.get(id);
          return test === undefined || durationMs === undefined
            ? []
            : [{ test: { id, file: test.file, name: test.name }, durationMs, calls }];
        })
        .sort(
          (a, b) =>
            a.durationMs - b.durationMs ||
            compareText(a.test.file, b.test.file) ||
            compareText(a.test.name, b.test.name),
        );
      const { innermost } = builder;
      return {
        key,
        file: innermost.file,
        line: innermost.line,
        column: innermost.column,
        functionName: builder.functionName,
        path: builder.path,
        frames: [...builder.frames.values()],
        scopeKind: builder.range.kind,
        prior: priorOf(innermost.file, builder.functionName ?? ''),
        reachedBy,
        unattributedCalls: builder.unattributedCalls,
      };
    });

  return { ...EMPTY, sites, outOfScopeSites: outOfScope.size, conflicts };
}
