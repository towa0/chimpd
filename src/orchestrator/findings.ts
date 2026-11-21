import { firstErrorLine, type MutantRecord, type Preset } from '../core/index.js';
import type { CallSite, FaultRunResult, SkipReason } from '../fault-run/index.js';
import { mutationFindingKind, priorOf, severityOf } from '../severity/index.js';
import type { MutationResult } from '../stryker-adapter/index.js';
import type { Checked, Finding, Item } from './types.js';

export const NOTHING_CHECKED: Checked = { mutants: 0, invalidMutants: 0, callSites: 0 };

const VERDICT_STATUSES = new Set(['Killed', 'Survived', 'NoCoverage', 'Timeout']);
const INVALID_STATUSES = new Set(['CompileError', 'RuntimeError']);

export interface PhaseItems {
  readonly checked: Checked;
  readonly findings: readonly Finding[];
  readonly invalid: readonly Item[];
  readonly skipped: readonly Item[];
  readonly inconclusive: readonly Item[];
}

function mutantFinding(mutant: MutantRecord): Finding | null {
  const kind = mutationFindingKind(mutant.status);
  if (kind === null) return null;
  const what = kind === 'survived' ? 'survived every test that covers it' : 'is not covered by any test';
  return {
    source: 'mutation',
    kind,
    file: mutant.file,
    line: mutant.start.line,
    column: mutant.start.column,
    functionName: null,
    message: `${mutant.mutatorName} mutant ${what}: ${mutant.replacement}`,
    severity: severityOf(kind, priorOf(mutant.file)),
    mutation: {
      mutatorName: mutant.mutatorName,
      replacement: mutant.replacement,
      status: mutant.status,
      endLine: mutant.end.line,
      endColumn: mutant.end.column,
      coveredBy: mutant.coveredBy,
    },
    fault: null,
  };
}

function mutantItem(mutant: MutantRecord, reason: string): Item {
  return { source: 'mutation', file: mutant.file, line: mutant.start.line, reason };
}

function firstLine(text: string | null): string {
  return (
    (text ?? '')
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line !== '') ?? 'Stryker reported no reason'
  );
}

function invalidReason(mutant: MutantRecord): string {
  const kind = mutant.status === 'CompileError' ? 'compile error' : 'runtime error';
  return `${kind}: ${firstLine(mutant.statusReason)}`;
}

export const SUITE_FAILS = "the target's own tests fail before any mutant runs";

function unplannedReason(result: MutationResult, file: string): string {
  const batch = result.batches.find((entry) => entry.files.includes(file));
  if (batch?.outcome === 'dry-run-failed') return `not mutated: ${SUITE_FAILS}`;
  if (batch?.outcome === 'failed') return `mutants never planned: batch failed: ${firstErrorLine(batch.error) ?? 'no error reported'}`;
  return 'mutants never planned: the budget ran out first';
}

/**
 * Findings and gaps from a mutation run. In test-only mode `findingMutants` is the set the changed
 * tests cover but do not kill, and only boundary mutants those tests cover are considered at all.
 */
export function mutationItems(
  result: MutationResult,
  considered: readonly MutantRecord[],
  findingMutants: readonly MutantRecord[] | null,
): PhaseItems {
  const findings = (findingMutants ?? considered).flatMap((mutant) => mutantFinding(mutant) ?? []);
  const skipped: Item[] = [];
  for (const mutant of considered) {
    if (mutant.status === 'NotTested') skipped.push(mutantItem(mutant, mutant.statusReason ?? 'not tested'));
    else if (mutant.status === 'Ignored') {
      const reason = mutant.static ? result.staticSkipped.reason : (mutant.statusReason ?? 'ignored by Stryker');
      skipped.push(mutantItem(mutant, reason));
    }
  }
  for (const file of result.notTested.unplannedFiles) {
    skipped.push({ source: 'mutation', file, line: null, reason: unplannedReason(result, file) });
  }
  const checked: Checked = {
    ...NOTHING_CHECKED,
    mutants: considered.filter((mutant) => VERDICT_STATUSES.has(mutant.status)).length,
    invalidMutants: considered.filter((mutant) => INVALID_STATUSES.has(mutant.status)).length,
  };
  const invalid = considered.filter((mutant) => INVALID_STATUSES.has(mutant.status)).map((mutant) => mutantItem(mutant, invalidReason(mutant)));
  return { checked, findings, invalid, skipped, inconclusive: [] };
}

function skipReason(reason: SkipReason, preset: Preset): string {
  if (reason === 'budget') return 'not faulted: the budget ran out first';
  if (reason === 'over-cap') return `not faulted: over the preset cap of ${preset.maxFaultedCallSites} call sites`;
  return 'not faulted: no passing test makes this call';
}

function siteItem(site: CallSite, reason: string): Item {
  return { source: 'fault', file: site.file, line: site.line, reason };
}

export function faultItems(result: FaultRunResult, preset: Preset): PhaseItems {
  const findings: Finding[] = [];
  const inconclusive: Item[] = [];
  let callSites = 0;
  for (const entry of result.results) {
    if (entry.verdict !== 'inconclusive') callSites += 1;
    const { site } = entry;
    if (entry.findingKind !== null) {
      findings.push({
        source: 'fault',
        kind: entry.findingKind,
        file: site.file,
        line: site.line,
        column: site.column,
        functionName: site.functionName,
        message: entry.reason,
        severity: severityOf(entry.findingKind, site.prior),
        mutation: null,
        fault: {
          verdict: entry.verdict,
          path: site.path,
          tests: entry.tests.map(({ test }) => `${test.file} > ${test.name}`),
        },
      });
    } else if (entry.verdict === 'inconclusive') {
      inconclusive.push(siteItem(site, entry.reason));
    }
  }
  const skipped = result.skipped.map(({ site, reason }) => siteItem(site, skipReason(reason, preset)));
  return { checked: { ...NOTHING_CHECKED, callSites }, findings, invalid: [], skipped, inconclusive };
}
