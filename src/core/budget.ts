import { realNow } from './clock.js';

export interface Budget {
  readonly totalMs: number;
  spentMs(): number;
  remainingMs(): number;
  exhausted(): boolean;
}

export function startBudget(totalMs: number, now: () => number = realNow): Budget {
  const startedAt = now();
  const spentMs = (): number => now() - startedAt;
  const remainingMs = (): number => Math.max(0, totalMs - spentMs());
  return { totalMs, spentMs, remainingMs, exhausted: () => remainingMs() <= 0 };
}
