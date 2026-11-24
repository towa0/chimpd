import type { FaultKind } from '../core/index.js';
import type { PhaseName, PhaseStatus } from '../orchestrator/types.js';

/** What a run reports while it runs, so that a renderer can follow it without knowing the phases. */
export type ProgressEvent =
  | { readonly type: 'phase-start'; readonly phase: PhaseName; readonly budgetMs: number; readonly at: number }
  | {
      readonly type: 'mutant-tested';
      /** Repo-relative path of the mutant's file. */
      readonly file: string;
      readonly status: string;
      /** Mutants in scope that got a result so far, this one included. */
      readonly tested: number;
      /** Mutants in scope over every batch; null when a file could not be counted. */
      readonly total: number | null;
      readonly at: number;
    }
  | {
      readonly type: 'site-faulted';
      readonly file: string;
      readonly line: number;
      readonly kind: FaultKind;
      /** Faulted runs finished so far, this one included, out of one per planned site and fault kind. */
      readonly done: number;
      readonly total: number;
      readonly at: number;
    }
  | { readonly type: 'phase-end'; readonly phase: PhaseName; readonly status: PhaseStatus; readonly spentMs: number; readonly at: number };

export type ProgressListener = (event: ProgressEvent) => void;
