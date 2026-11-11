// Bound at module load so fake timers installed later by user code cannot replace them.
export const realNow: () => number = performance.now.bind(performance);
export const realSetTimeout: typeof setTimeout = globalThis.setTimeout;
export const realClearTimeout: typeof clearTimeout = globalThis.clearTimeout;
