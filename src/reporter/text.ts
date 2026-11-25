import { firstErrorLine, PRESETS } from '../core/index.js';
import type { BaselineEntry } from '../baseline/index.js';
import { exitCodeOf, LEVELS, type ExitOptions, type Finding, type Item, type PhaseReport, type RunResult } from '../orchestrator/index.js';
import { perFaultRunMs, perMutantMs } from '../timings/index.js';

const INDENT = '  ';
const SHORT_SHA = 7;

export function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

/** Reasons can carry a whole error with its stack; the text report shows only their first line. */
function firstLine(text: string): string {
  return text.split('\n').find((line) => line.trim() !== '')?.trim() ?? text;
}

function phaseReason(reason: string | null): string {
  return reason === null ? '' : `: ${firstErrorLine(reason) ?? reason}`;
}

export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function location(file: string, line: number | null, column?: number): string {
  if (line === null) return file;
  return column === undefined ? `${file}:${line}` : `${file}:${line}:${column}`;
}

function notChecked(result: RunResult): number {
  return result.skipped.length + result.inconclusive.length + result.conflicts.length;
}

/** What left a partial run partial; a phase is named only when no single item explains it. */
function partialGaps(result: RunResult): string {
  const counted = [
    notChecked(result) > 0 ? `${notChecked(result)} not checked` : null,
    result.invalid.length > 0 && !result.invalidExcluded ? `${result.invalid.length} invalid` : null,
  ].filter((gap) => gap !== null);
  if (counted.length > 0) return `${counted.join(', ')}, listed above`;
  const unfinished = result.phases.filter((phase) => phase.status !== 'completed' && phase.status !== 'not-run');
  if (unfinished.length === 0) return 'listed above';
  return unfinished.map((phase) => `the ${phase.name} phase ended ${phase.status}`).join(', ');
}

function notTestedLine(result: RunResult): string | null {
  if (result.notTested.length === 0) return null;
  const counted = result.notTested.reduce((total, entry) => total + (entry.mutants ?? 0), 0);
  const unplanned = result.notTested.filter((entry) => entry.mutants === null).length;
  const what = [
    counted > 0 ? `${plural(counted, 'generated mutant')} not tested` : null,
    unplanned > 0 ? `the mutants of ${plural(unplanned, 'file')} never planned` : null,
  ].filter((part) => part !== null);
  const files = result.notTested.map(({ file, mutants }) => `${file} (${mutants ?? 'never planned'})`);
  return `${INDENT}NOT CHECKED: ${what.join(' and ')} before the budget ran out: ${files.join(', ')}`;
}

function excludedNote(result: RunResult): string | null {
  return result.invalidExcluded ? `${plural(result.invalid.length, 'invalid mutant')} excluded` : null;
}

export function verdictLine(result: RunResult, options: ExitOptions): string {
  const code = exitCodeOf(result, options);
  if (result.status === 'error') return `Result: tool error (exit ${code})`;
  if (result.status === 'nothing-in-scope') return `Result: nothing in scope (exit ${code})`;
  const ignored = result.ignored.length;
  const findings = `${plural(result.findings.length, 'finding')}${ignored > 0 ? `, ${ignored} ignored` : ''}`;
  if (result.status === 'inconclusive') {
    const reason = result.statusReason ?? 'a phase failed or nothing in scope could be checked';
    return `Result: inconclusive, ${reason}; ${findings} (exit ${code})`;
  }
  if (result.status === 'nothing-checkable') {
    const strict = options.strict === true ? ', --strict' : '; 2 with --strict';
    return `Result: nothing checkable, ${result.statusReason ?? 'nothing in scope could be checked'} (exit ${code}${strict})`;
  }
  if (result.status === 'partial') {
    const strict = options.strict === true ? ', --strict' : '; 2 with --strict';
    const excluded = excludedNote(result);
    return `Result: ${findings}, coverage partial: ${partialGaps(result)}${excluded === null ? '' : `; ${excluded}`} (exit ${code}${strict})`;
  }
  const excluded = excludedNote(result);
  if (result.status === 'completed' && excluded !== null) {
    if (result.findings.length > 0) return `Result: ${findings}, coverage complete, ${excluded} (exit ${code})`;
    const alsoIgnored = ignored > 0 ? `; ${plural(ignored, 'finding')} ignored` : '';
    return `Result: clean, coverage complete, ${excluded}${alsoIgnored} (exit ${code})`;
  }
  if (result.findings.length > 0) return `Result: ${findings} (exit ${code})`;
  const alsoIgnored = ignored > 0 ? `; ${plural(ignored, 'finding')} ignored` : '';
  return result.status === 'completed'
    ? `Result: clean, everything in scope was checked${alsoIgnored} (exit ${code})`
    : `Result: ${findings} (exit ${code})`;
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
  for (const { file, reason } of scope.ignoredFiles) {
    if (reason === 'config-file') lines.push(`${INDENT}${file} (not checked: a tooling config file)`);
  }
  for (const note of scope.notes) lines.push(`${INDENT}${location(note.file, note.line)}: ${note.message}`);
  return lines;
}

function coverageSection(result: RunResult): string[] {
  if (result.status === 'error' || result.status === 'nothing-in-scope') return [];
  const { mutants, invalidMutants, callSites } = result.checked;
  const lines = [`Coverage: ${plural(mutants, 'mutant')} and ${plural(callSites, 'call site')} checked`];
  if (invalidMutants > 0) {
    const excluded = result.invalidExcluded ? 'excluded from coverage, ' : '';
    lines.push(`${INDENT}${plural(invalidMutants, 'invalid mutant')} failed to compile or crashed the runner; ${excluded}each is listed below`);
  }
  const gaps = [
    result.skipped.length > 0 ? `${result.skipped.length} skipped` : null,
    result.inconclusive.length > 0 ? `${result.inconclusive.length} inconclusive` : null,
    result.conflicts.length > 0 ? plural(result.conflicts.length, 'conflicting test file') : null,
  ].filter((gap) => gap !== null);
  if (gaps.length > 0) lines.push(`${INDENT}NOT CHECKED: ${gaps.join(', ')}; each is listed below`);
  const untested = notTestedLine(result);
  if (untested !== null) lines.push(untested);
  for (const phase of result.phases) {
    if (phase.status === 'completed' || phase.status === 'not-run') continue;
    // A failed phase's reason is an error, shown once under Phases.
    const reason = phase.status === 'error' ? '; the reason is under Phases' : phaseReason(phase.statusReason);
    lines.push(`${INDENT}NOT CHECKED: the ${phase.name} phase ended ${phase.status}${reason}`);
  }
  if (lines.length === 1 && result.status === 'completed') lines.push(`${INDENT}nothing in scope was left unchecked`);
  for (const phase of result.phases) {
    if (phase.name === 'faults' && phase.status === 'completed' && phase.statusReason !== null) {
      lines.push(`${INDENT}no call site to fault: ${phase.statusReason}`);
    }
  }
  return lines;
}

/** What a finding says under its location line: the reason, then how a fault was applied. */
export function findingDetails(finding: Finding): string[] {
  const lines = [`${finding.kind}: ${finding.message}`];
  if (finding.fault !== null) {
    const under = finding.fault.tests.length > 0 ? ` under: ${finding.fault.tests.join('; ')}` : '';
    lines.push(`faulted with ${finding.fault.kind}${under}`);
    if (finding.fault.reachedFrom.length > 0) lines.push(`reached from changed code: ${finding.fault.reachedFrom.join(', ')}`);
    if (finding.fault.notFaultedFrom.length > 0) {
      lines.push(`also reached from ${finding.fault.notFaultedFrom.join(', ')}, not faulted at this level`);
    }
  }
  return lines;
}

function findingLines(finding: Finding, rank: number): string[] {
  const { severity } = finding;
  const where = location(finding.file, finding.line, finding.column);
  const name = finding.functionName === null ? '' : ` in ${finding.functionName}`;
  return [
    `${INDENT}${rank}. [${severity.level} ${severity.score}] ${where}${name}`,
    ...findingDetails(finding).map((line) => `${INDENT}${INDENT}${line}`),
  ];
}

function findingsSection(result: RunResult, shown: number): string[] {
  if (result.findings.length === 0) return [];
  const lines = ['Findings, most severe first:'];
  result.findings.slice(0, shown).forEach((finding, index) => lines.push(...findingLines(finding, index + 1)));
  const hidden = result.findings.length - shown;
  if (hidden > 0) lines.push(`${INDENT}${plural(hidden, 'more finding')} not shown; --json lists every finding`);
  return lines;
}

function ignoredSection(result: RunResult): string[] {
  if (result.ignored.length === 0) return [];
  const byBaseline = result.ignored.filter((entry) => entry.by === 'baseline').length;
  const inline = result.ignored.length - byBaseline;
  return [`${plural(result.ignored.length, 'finding')} ignored (baseline: ${byBaseline}, inline: ${inline}); --json lists them`];
}

function entryLine(entry: BaselineEntry): string {
  if (entry.source === 'mutation') return `${INDENT}${entry.file}: ${entry.mutator} mutant ${entry.replacement}`;
  return `${INDENT}${entry.file}: ${entry.kind} in ${entry.function ?? 'an anonymous function'}`;
}

function baselineSection(result: RunResult): string[] {
  const { baseline } = result;
  if (baseline === null) return [];
  const lines: string[] = [];
  if (baseline.stale.length > 0) {
    lines.push(`Stale baseline entries (${baseline.stale.length}), matching nothing in scope any more; chimpd baseline --prune removes them:`);
    lines.push(...baseline.stale.map(entryLine));
  }
  if (baseline.notEvaluated.length > 0) {
    lines.push(`Baseline entries not evaluated (${baseline.notEvaluated.length}), their code was in scope but not fully checked:`);
    lines.push(...baseline.notEvaluated.map(entryLine));
  }
  return lines;
}

/** These lists repeat a reason many times, such as every mutant a budget cut off, so they are grouped by it. */
function groupedSection(title: string, items: readonly Item[], label: (entry: Item) => string): string[] {
  if (items.length === 0) return [];
  const groups = new Map<string, Item[]>();
  for (const entry of items) {
    const key = firstLine(label(entry));
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  const lines = [`${title} (${items.length}):`];
  for (const [key, group] of groups) {
    const places = [...new Set(group.map((entry) => location(entry.file, entry.line)))];
    lines.push(`${INDENT}${key} (${plural(group.length, 'item')})`);
    lines.push(`${INDENT}${INDENT}${places.join(', ')}`);
  }
  return lines;
}

function sourceOf(entry: Item): string {
  return entry.faultKind === undefined ? entry.source : `${entry.source} (${entry.faultKind})`;
}

function inconclusiveSection(items: readonly Item[]): string[] {
  if (items.length === 0) return [];
  return [
    `Inconclusive (${items.length}):`,
    ...items.map((entry) => `${INDENT}${location(entry.file, entry.line)} ${sourceOf(entry)}: ${firstLine(entry.reason)}`),
  ];
}

function conflictSection(result: RunResult): string[] {
  if (result.conflicts.length === 0) return [];
  return [
    'Conflicts, calls made under these test files were not faulted:',
    ...result.conflicts.map(({ testFile, patched }) => `${INDENT}${testFile} replaces ${patched.join(', ')}`),
  ];
}

function timingLine(phase: PhaseReport): string | null {
  const { timings } = phase;
  if (timings === undefined) return null;
  if ('mutantsRun' in timings) {
    if (timings.batchesStarted === 0) return 'Stryker did not finish its start and dry run';
    const batches = timings.batchesStarted > 1 ? ` over ${timings.batchesStarted} batches` : '';
    const each = perMutantMs(timings);
    const mutants =
      each === null ? 'no mutant run' : `${plural(timings.mutantsRun, 'mutant')} run in ${seconds(timings.mutantsMs)}, ${seconds(each)} each`;
    return `Stryker start and dry run ${seconds(timings.strykerStartMs)}${batches} (the tests ${seconds(timings.dryRunNetMs)} of it), ${mutants}`;
  }
  const discovery = timings.discoveryMs === null ? 'discovery run did not finish' : `discovery run ${seconds(timings.discoveryMs)}`;
  const each = perFaultRunMs(timings);
  const runs = each === null ? 'no faulted run' : `${plural(timings.faultRuns, 'faulted run')} in ${seconds(timings.faultRunsMs)}, ${seconds(each)} each`;
  return `${discovery}, ${runs}`;
}

function phaseSection(result: RunResult): string[] {
  if (result.phases.length === 0) return [];
  return [
    'Phases:',
    ...result.phases.flatMap((phase) => {
      const spent = phase.status === 'not-run' ? '' : ` ${seconds(phase.spentMs)} of ${seconds(phase.budgetMs)}`;
      const timing = timingLine(phase);
      return [
        `${INDENT}${phase.name} ${phase.status}${spent}${phaseReason(phase.statusReason)}`,
        ...(timing === null ? [] : [`${INDENT}${INDENT}${timing}`]),
      ];
    }),
  ];
}

export type SectionName =
  | 'header'
  | 'error'
  | 'scope'
  | 'coverage'
  | 'invalid'
  | 'findings'
  | 'ignored'
  | 'baseline'
  | 'skipped'
  | 'inconclusive'
  | 'conflicts'
  | 'phases'
  | 'result';

export interface TextSection {
  readonly name: SectionName;
  readonly lines: readonly string[];
}

/** The report's sections in order, empty ones left out; the plain report joins them with a blank line. */
export function textSections(result: RunResult, options: ExitOptions = {}): TextSection[] {
  const shown = PRESETS[LEVELS[result.level]].findingsShown;
  const sections: TextSection[] = [
    { name: 'header', lines: header(result) },
    { name: 'error', lines: result.status === 'error' ? [`Error: ${firstErrorLine(result.error) ?? 'unknown error'}`] : [] },
    { name: 'scope', lines: scopeSection(result) },
    { name: 'coverage', lines: coverageSection(result) },
    { name: 'invalid', lines: groupedSection('Invalid mutants', result.invalid, (entry) => entry.reason) },
    { name: 'findings', lines: findingsSection(result, shown) },
    { name: 'ignored', lines: ignoredSection(result) },
    { name: 'baseline', lines: baselineSection(result) },
    { name: 'skipped', lines: groupedSection('Skipped', result.skipped, (entry) => `${sourceOf(entry)}: ${entry.reason}`) },
    { name: 'inconclusive', lines: inconclusiveSection(result.inconclusive) },
    { name: 'conflicts', lines: conflictSection(result) },
    { name: 'phases', lines: phaseSection(result) },
    { name: 'result', lines: [verdictLine(result, options)] },
  ];
  return sections.filter((section) => section.lines.length > 0);
}

export function renderText(result: RunResult, options: ExitOptions = {}): string {
  return `${textSections(result, options).map((section) => section.lines.join('\n')).join('\n\n')}\n`;
}
