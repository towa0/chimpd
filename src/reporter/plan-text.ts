import { firstErrorLine, PRESETS } from '../core/index.js';
import type { IgnoredReason } from '../diff-scoper/index.js';
import { LEVELS } from '../orchestrator/index.js';
import { exitCodeOfPlan, type PlanCall, type RunPlan } from '../plan/index.js';

const INDENT = '  ';
const SHORT_SHA = 7;

const IGNORED_LABELS: Readonly<Record<IgnoredReason, string>> = {
  'not-typescript': 'not TypeScript',
  'declaration-file': 'a declaration file',
  'config-file': 'a tooling config file',
  deleted: 'deleted',
  binary: 'a binary file',
  submodule: 'a submodule',
  symlink: 'a symbolic link',
};

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function header(plan: RunPlan): string[] {
  const preset = PRESETS[LEVELS[plan.level]];
  const lines = [`Plan for a ${preset.name} run, seed ${plan.seed}; nothing was run`];
  if (plan.git !== null) {
    const { base, mergeBase, head, dirty } = plan.git;
    const tree = dirty ? ', with uncommitted changes' : '';
    lines.push(`Diff: ${head.slice(0, SHORT_SHA)} against ${base} (merge base ${mergeBase.slice(0, SHORT_SHA)})${tree}`);
  }
  return lines;
}

function scopeSection(plan: RunPlan): string[] {
  const { scope } = plan;
  if (scope === null) return [];
  const lines = [
    scope.mode === 'test-only'
      ? 'Scope: only test files changed; a run mutates the source they reach'
      : `Scope: ${plural(scope.changedSourceFiles.length, 'changed source file')}, ${plural(scope.changedTestFiles.length, 'changed test file')}`,
  ];
  for (const file of scope.changedSourceFiles) lines.push(`${INDENT}${file}`);
  for (const file of scope.changedTestFiles) lines.push(`${INDENT}${file} (test)`);
  for (const file of scope.boundaryFiles) lines.push(`${INDENT}${file} (reached by a changed test)`);
  for (const note of scope.notes) lines.push(`${INDENT}${note.file}:${note.line}: ${note.message}`);
  for (const item of plan.scopeItems) lines.push(`${INDENT}${item.file}: not checked: ${item.reason}`);
  if (scope.ignoredFiles.length === 0) return lines;
  return [
    ...lines,
    '',
    `Ignored, not checked (${scope.ignoredFiles.length}):`,
    ...scope.ignoredFiles.map(({ file, reason }) => `${INDENT}${file}: ${IGNORED_LABELS[reason]}`),
  ];
}

function mutationSection(plan: RunPlan): string[] {
  const { mutation } = plan;
  if (mutation === null) return [];
  if (mutation.notRun !== null) return [`Mutation phase: would not run: ${mutation.notRun}`];
  const total =
    mutation.total === null
      ? 'Mutants: total unavailable, see the files below'
      : `Mutants: ${mutation.total} would be generated, counted by Stryker's instrumenter without running tests`;
  const lines = [total];
  for (const entry of mutation.files) {
    if (entry.mutants === null) {
      lines.push(`${INDENT}${entry.file}: ${entry.reason ?? 'count unavailable'}`);
    } else {
      const moduleLevel = (entry.moduleLevel ?? 0) > 0 ? ` (${entry.moduleLevel} in module-level code)` : '';
      lines.push(`${INDENT}${entry.file}: ${plural(entry.mutants, 'mutant')}${moduleLevel}`);
    }
  }
  lines.push(`${INDENT}${mutation.ignoreStatic ? 'static mutants skipped' : 'static mutants tested'}: ${mutation.staticReason}`);
  lines.push('Mutation batches, in run order:');
  mutation.batches.forEach((files, index) => lines.push(`${INDENT}batch ${index + 1}: ${files.join(', ')}`));
  return lines;
}

function callLine(call: PlanCall): string {
  const where = call.scopeKind === 'changed' ? 'changed line' : 'in a changed function';
  return `${INDENT}${call.file}:${call.line} ${call.callee} (${where})`;
}

function faultSection(plan: RunPlan): string[] {
  const { faults } = plan;
  if (faults === null) return [];
  if (faults.notRun !== null) return [`Fault phase: would not run: ${faults.notRun}`];
  const lines = [
    `Fault phase: at most ${plural(faults.maxCallSites, 'call site')}, ${plural(faults.testsPerCallSite, 'test')} each, faulted with ${faults.kinds.join(', ')}`,
    `Changed outgoing calls found in the source (${faults.calls.length}):`,
  ];
  if (faults.calls.length === 0) lines.push(`${INDENT}none`);
  lines.push(...faults.calls.map(callLine));
  lines.push(`${INDENT}calls through client libraries are only found when a test makes them`);
  return lines;
}

function budgetSection(plan: RunPlan): string[] {
  if (plan.status !== 'planned') return [];
  const { totalMs, mutationMs, faultMs } = plan.budget;
  return [`Budget: ${seconds(totalMs)}; mutation ${seconds(mutationMs)}, faults ${seconds(faultMs)} plus what the mutation phase leaves unused`];
}

function estimateSection(plan: RunPlan): string[] {
  const { estimate } = plan;
  if (estimate === null) return [];
  return [
    `Estimate (rough, not measured): about ${seconds(estimate.totalMs)}, derived from:`,
    ...estimate.derivation.map((line) => `${INDENT}${line}`),
  ];
}

function resultLine(plan: RunPlan): string {
  const code = exitCodeOfPlan(plan);
  if (plan.status === 'error') return `Result: the plan could not be computed (exit ${code})`;
  if (plan.status === 'nothing-in-scope') return `Result: nothing in scope, a run would check nothing (exit ${code})`;
  return `Result: plan only, nothing was run (exit ${code})`;
}

export function renderPlanText(plan: RunPlan): string {
  const sections = [
    header(plan),
    plan.status === 'error' ? [`Error: ${firstErrorLine(plan.error) ?? 'unknown error'}`] : [],
    plan.runWouldFail === null ? [] : [`A run would stop here: ${plan.runWouldFail}`],
    scopeSection(plan),
    mutationSection(plan),
    faultSection(plan),
    budgetSection(plan),
    estimateSection(plan),
    [resultLine(plan)],
  ].filter((section) => section.length > 0);
  return `${sections.map((section) => section.join('\n')).join('\n\n')}\n`;
}
