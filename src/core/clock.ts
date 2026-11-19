// Bound at module load so fake timers installed later by user code cannot replace them.
export const realNow: () => number = performance.now.bind(performance);
export const realSetTimeout: typeof setTimeout = globalThis.setTimeout;
export const realClearTimeout: typeof clearTimeout = globalThis.clearTimeout;

export interface Clock {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realClock: Clock = {
  now: realNow,
  setTimeout: (callback, ms) => realSetTimeout(callback, ms),
  clearTimeout: (handle) => realClearTimeout(handle as ReturnType<typeof setTimeout>),
};
