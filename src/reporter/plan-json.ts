import { PRESETS } from '../core/index.js';
import { LEVELS } from '../orchestrator/index.js';
import { exitCodeOfPlan, type RunPlan } from '../plan/index.js';

/** Versioned apart from the run report; bumped on any change that removes, renames or retypes a field. */
export const PLAN_SCHEMA_VERSION = 1;

export interface JsonPlan {
  readonly report: 'plan';
  readonly schemaVersion: typeof PLAN_SCHEMA_VERSION;
  readonly status: RunPlan['status'];
  readonly exitCode: number;
  readonly error: string | null;
  readonly level: RunPlan['level'];
  readonly preset: {
    readonly name: string;
    readonly budgetMs: number;
    readonly mutationShare: number;
    readonly mutators: readonly string[];
    readonly maxFaultedCallSites: number;
    readonly testsPerCallSite: number;
  };
  readonly seed: number;
  readonly git: { readonly base: string; readonly mergeBase: string; readonly head: string; readonly dirty: boolean } | null;
  readonly scope: {
    readonly mode: 'diff' | 'test-only';
    readonly changedSourceFiles: readonly string[];
    readonly changedTestFiles: readonly string[];
    readonly boundaryFiles: readonly string[];
    readonly ignoredFiles: readonly { readonly file: string; readonly reason: string }[];
    readonly notes: readonly { readonly file: string; readonly line: number; readonly message: string }[];
    readonly notChecked: readonly { readonly source: string; readonly file: string; readonly line: number | null; readonly reason: string }[];
  } | null;
  readonly vitestConfig: string | null;
  readonly runWouldFail: string | null;
  readonly mutation: {
    readonly total: number | null;
    readonly files: readonly { readonly file: string; readonly mutants: number | null; readonly moduleLevel: number | null; readonly reason: string | null }[];
    readonly batches: readonly (readonly string[])[];
    readonly ignoreStatic: boolean;
    readonly staticReason: string;
    readonly notRun: string | null;
  } | null;
  readonly faults: {
    readonly calls: readonly { readonly file: string; readonly line: number; readonly callee: string; readonly scopeKind: string }[];
    readonly kinds: readonly string[];
    readonly maxCallSites: number;
    readonly testsPerCallSite: number;
    readonly notRun: string | null;
  } | null;
  readonly budget: { readonly totalMs: number; readonly mutationMs: number; readonly faultMs: number };
  /** An estimate, never a measurement of this run; `derivation` says how it was reached and which costs were measured before. */
  readonly estimate: {
    readonly isEstimate: true;
    readonly totalMs: number;
    readonly mutationMs: number;
    readonly faultMs: number;
    /** Whether every cost it used was measured on an earlier run of this project, from .chimpd/timings.json. */
    readonly calibrated: boolean;
    readonly derivation: readonly string[];
  } | null;
}

export function toJsonPlan(plan: RunPlan): JsonPlan {
  const preset = PRESETS[LEVELS[plan.level]];
  const { git, scope, mutation, faults, estimate } = plan;
  return {
    report: 'plan',
    schemaVersion: PLAN_SCHEMA_VERSION,
    status: plan.status,
    exitCode: exitCodeOfPlan(plan),
    error: plan.error,
    level: plan.level,
    preset: {
      name: preset.name,
      budgetMs: preset.budgetMs,
      mutationShare: preset.mutationShare,
      mutators: [...preset.mutators],
      maxFaultedCallSites: preset.maxFaultedCallSites,
      testsPerCallSite: preset.testsPerCallSite,
    },
    seed: plan.seed,
    git: git === null ? null : { base: git.base, mergeBase: git.mergeBase, head: git.head, dirty: git.dirty },
    scope:
      scope === null
        ? null
        : {
            mode: scope.mode,
            changedSourceFiles: [...scope.changedSourceFiles],
            changedTestFiles: [...scope.changedTestFiles],
            boundaryFiles: [...scope.boundaryFiles],
            ignoredFiles: scope.ignoredFiles.map(({ file, reason }) => ({ file, reason })),
            notes: scope.notes.map(({ file, line, message }) => ({ file, line, message })),
            notChecked: plan.scopeItems.map(({ source, file, line, reason }) => ({ source, file, line, reason })),
          },
    vitestConfig: plan.vitestConfig,
    runWouldFail: plan.runWouldFail,
    mutation:
      mutation === null
        ? null
        : {
            total: mutation.total,
            files: mutation.files.map(({ file, mutants, moduleLevel, reason }) => ({ file, mutants, moduleLevel, reason })),
            batches: mutation.batches.map((files) => [...files]),
            ignoreStatic: mutation.ignoreStatic,
            staticReason: mutation.staticReason,
            notRun: mutation.notRun,
          },
    faults:
      faults === null
        ? null
        : {
            calls: faults.calls.map(({ file, line, callee, scopeKind }) => ({ file, line, callee, scopeKind })),
            kinds: [...faults.kinds],
            maxCallSites: faults.maxCallSites,
            testsPerCallSite: faults.testsPerCallSite,
            notRun: faults.notRun,
          },
    budget: { totalMs: plan.budget.totalMs, mutationMs: plan.budget.mutationMs, faultMs: plan.budget.faultMs },
    estimate:
      estimate === null
        ? null
        : {
            isEstimate: true,
            totalMs: Math.round(estimate.totalMs),
            mutationMs: Math.round(estimate.mutationMs),
            faultMs: Math.round(estimate.faultMs),
            calibrated: estimate.calibrated,
            derivation: [...estimate.derivation],
          },
  };
}

export function renderPlanJson(plan: RunPlan): string {
  return `${JSON.stringify(toJsonPlan(plan), null, 2)}\n`;
}
