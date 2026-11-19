import { PRESETS } from '../core/index.js';
import { exitCodeOf, LEVELS, type ExitOptions, type Finding, type Item, type RunResult } from '../orchestrator/index.js';

const INDENT = '  ';
const SHORT_SHA = 7;

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function location(file: string, line: number | null, column?: number): string {
  if (line === null) return file;
  return column === undefined ? `${file}:${line}` : `${file}:${line}:${column}`;
}

function notChecked(result: RunResult): number {
  return result.skipped.length + result.inconclusive.length + result.conflicts.length;
}

function verdictLine(result: RunResult, options: ExitOptions): string {
  const code = exitCodeOf(result, options);
  if (result.status === 'error') return `Result: tool error (exit ${code})`;
  if (result.status === 'nothing-in-scope') return `Result: nothing in scope (exit ${code})`;
  const findings = plural(result.findings.length, 'finding');
  if (result.status === 'inconclusive') {
    return `Result: inconclusive, a phase failed or nothing in scope could be checked; ${findings} (exit ${code})`;
  }
  if (result.status === 'partial') {
    const strict = options.strict === true ? ', --strict' : '; 2 with --strict';
    return `Result: ${findings}, coverage partial: ${notChecked(result)} not checked, listed above (exit ${code}${strict})`;
  }
  return result.findings.length > 0
    ? `Result: ${findings} (exit ${code})`
    : `Result: clean, everything in scope was checked (exit ${code})`;
}

function header(result: RunResult): string[] {
  const preset = PRESETS[LEVELS[result.level]];
  const lines = [`${preset.name} run, budget ${seconds(result.budgetMs)}, spent ${seconds(result.spentMs)}, seed ${result.seed}`];
  if (result.git !== null) {
    const { base, mergeBase, head, dirty } = result.git;
    const tree = dirty ? ', with uncommitted changes' : '';
    lines.push(`Diff: ${head.slice(0, SHORT_SHA)} against ${base} (merge base ${mergeBase.slice(0, SHORT_SHA)})${tree}`);
  }
  return lines;
}

function scopeSection(result: RunResult): string[] {
  const { scope } = result;
  if (scope === null) return [];
  const lines = [
    scope.mode === 'test-only'
      ? `Scope: only test files changed; mutating the source they reach`
      : `Scope: ${plural(scope.changedSourceFiles.length, 'changed source file')}, ${plural(scope.changedTestFiles.length, 'changed test file')}`,
  ];
  for (const file of scope.changedSourceFiles) lines.push(`${INDENT}${file}`);
  for (const file of scope.changedTestFiles) lines.push(`${INDENT}${file} (test)`);
  for (const file of scope.boundaryFiles) lines.push(`${INDENT}${file} (reached by a changed test)`);
  for (const note of scope.notes) lines.push(`${INDENT}${location(note.file, note.line)}: ${note.message}`);
  return lines;
}

function coverageSection(result: RunResult): string[] {
  if (result.status === 'error' || result.status === 'nothing-in-scope') return [];
  const { mutants, invalidMutants, callSites } = result.checked;
  const lines = [`Coverage: ${plural(mutants, 'mutant')} and ${plural(callSites, 'call site')} checked`];
  if (invalidMutants > 0) lines.push(`${INDENT}${plural(invalidMutants, 'invalid mutant')} failed to compile or crashed the runner`);
  const gaps = [
    result.skipped.length > 0 ? `${result.skipped.length} skipped` : null,
    result.inconclusive.length > 0 ? `${result.inconclusive.length} inconclusive` : null,
    result.conflicts.length > 0 ? plural(result.conflicts.length, 'conflicting test file') : null,
  ].filter((gap) => gap !== null);
  if (gaps.length > 0) lines.push(`${INDENT}NOT CHECKED: ${gaps.join(', ')}; each is listed below`);
  for (const phase of result.phases) {
    if (phase.status === 'completed' || phase.status === 'not-run') continue;
    const reason = phase.statusReason === null ? '' : `: ${phase.statusReason}`;
    lines.push(`${INDENT}NOT CHECKED: the ${phase.name} phase ended ${phase.status}${reason}`);
  }
  if (lines.length === 1) lines.push(`${INDENT}nothing in scope was left unchecked`);
  return lines;
}

function findingLines(finding: Finding, rank: number): string[] {
  const { severity } = finding;
  const where = location(finding.file, finding.line, finding.column);
  const name = finding.functionName === null ? '' : ` in ${finding.functionName}`;
  const lines = [
    `${INDENT}${rank}. [${severity.level} ${severity.score}] ${where}${name}`,
    `${INDENT}${INDENT}${finding.kind}: ${finding.message}`,
  ];
  if (finding.fault !== null && finding.fault.tests.length > 0) {
    lines.push(`${INDENT}${INDENT}faulted under: ${finding.fault.tests.join('; ')}`);
  }
  return lines;
}

function findingsSection(result: RunResult, shown: number): string[] {
  if (result.findings.length === 0) return [];
  const lines = ['Findings, most severe first:'];
  result.findings.slice(0, shown).forEach((finding, index) => lines.push(...findingLines(finding, index + 1)));
  const hidden = result.findings.length - shown;
  if (hidden > 0) lines.push(`${INDENT}${plural(hidden, 'more finding')} not shown; --json lists every finding`);
  return lines;
}

/** Skipped items repeat a reason many times, such as every mutant a budget cut off, so they are grouped. */
function skippedSection(items: readonly Item[]): string[] {
  if (items.length === 0) return [];
  const groups = new Map<string, Item[]>();
  for (const entry of items) {
    const key = `${entry.source}\0${entry.reason}`;
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  const lines = [`Skipped (${items.length}):`];
  for (const group of groups.values()) {
    const first = group[0];
    if (first === undefined) continue;
    const places = [...new Set(group.map((entry) => location(entry.file, entry.line)))];
    lines.push(`${INDENT}${first.source}: ${first.reason} (${plural(group.length, 'item')})`);
    lines.push(`${INDENT}${INDENT}${places.join(', ')}`);
  }
  return lines;
}

function inconclusiveSection(items: readonly Item[]): string[] {
  if (items.length === 0) return [];
  return [
    `Inconclusive (${items.length}):`,
    ...items.map((entry) => `${INDENT}${location(entry.file, entry.line)} ${entry.source}: ${entry.reason}`),
  ];
}

function conflictSection(result: RunResult): string[] {
  if (result.conflicts.length === 0) return [];
  return [
    'Conflicts, calls made under these test files were not faulted:',
    ...result.conflicts.map(({ testFile, patched }) => `${INDENT}${testFile} replaces ${patched.join(', ')}`),
  ];
}

function phaseSection(result: RunResult): string[] {
  if (result.phases.length === 0) return [];
  return [
    'Phases:',
    ...result.phases.map((phase) => {
      const spent = phase.status === 'not-run' ? '' : ` ${seconds(phase.spentMs)} of ${seconds(phase.budgetMs)}`;
      const reason = phase.statusReason === null ? '' : `: ${phase.statusReason}`;
      return `${INDENT}${phase.name} ${phase.status}${spent}${reason}`;
    }),
  ];
}

export function renderText(result: RunResult, options: ExitOptions = {}): string {
  const shown = PRESETS[LEVELS[result.level]].findingsShown;
  const sections = [
    header(result),
    result.status === 'error' ? [`Error: ${result.error ?? 'unknown error'}`] : [],
    scopeSection(result),
    coverageSection(result),
    findingsSection(result, shown),
    skippedSection(result.skipped),
    inconclusiveSection(result.inconclusive),
    conflictSection(result),
    phaseSection(result),
    [verdictLine(result, options)],
  ].filter((section) => section.length > 0);
  return `${sections.map((section) => section.join('\n')).join('\n\n')}\n`;
}
