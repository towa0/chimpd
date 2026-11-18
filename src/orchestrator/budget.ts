export interface BudgetSplitInput {
  /** What is left of the preset budget once the branch is scoped. */
  readonly remainingMs: number;
  readonly mutationShare: number;
  readonly mutationInScope: boolean;
  readonly faultsInScope: boolean;
}

/**
 * The mutation phase's budget. The fault phase runs second and gets whatever is left, so time the
 * mutation phase does not use passes to it; a phase with nothing in scope gives its whole share away.
 */
export function mutationBudgetMs(input: BudgetSplitInput): number {
  if (!input.mutationInScope) return 0;
  if (!input.faultsInScope) return input.remainingMs;
  return Math.floor(input.remainingMs * input.mutationShare);
}
