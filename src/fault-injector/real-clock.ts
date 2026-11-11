// Bound at module load so fake timers installed later by user code cannot replace it.
export const realNow: () => number = performance.now.bind(performance);
