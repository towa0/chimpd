import { describe, expect, it } from 'vitest';
import { applyEvent, INITIAL_STATE, phaseFooter, phaseHeader, renderStatus, type ProgressState } from '../../src/progress/render.js';
import { stripAnsi } from '../../src/terminal/color.js';
import { PLAIN, THEMED } from '../../src/terminal/theme.js';
import { RECORDED } from '../helpers/progress-events.js';

const ASCII = /^[\x20-\x7e]*$/;


function stateAfter(count: number): ProgressState {
  return RECORDED.slice(0, count).reduce(applyEvent, INITIAL_STATE);
}

describe('progress state', () => {
  it('follows the events: counts, total and the current file, and resets at a phase end', () => {
    expect(stateAfter(4)).toEqual({ phase: 'mutation', startedAt: 0, budgetMs: 84_000, done: 5, total: 10, current: 'src/live/statuses.ts' });
    expect(stateAfter(5)).toEqual(INITIAL_STATE);
    expect(stateAfter(7)).toMatchObject({ phase: 'faults', done: 1, total: 3, current: 'src/clients/ledger.ts:12 (blackhole)' });
  });
});

describe('status line', () => {
  it('shows a spinner, a bar, the count, the time against the budget and the current file', () => {
    expect(renderStatus(stateAfter(4), { now: 61_200, columns: 120 })).toBe(
      '| [##########----------] 5/10 mutants  61.2 s / 84.0 s  src/live/statuses.ts',
    );
  });

  it('says what it waits for before the first result, and turns the spinner with time', () => {
    const state = stateAfter(1);
    expect(renderStatus(state, { now: 0, columns: 80 })).toBe('| starting Stryker and its dry run  0.0 s / 84.0 s');
    expect(renderStatus(state, { now: 100, columns: 80 }).startsWith('/ ')).toBe(true);
    expect(renderStatus(state, { now: 300, columns: 80 }).startsWith('\\ ')).toBe(true);
    expect(renderStatus(stateAfter(6), { now: 80_400, columns: 80 })).toBe('| discovering call sites  0.4 s / 40.0 s');
  });

  it('fits every terminal width without wrapping: it drops the file, then the bar, then the time', () => {
    for (const columns of [200, 80, 60, 45, 30, 20, 10, 5, 1]) {
      for (let count = 1; count <= RECORDED.length; count += 1) {
        const line = renderStatus(stateAfter(count), { now: 90_000, columns });
        expect(line.length).toBeLessThan(Math.max(2, columns));
        expect(line).toMatch(ASCII);
      }
    }
    expect(renderStatus(stateAfter(4), { now: 61_200, columns: 60 })).toBe('| [##########----------] 5/10 mutants  61.2 s / 84.0 s');
    expect(renderStatus(stateAfter(4), { now: 61_200, columns: 33 })).toBe('| 5/10 mutants  61.2 s / 84.0 s');
    expect(renderStatus(stateAfter(4), { now: 61_200, columns: 20 })).toBe('| 5/10 mutants');
  });

  it('keeps the end of a long path, the part that tells files apart', () => {
    const state = { ...stateAfter(4), current: 'src/a/very/long/directory/name/that/goes/on/statuses.ts' };
    const line = renderStatus(state, { now: 61_000, columns: 80 });
    expect(line.endsWith('/on/statuses.ts')).toBe(true);
    expect(line).toContain('...');
  });

  it('paints the spinner and the bar fill in the brand colour and the track dim, without changing the width', () => {
    const plain = renderStatus(stateAfter(4), { now: 61_200, columns: 120 });
    const themed = renderStatus(stateAfter(4), { now: 61_200, columns: 120 }, THEMED);
    expect(themed).toBe(
      '\u001b[35m|\u001b[39m [\u001b[35m##########\u001b[39m\u001b[2m----------\u001b[22m] 5/10 mutants  61.2 s / 84.0 s  src/live/statuses.ts',
    );
    expect(stripAnsi(themed)).toBe(plain);
    for (const columns of [80, 45, 20, 5, 1]) {
      expect(stripAnsi(renderStatus(stateAfter(4), { now: 61_200, columns }, THEMED))).toBe(renderStatus(stateAfter(4), { now: 61_200, columns }));
    }
  });

  it('draws nothing between phases', () => {
    expect(renderStatus(INITIAL_STATE, { now: 0, columns: 80 })).toBe('');
  });

  it('titles a phase in bold brand colour and colours its outcome by role', () => {
    expect(phaseHeader({ type: 'phase-start', phase: 'faults', budgetMs: 40_000, at: 0 }, THEMED)).toBe(
      '\u001b[1m\u001b[35m== Fault phase, budget 40.0 s ==\u001b[39m\u001b[22m',
    );
    const footer = (status: 'completed' | 'budget-exhausted' | 'error') =>
      phaseFooter({ type: 'phase-end', phase: 'mutation', status, spentMs: 1_000, at: 0 }, THEMED);
    expect(footer('completed')).toContain('\u001b[32mcompleted\u001b[39m');
    expect(footer('budget-exhausted')).toContain('\u001b[33mbudget-exhausted\u001b[39m');
    expect(footer('error')).toContain('\u001b[31merror\u001b[39m');
  });

  it('prints a header when a phase starts and a footer when it ends', () => {
    expect(phaseHeader({ type: 'phase-start', phase: 'mutation', budgetMs: 84_000, at: 0 }, PLAIN)).toBe('== Mutation phase, budget 84.0 s ==');
    expect(phaseFooter({ type: 'phase-end', phase: 'faults', status: 'budget-exhausted', spentMs: 35_500, at: 0 }, PLAIN)).toBe(
      '   faults budget-exhausted in 35.5 s',
    );
  });
});
