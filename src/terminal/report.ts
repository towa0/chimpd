import { exitCodeOf, type ExitOptions, type Finding, type RunResult } from '../orchestrator/index.js';
import {
  findingDetails,
  findingsShown,
  hiddenFindingsLine,
  plural,
  seconds,
  textSections,
  verdictLine,
  type ReportOptions,
  type TextSection,
} from '../reporter/text.js';
import { visibleLength } from './color.js';
import type { Paint, Theme } from './theme.js';

const INDENT = '  ';
const DETAIL = '    ';

function severityTag(finding: Finding, theme: Theme): string {
  return theme.severity[finding.severity.level](`[${finding.severity.level} ${finding.severity.score}]`);
}

/** One line per finding that starts with path:line:col, which many terminals make clickable, and its reason under it. */
function findingsSection(result: RunResult, theme: Theme, shown: number): string[] {
  const lines = [theme.title('Findings, most severe first:')];
  for (const finding of result.findings.slice(0, shown)) {
    const name = finding.functionName === null ? '' : ` in ${finding.functionName}`;
    lines.push(`${theme.bold(`${finding.file}:${finding.line}:${finding.column}`)} ${severityTag(finding, theme)}${name}`);
    lines.push(...findingDetails(finding).map((line) => theme.dim(`${DETAIL}${line}`)));
  }
  const hidden = result.findings.length - shown;
  if (hidden > 0) lines.push(theme.dim(`${INDENT}${hiddenFindingsLine(hidden)}`));
  return lines;
}

function phaseLine(line: string, theme: Theme): string {
  return line
    .replace(/^( {2}\S+ )(completed)/, (_, lead: string, status: string) => `${lead}${theme.good(status)}`)
    .replace(/^( {2}\S+ )(budget-exhausted|inconclusive)/, (_, lead: string, status: string) => `${lead}${theme.warning(status)}`)
    .replace(/^( {2}\S+ )(error)/, (_, lead: string, status: string) => `${lead}${theme.error(status)}`);
}

function coverageLine(line: string, theme: Theme): string {
  if (line.includes('NOT CHECKED') || line.includes('excluded from coverage')) return theme.warning(line);
  if (line.includes('nothing in scope was left unchecked')) return theme.good(line);
  return line;
}

function styled(section: TextSection, theme: Theme): string[] {
  const [first = '', ...rest] = section.lines;
  if (section.name === 'error') return [theme.error(first), ...rest];
  if (section.name === 'coverage') return [theme.title(first), ...rest.map((line) => coverageLine(line, theme))];
  if (section.name === 'phases') return [theme.title(first), ...rest.map((line) => phaseLine(line, theme))];
  return [theme.title(first), ...rest];
}

function count(value: number, label: string, paint: Paint): string {
  const text = `${label} ${value}`;
  return value > 0 ? paint(text) : text;
}

function summaryLines(result: RunResult, theme: Theme): string[] {
  const { tally } = result;
  const notTested = result.notTested.reduce((total, entry) => total + (entry.mutants ?? 0), 0);
  const unplanned = result.notTested.filter((entry) => entry.mutants === null).length;
  const mutationRan = result.phases.some((phase) => phase.name === 'mutation' && phase.status !== 'not-run');
  const invalid = result.checked.invalidMutants;
  const mutants = mutationRan
    ? [
        count(tally.killed, 'killed', theme.good),
        count(tally.survived, 'survived', theme.brand),
        result.invalidExcluded ? theme.warning(`invalid ${invalid} (excluded)`) : count(invalid, 'invalid', theme.warning),
        `${count(notTested, 'not tested', theme.warning)}${unplanned > 0 ? ` (+${plural(unplanned, 'file')} never planned)` : ''}`,
      ].join(', ')
    : 'not run';
  const faults =
    tally.faults.length === 0
      ? [result.phases.some((phase) => phase.name === 'faults' && phase.status !== 'not-run') ? 'no site faulted' : 'not run']
      : tally.faults.map(
          (entry) =>
            `${entry.kind}: ${[
              count(entry.handled, 'handled', theme.good),
              count(entry.findings, 'findings', theme.brand),
              count(entry.inconclusive, 'inconclusive', theme.warning),
            ].join(', ')}`,
        );
  return [
    theme.title('Summary'),
    `Mutants  ${mutants}`,
    ...faults.map((line, index) => `${index === 0 ? 'Faults   ' : '         '}${line}`),
    `Time     ${seconds(result.spentMs)} of ${seconds(result.budgetMs)}`,
  ];
}

function box(lines: readonly string[], width: number, theme: Theme): string[] {
  const inner = Math.max(...lines.map(visibleLength));
  if (inner + 4 > width) return [...lines];
  const rule = theme.dim(`+${'-'.repeat(inner + 2)}+`);
  const side = theme.dim('|');
  return [rule, ...lines.map((line) => `${side} ${line}${' '.repeat(inner - visibleLength(line))} ${side}`), rule];
}

function resultLine(result: RunResult, options: ExitOptions, theme: Theme): string {
  const code = exitCodeOf(result, options);
  const paint =
    result.status === 'error' || code === 2
      ? theme.error
      : code === 1
        ? theme.brand
        : result.status === 'completed'
          ? theme.good
          : theme.warning;
  const segments = verdictLine(result, options).split(/(coverage complete|coverage partial)/);
  const painted = segments.map((segment) =>
    segment === 'coverage complete' ? theme.good(segment) : segment === 'coverage partial' ? theme.warning(segment) : paint(segment),
  );
  return theme.bold(painted.join(''));
}

/** The text report for a terminal: the plain report's content, with colour, one line per finding and a summary at the end. */
export function renderFancyText(result: RunResult, options: ReportOptions, theme: Theme, width: number): string {
  const sections = textSections(result, options).flatMap((section): string[][] => {
    if (section.name === 'result') return [];
    if (section.name === 'findings') return [findingsSection(result, theme, findingsShown(options))];
    return [styled(section, theme)];
  });
  const closing = result.status === 'error' ? [] : [box(summaryLines(result, theme), width, theme)];
  return `${[...sections, ...closing, [resultLine(result, options, theme)]].map((lines) => lines.join('\n')).join('\n\n')}\n`;
}
