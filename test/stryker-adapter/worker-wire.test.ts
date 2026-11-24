import { afterEach, describe, expect, it } from 'vitest';
import { strykerPlugins, type WorkerMessage } from '../../src/stryker-adapter/worker.js';

type Reporter = Record<string, (event: unknown) => void>;

const reporter = strykerPlugins[0]?.value as unknown as Reporter;
const host = process as { send?: unknown };
const originalSend = host.send;

function captured(call: () => void): WorkerMessage[] {
  const messages: WorkerMessage[] = [];
  host.send = (message: WorkerMessage): boolean => {
    messages.push(message);
    return true;
  };
  call();
  return messages;
}

afterEach(() => {
  host.send = originalSend;
});

const mutant = {
  id: '1',
  fileName: '/repo/src/a.ts',
  mutatorName: 'EqualityOperator',
  replacement: 'a > b',
  coveredBy: [],
  killedBy: [],
  static: false,
};

describe('worker wire positions', () => {
  it('sends a planned mutant at the same 1-based position as its tested result', () => {
    // Stryker plans mutants at its internal 0-based positions and reports tested ones 1-based.
    const [plan] = captured(() =>
      reporter.onMutationTestingPlanReady?.({
        mutantPlans: [{ mutant: { ...mutant, location: { start: { line: 66, column: 8 }, end: { line: 66, column: 26 } } } }],
      }),
    );
    const [tested] = captured(() =>
      reporter.onMutantTested?.({ ...mutant, status: 'Survived', location: { start: { line: 67, column: 9 }, end: { line: 67, column: 27 } } }),
    );

    expect(plan).toMatchObject({ type: 'plan', mutants: [{ start: { line: 67, column: 9 }, end: { line: 67, column: 27 } }] });
    expect(tested).toMatchObject({ type: 'mutant', mutant: { start: { line: 67, column: 9 }, end: { line: 67, column: 27 } } });
  });
});
