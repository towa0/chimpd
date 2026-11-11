import { Stryker } from '@stryker-mutator/core';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type StrykerOptions = ConstructorParameters<typeof Stryker>[0];
type StrykerMutant = Awaited<ReturnType<Stryker['runMutationTest']>>[number];

export interface WireMutant {
  readonly id: string;
  readonly fileName: string;
  readonly start: { readonly line: number; readonly column: number };
  readonly end: { readonly line: number; readonly column: number };
  readonly mutatorName: string;
  readonly replacement: string;
  readonly status: string | null;
  readonly statusReason: string | null;
  readonly coveredBy: readonly string[];
  readonly killedBy: readonly string[];
  readonly static: boolean;
}

export interface WireTest {
  readonly id: string;
  readonly name: string;
  readonly fileName: string | null;
  readonly timeSpentMs: number;
}

export type WorkerMessage =
  | { readonly type: 'dry-run'; readonly netMs: number; readonly tests: readonly WireTest[] }
  | { readonly type: 'plan'; readonly mutants: readonly WireMutant[] }
  | { readonly type: 'mutant'; readonly mutant: WireMutant }
  | { readonly type: 'done' }
  | { readonly type: 'error'; readonly message: string };

export interface StartMessage {
  readonly type: 'start';
  readonly options: StrykerOptions;
}

export const STREAM_REPORTER = 'chimpd-stream';

interface DryRunEvent {
  readonly timing: { readonly net: number };
  readonly result: {
    readonly tests: readonly {
      readonly id: string;
      readonly name: string;
      readonly fileName?: string;
      readonly timeSpentMs: number;
    }[];
  };
}

interface PlanEvent {
  readonly mutantPlans: readonly { readonly mutant: Partial<StrykerMutant> & Pick<StrykerMutant, 'id' | 'fileName'> }[];
}

function send(message: WorkerMessage): void {
  process.send?.(message);
}

function toWire(mutant: PlanEvent['mutantPlans'][number]['mutant']): WireMutant {
  const zero = { line: 0, column: 0 };
  return {
    id: mutant.id,
    fileName: mutant.fileName,
    start: mutant.location?.start ?? zero,
    end: mutant.location?.end ?? zero,
    mutatorName: mutant.mutatorName ?? '',
    replacement: mutant.replacement ?? '',
    status: mutant.status ?? null,
    statusReason: mutant.statusReason ?? null,
    coveredBy: mutant.coveredBy ?? [],
    killedBy: mutant.killedBy ?? [],
    static: mutant.static ?? false,
  };
}

const streamReporter = {
  onDryRunCompleted(event: DryRunEvent): void {
    send({
      type: 'dry-run',
      netMs: event.timing.net,
      tests: event.result.tests.map((test) => ({
        id: test.id,
        name: test.name,
        fileName: test.fileName ?? null,
        timeSpentMs: test.timeSpentMs,
      })),
    });
  },
  onMutationTestingPlanReady(event: PlanEvent): void {
    send({ type: 'plan', mutants: event.mutantPlans.map((plan) => toWire(plan.mutant)) });
  },
  onMutantTested(result: StrykerMutant): void {
    send({ type: 'mutant', mutant: toWire(result) });
  },
};

// Stryker loads this file as a plugin, in this process and in each of its own worker processes.
export const strykerPlugins = [{ kind: 'Reporter', name: STREAM_REPORTER, value: streamReporter }];

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  const here = fileURLToPath(import.meta.url);
  const same = (a: string, b: string): boolean =>
    process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  return same(path.resolve(entry), here);
}

function exitAfterFlush(code: number): void {
  if (process.connected) process.disconnect();
  process.exit(code);
}

async function run(options: StrykerOptions): Promise<void> {
  try {
    await new Stryker(options).runMutationTest();
    process.send?.({ type: 'done' } satisfies WorkerMessage, () => exitAfterFlush(0));
  } catch (error) {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.send?.({ type: 'error', message } satisfies WorkerMessage, () => exitAfterFlush(1));
  }
}

if (isEntryPoint()) {
  process.once('message', (message: StartMessage) => {
    void run(message.options);
  });
}
