import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';
import type { Vite } from 'vitest/node';
import { ensureWorkDir, realClearTimeout, realSetTimeout, removeTree, toPosix } from '../core/index.js';
import { prependSetupFile, targetViteLogger, type VitestInlineOptions, type VitestNodeModule } from '../fault-recon/index.js';
import type { Fingerprints } from '../fault-recon/conflicts.js';
import type { RuntimeConfig, RuntimeEvent, RuntimeMode } from '../fault-recon/protocol.js';

export interface InstrumentedRequest {
  /** Real path of the target. */
  readonly targetRoot: string;
  readonly configFile: string;
  readonly vitestNode: VitestNodeModule;
  readonly pristine: Fingerprints;
  readonly mode: RuntimeMode;
  readonly options?: VitestInlineOptions;
  readonly filters?: readonly string[];
  readonly plugins?: readonly Vite.Plugin[];
  /** The run is closed, workers included, when it is still going after this long. */
  readonly timeoutMs?: number;
  /** Receives what the target's own tests write to stdout and stderr; it is discarded without one. */
  readonly onTargetOutput?: (text: string) => void;
}

export type TestState = 'pass' | 'fail' | 'skip' | 'unknown';

export interface TestRecord {
  readonly id: string;
  readonly file: string;
  readonly name: string;
  readonly state: TestState;
  /** The first error Vitest recorded for the test, a failing hook's included; null when there is none. */
  readonly error: string | null;
}

export interface InstrumentedRun {
  readonly events: readonly RuntimeEvent[];
  readonly tests: readonly TestRecord[];
  readonly unhandledErrors: readonly unknown[];
  /** True when the run was closed at its timeout; its events and tests are then partial. */
  readonly killed: boolean;
  readonly crash: string | null;
}

const RUN_DIR_PREFIX = 'fault-';

function runtimeUrl(): string {
  const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
  return new URL(`../fault-recon/runtime.${extension}`, import.meta.url).href;
}

// The stub lives in the target so that its vitest import resolves to the target's copy.
function stubSource(config: RuntimeConfig): string {
  return [
    "import { afterAll, TestRunner } from 'vitest';",
    `import { startRuntime } from ${JSON.stringify(runtimeUrl())};`,
    '',
    'startRuntime(',
    '  { afterAll, runner: TestRunner.prototype, getTestFn: TestRunner.getTestFn },',
    `  ${JSON.stringify(config)},`,
    ');',
    '',
  ].join('\n');
}

// Vitest pipes every worker's stdout and stderr into these, so the target's tests never write to this process.
function outputSink(onOutput: ((text: string) => void) | undefined): Writable {
  return new Writable({
    write(chunk: Buffer | string, _encoding, done) {
      onOutput?.(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
      done();
    },
  });
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function removeAbandonedRunDirs(workDir: string): void {
  for (const entry of fs.readdirSync(workDir)) {
    const pid = Number(entry.startsWith(RUN_DIR_PREFIX) ? entry.split('-')[1] : NaN);
    if (Number.isInteger(pid) && !isAlive(pid)) removeTree(path.join(workDir, entry));
  }
}

function readEvents(eventsDir: string): RuntimeEvent[] {
  return fs
    .readdirSync(eventsDir)
    .filter((entry) => entry.endsWith('.jsonl'))
    .sort()
    .flatMap((entry) => fs.readFileSync(path.join(eventsDir, entry), 'utf8').split('\n'))
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as RuntimeEvent);
}

interface StateTask {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly result?: { readonly state?: string; readonly errors?: readonly { readonly message?: unknown }[] } | undefined;
  readonly tasks?: readonly StateTask[];
}

function stateOf(task: StateTask): TestState {
  const state = task.result?.state;
  return state === 'pass' || state === 'fail' || state === 'skip' ? state : 'unknown';
}

function collectTests(tasks: readonly StateTask[], file: string, parents: readonly string[]): TestRecord[] {
  return tasks.flatMap((task) => {
    const names = [...parents, task.name];
    if (task.type === 'test') {
      const message = task.result?.errors?.[0]?.message;
      return [{ id: task.id, file, name: names.join(' > '), state: stateOf(task), error: typeof message === 'string' ? message : null }];
    }
    return collectTests(task.tasks ?? [], file, names);
  });
}

export async function runInstrumented(request: InstrumentedRequest): Promise<InstrumentedRun> {
  const { targetRoot } = request;
  const workDir = ensureWorkDir(targetRoot);
  removeAbandonedRunDirs(workDir);
  const runDir = path.join(workDir, `${RUN_DIR_PREFIX}${process.pid}-${randomUUID()}`);
  const cleanup = (): void => removeTree(runDir);
  process.once('exit', cleanup);

  const previousExitCode = process.exitCode;
  try {
    fs.mkdirSync(runDir);
    const stubFile = path.join(runDir, 'setup.mjs');
    fs.writeFileSync(stubFile, stubSource({ eventsDir: runDir, pristine: request.pristine, mode: request.mode }));

    const vitest = await request.vitestNode.createVitest(
      'test',
      { ...request.options, reporters: [{}], root: targetRoot, config: request.configFile, watch: false },
      { plugins: [prependSetupFile(stubFile), ...(request.plugins ?? [])], customLogger: targetViteLogger(request.onTargetOutput) },
      { stdout: outputSink(request.onTargetOutput), stderr: outputSink(request.onTargetOutput) },
    );
    let killed = false;
    let crash: string | null = null;
    let closing: Promise<void> | null = null;
    const close = (): Promise<void> => (closing ??= vitest.close());
    const stopped = Promise.withResolvers<void>();
    const timer =
      request.timeoutMs === undefined
        ? null
        : realSetTimeout(() => {
            killed = true;
            void close().finally(stopped.resolve);
          }, request.timeoutMs);
    try {
      const finished = vitest.start([...(request.filters ?? [])]).then(
        () => undefined,
        (error: unknown) => {
          if (!killed) crash = error instanceof Error ? error.message : String(error);
        },
      );
      await Promise.race([finished, stopped.promise]);
      const files = vitest.state.getFiles();
      return {
        events: readEvents(runDir),
        tests: files.flatMap((file) =>
          collectTests(file.tasks, toPosix(path.relative(targetRoot, file.filepath)), []),
        ),
        unhandledErrors: vitest.state.getUnhandledErrors(),
        killed,
        crash,
      };
    } finally {
      if (timer !== null) realClearTimeout(timer);
      await close();
    }
  } finally {
    // An inner run that fails reports through process.exitCode, which belongs to the caller.
    process.exitCode = previousExitCode;
    cleanup();
    process.removeListener('exit', cleanup);
  }
}
