import fs from 'node:fs';
import path from 'node:path';
import { FINDING_FAULT_KIND, rangeForLine, type MutantRecord, type ScopeRange } from '../core/index.js';
import type { CallSiteResult } from '../fault-run/index.js';
import type { Finding, IgnoredFinding } from '../orchestrator/types.js';
import { severityOf } from '../severity/index.js';
import { entryKey, repositoryPath, targetPath, type Baseline, type BaselineEntry } from './file.js';
import { SourceStatements } from './statement.js';

export interface IgnoreInput {
  readonly targetRoot: string;
  readonly baseline: Baseline;
  /** Every finding of the run, most severe first. */
  readonly findings: readonly Finding[];
  /** Every mutant the mutation phase considered, killed ones included. */
  readonly mutants: readonly MutantRecord[];
  readonly mutationRanges: readonly ScopeRange[];
  readonly faultRanges: readonly ScopeRange[];
  /** Call sites that were faulted and got a verdict. */
  readonly faulted: readonly CallSiteResult[];
}

export interface IgnoreOutcome {
  /** What is left to report: findings no ignore matched, and every ignore comment without a reason. */
  readonly findings: readonly Finding[];
  readonly ignored: readonly IgnoredFinding[];
  /** Entries whose code was checked in full and that matched nothing. */
  readonly stale: readonly BaselineEntry[];
  /** Entries whose code was in scope but not checked well enough to tell. */
  readonly notEvaluated: readonly BaselineEntry[];
}

const KILLED = new Set(['Killed', 'Timeout']);
const INVALID_IGNORE = 'bruise-ignore without a reason is not honoured; write // bruise-ignore: <reason>';

class Sources {
  readonly #root: string;
  readonly #parsed = new Map<string, SourceStatements | null>();

  constructor(root: string) {
    this.#root = root;
  }

  get(file: string): SourceStatements | null {
    if (!this.#parsed.has(file)) {
      const full = path.join(this.#root, file);
      this.#parsed.set(file, fs.existsSync(full) ? new SourceStatements(full, fs.readFileSync(full, 'utf8')) : null);
    }
    return this.#parsed.get(file) ?? null;
  }
}

function innermostHash(sources: Sources, file: string, line: number, column: number): string | null {
  return sources.get(file)?.enclosing(line, column)[0]?.hash ?? null;
}

function withStatement(finding: Finding, sources: Sources): Finding {
  if (finding.mutation === null) return finding;
  return { ...finding, mutation: { ...finding.mutation, statement: innermostHash(sources, finding.file, finding.line, finding.column) } };
}

function inlineReason(sources: Sources, finding: Finding): string | null {
  const source = sources.get(finding.file);
  if (source === null) return null;
  const valid = new Map(source.directives().filter((entry) => entry.reason !== null).map((entry) => [entry.line, entry.reason]));
  for (const statement of source.enclosing(finding.line, finding.column)) {
    const reason = valid.get(statement.startLine - 1);
    if (reason !== undefined && reason !== null) return reason;
  }
  return null;
}

function inScope(ranges: readonly ScopeRange[], file: string, line: number): boolean {
  return rangeForLine(ranges, file, line) !== null;
}

function invalidIgnores(sources: Sources, input: IgnoreInput): Finding[] {
  const ranges = [...input.mutationRanges, ...input.faultRanges];
  const files = [...new Set(ranges.map((range) => range.file))].sort();
  const findings: Finding[] = [];
  for (const file of files) {
    for (const directive of sources.get(file)?.directives() ?? []) {
      if (directive.reason !== null) continue;
      if (!inScope(ranges, file, directive.line) && !inScope(ranges, file, directive.line + 1)) continue;
      findings.push({
        source: 'mutation',
        kind: 'invalid-ignore',
        file,
        line: directive.line,
        column: 1,
        functionName: null,
        message: INVALID_IGNORE,
        severity: severityOf('invalid-ignore', 0),
        mutation: null,
        fault: null,
      });
    }
  }
  return findings;
}

function matches(entry: BaselineEntry, prefix: string, finding: Finding): boolean {
  if (entry.file !== repositoryPath(prefix, finding.file)) return false;
  if (entry.source === 'mutation') {
    const { mutation } = finding;
    return (
      mutation !== null &&
      entry.mutator === mutation.mutatorName &&
      entry.replacement === mutation.replacement &&
      entry.statement === mutation.statement
    );
  }
  return finding.fault !== null && finding.functionName === entry.function && finding.kind === entry.kind;
}

type Verdict = 'stale' | 'not-evaluated' | 'untouched';

function mutationVerdict(entry: BaselineEntry & { source: 'mutation' }, file: string, input: IgnoreInput, sources: Sources): Verdict {
  const source = sources.get(file);
  if (source === null) return 'stale';
  if (!input.mutationRanges.some((range) => range.file === file)) return 'untouched';
  const statements = source.all().filter((statement) => statement.hash === entry.statement);
  if (statements.length === 0) return 'stale';
  const scoped = statements.some((statement) =>
    input.mutationRanges.some((range) => range.file === file && range.startLine <= statement.endLine && range.endLine >= statement.startLine),
  );
  if (!scoped) return 'untouched';
  const candidates = input.mutants.filter(
    (mutant) =>
      mutant.file === file &&
      mutant.mutatorName === entry.mutator &&
      mutant.replacement === entry.replacement &&
      innermostHash(sources, file, mutant.start.line, mutant.start.column) === entry.statement,
  );
  return candidates.length > 0 && candidates.every((mutant) => KILLED.has(mutant.status)) ? 'stale' : 'not-evaluated';
}

function faultVerdict(entry: BaselineEntry & { source: 'fault' }, file: string, input: IgnoreInput): Verdict {
  const faulted = input.faulted.filter(
    (result) =>
      result.kind === FINDING_FAULT_KIND[entry.kind] &&
      result.site.file === file &&
      result.site.functionName === entry.function &&
      result.verdict !== 'inconclusive',
  );
  return faulted.length > 0 && faulted.every((result) => result.findingKind !== entry.kind) ? 'stale' : 'untouched';
}

/**
 * Sets aside the findings an inline comment or a baseline entry accepts, keeps them listed, and
 * sorts the baseline's unmatched entries into stale ones and ones this run could not judge.
 */
export function applyIgnores(input: IgnoreInput): IgnoreOutcome {
  const sources = new Sources(input.targetRoot);
  const { prefix, entries } = input.baseline;
  const kept: Finding[] = [];
  const ignored: IgnoredFinding[] = [];
  const matched = new Set<string>();

  for (const original of input.findings) {
    const finding = withStatement(original, sources);
    const inline = inlineReason(sources, finding);
    const entry = entries.find((candidate) => matches(candidate, prefix, finding));
    if (entry !== undefined) matched.add(entryKey(entry));
    if (inline !== null) ignored.push({ finding, by: 'inline', reason: inline });
    else if (entry !== undefined) ignored.push({ finding, by: 'baseline', reason: entry.reason });
    else kept.push(finding);
  }

  const stale: BaselineEntry[] = [];
  const notEvaluated: BaselineEntry[] = [];
  for (const entry of entries) {
    if (matched.has(entryKey(entry))) continue;
    const file = targetPath(prefix, entry.file);
    if (file === null) continue;
    const verdict = entry.source === 'mutation' ? mutationVerdict(entry, file, input, sources) : faultVerdict(entry, file, input);
    if (verdict === 'stale') stale.push(entry);
    else if (verdict === 'not-evaluated') notEvaluated.push(entry);
  }

  return { findings: [...invalidIgnores(sources, input), ...kept], ignored, stale, notEvaluated };
}
