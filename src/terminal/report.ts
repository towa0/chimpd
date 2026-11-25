import { PRESETS } from '../core/index.js';
import { exitCodeOf, LEVELS, type ExitOptions, type Finding, type RunResult } from '../orchestrator/index.js';
import { findingDetails, plural, seconds, textSections, verdictLine, type TextSection } from '../reporter/text.js';
import { visibleLength, type Palette } from './color.js';

const INDENT = '  ';
const DETAIL = '    ';

function severityTag(finding: Finding, palette: Palette): string {
  const tag = `[${finding.severity.level} ${finding.severity.score}]`;
  if (finding.severity.level === 'high') return palette.red(tag);
  if (finding.severity.level === 'medium') return palette.yellow(tag);
  return palette.dim(tag);
}

/** One line per finding that starts with path:line:col, which many terminals make clickable, and its reason under it. */
function findingsSection(result: RunResult, palette: Palette): string[] {
  const shown = PRESETS[LEVELS[result.level]].findingsShown;
  const lines = [palette.bold('Findings, most severe first:')];
  for (const finding of result.findings.slice(0, shown)) {
    const name = finding.functionName === null ? '' : ` in ${finding.functionName}`;
    lines.push(`${palette.highlight(`${finding.file}:${finding.line}:${finding.column}`)} ${severityTag(finding, palette)}${name}`);
    lines.push(...findingDetails(finding).map((line) => `${DETAIL}${line}`));
  }
  const hidden = result.findings.length - shown;
  if (hidden > 0) lines.push(`${INDENT}${plural(hidden, 'more finding')} not shown; --json lists every finding`);
  return lines;
}

function phaseLine(line: string, palette: Palette): string {
  return line
    .replace(/^( {2}\S+ )(completed)/, (_, lead: string, status: string) => `${lead}${palette.green(status)}`)
    .replace(/^( {2}\S+ )(budget-exhausted|inconclusive)/, (_, lead: string, status: string) => `${lead}${palette.yellow(status)}`)
    .replace(/^( {2}\S+ )(error)/, (_, lead: string, status: string) => `${lead}${palette.red(status)}`);
}

function styled(section: TextSection, palette: Palette): string[] {
  const [first = '', ...rest] = section.lines;
  if (section.name === 'error') return [palette.red(first), ...rest];
  if (section.name === 'coverage') {
    return [palette.bold(first), ...rest.map((line) => (line.includes('NOT CHECKED') ? palette.yellow(line) : line))];
  }
  if (section.name === 'phases') return [palette.bold(first), ...rest.map((line) => phaseLine(line, palette))];
  return [palette.bold(first), ...rest];
}

function count(value: number, label: string, paint: (text: string) => string): string {
  const text = `${label} ${value}`;
  return value > 0 ? paint(text) : text;
}

function summaryLines(result: RunResult, palette: Palette): string[] {
  const { tally } = result;
  const notTested = result.notTested.reduce((total, entry) => total + (entry.mutants ?? 0), 0);
  const unplanned = result.notTested.filter((entry) => entry.mutants === null).length;
  const mutationRan = result.phases.some((phase) => phase.name === 'mutation' && phase.status !== 'not-run');
  const mutants = mutationRan
    ? [
        count(tally.killed, 'killed', palette.green),
        count(tally.survived, 'survived', palette.highlight),
        result.invalidExcluded
          ? palette.dim(`invalid ${result.checked.invalidMutants}, excluded`)
          : count(result.checked.invalidMutants, 'invalid', palette.yellow),
        `${count(notTested, 'not tested', palette.yellow)}${unplanned > 0 ? ` (+${plural(unplanned, 'file')} never planned)` : ''}`,
      ].join(', ')
    : 'not run';
  const faults =
    tally.faults.length === 0
      ? [result.phases.some((phase) => phase.name === 'faults' && phase.status !== 'not-run') ? 'no site faulted' : 'not run']
      : tally.faults.map(
          (entry) =>
            `${entry.kind}: ${[
              count(entry.handled, 'handled', palette.green),
              count(entry.findings, 'findings', palette.highlight),
              count(entry.inconclusive, 'inconclusive', palette.yellow),
            ].join(', ')}`,
        );
  return [
    palette.bold('Summary'),
    `Mutants  ${mutants}`,
    ...faults.map((line, index) => `${index === 0 ? 'Faults   ' : '         '}${line}`),
    `Time     ${seconds(result.spentMs)} of ${seconds(result.budgetMs)}`,
  ];
}

function box(lines: readonly string[], width: number): string[] {
  const inner = Math.max(...lines.map(visibleLength));
  if (inner + 4 > width) return [...lines];
  const rule = `+${'-'.repeat(inner + 2)}+`;
  return [rule, ...lines.map((line) => `| ${line}${' '.repeat(inner - visibleLength(line))} |`), rule];
}

function resultLine(result: RunResult, options: ExitOptions, palette: Palette): string {
  const line = palette.bold(verdictLine(result, options));
  const code = exitCodeOf(result, options);
  if (code === 1 || result.status === 'error') return palette.red(line);
  if (code === 0 && result.status === 'completed') return palette.green(line);
  return palette.yellow(line);
}

/** The text report for a terminal: the plain report's content, with colour, one line per finding and a summary at the end. */
export function renderFancyText(result: RunResult, options: ExitOptions, palette: Palette, width: number): string {
  const sections = textSections(result, options).flatMap((section): string[][] => {
    if (section.name === 'result') return [];
    if (section.name === 'findings') return [findingsSection(result, palette)];
    return [styled(section, palette)];
  });
  const closing = result.status === 'error' ? [] : [box(summaryLines(result, palette), width)];
  return `${[...sections, ...closing, [resultLine(result, options, palette)]].map((lines) => lines.join('\n')).join('\n\n')}\n`;
}
