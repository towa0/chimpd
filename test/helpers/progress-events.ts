import type { ProgressEvent } from '../../src/progress/events.js';

/** Events as a Poke run reports them, with the clock in ms from the start of the run. */
export const RECORDED: readonly ProgressEvent[] = [
  { type: 'phase-start', phase: 'mutation', budgetMs: 84_000, at: 0 },
  { type: 'mutant-tested', file: 'src/tariff/cheaper.ts', status: 'CompileError', tested: 1, total: 10, at: 47_000 },
  { type: 'mutant-tested', file: 'src/tariff/cheaper.ts', status: 'Killed', tested: 2, total: 10, at: 52_000 },
  { type: 'mutant-tested', file: 'src/live/statuses.ts', status: 'Survived', tested: 5, total: 10, at: 61_200 },
  { type: 'phase-end', phase: 'mutation', status: 'completed', spentMs: 80_000, at: 80_000 },
  { type: 'phase-start', phase: 'faults', budgetMs: 40_000, at: 80_000 },
  { type: 'site-faulted', file: 'src/clients/ledger.ts', line: 12, kind: 'blackhole', done: 1, total: 3, at: 95_000 },
];

export function recorded(index: number): ProgressEvent {
  const event = RECORDED[index];
  if (event === undefined) throw new Error(`no recorded event ${index}`);
  return event;
}
