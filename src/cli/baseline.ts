import fs from 'node:fs';
import {
  BASELINE_FILE,
  entryKey,
  loadBaseline,
  repositoryPath,
  serializeBaseline,
  type Baseline,
  type BaselineEntry,
} from '../baseline/index.js';
import type { FaultFindingKind } from '../core/index.js';
import { BruiseError, EXIT_CLEAN, EXIT_INCONCLUSIVE, type Finding, type RunOptions, type RunResult } from '../orchestrator/index.js';
import { renderText } from '../reporter/index.js';
import type { BaselineCliOptions } from './args.js';

export interface BaselineIo {
  stdout(text: string): void;
  stderr(text: string): void;
}

function entryCount(count: number): string {
  return `${count} ${count === 1 ? 'entry' : 'entries'}`;
}

function messageOf(error: unknown): string {
  if (error instanceof BruiseError) return error.message;
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

type Converted = { readonly entry: BaselineEntry } | { readonly problem: string };

function toEntry(finding: Finding, prefix: string): Converted {
  const where = `${finding.file}:${finding.line} ${finding.kind}`;
  const file = repositoryPath(prefix, finding.file);
  if (finding.kind === 'invalid-ignore') return { problem: `${where}, an ignore comment needs a reason, not a baseline entry` };
  if (finding.mutation !== null) {
    const { mutatorName, replacement, statement } = finding.mutation;
    if (statement === null) return { problem: `${where}, no enclosing statement was found` };
    return { entry: { source: 'mutation', file, mutator: mutatorName, replacement, statement, reason: null } };
  }
  return { entry: { source: 'fault', file, function: finding.functionName, kind: finding.kind as FaultFindingKind, reason: null } };
}

/** Runs the check and writes its findings to the baseline, keeping what is there and its reasons. */
export async function runBaseline(
  options: BaselineCliOptions,
  io: BaselineIo,
  run: (options: RunOptions) => Promise<RunResult>,
): Promise<number> {
  let baseline: Baseline;
  let result: RunResult;
  try {
    baseline = await loadBaseline(options.cwd);
    result = await run({
      cwd: options.cwd,
      level: options.level,
      ...(options.base === undefined ? {} : { base: options.base }),
      ...(options.seed === undefined ? {} : { seed: options.seed }),
      ...(options.verbose ? { onTargetOutput: (text: string) => io.stderr(text) } : {}),
    });
  } catch (error) {
    io.stderr(`bruise: ${messageOf(error)}\n`);
    return EXIT_INCONCLUSIVE;
  }

  io.stdout(renderText(result));
  if (result.status === 'error' || result.status === 'inconclusive') {
    io.stdout(`\nNothing written: the run is ${result.status}, so its findings are not a baseline\n`);
    return EXIT_INCONCLUSIVE;
  }

  const stale = new Set((result.baseline?.stale ?? []).map(entryKey));
  const kept = baseline.entries.filter((entry) => !(options.prune && stale.has(entryKey(entry))));
  const known = new Set(kept.map(entryKey));
  const added: BaselineEntry[] = [];
  const problems: string[] = [];
  for (const finding of result.findings) {
    const converted = toEntry(finding, baseline.prefix);
    if ('problem' in converted) {
      problems.push(converted.problem);
      continue;
    }
    const key = entryKey(converted.entry);
    if (known.has(key)) continue;
    known.add(key);
    added.push(converted.entry);
  }

  const entries = [...kept, ...added];
  fs.writeFileSync(baseline.path, serializeBaseline(entries));
  const pruned = baseline.entries.length - kept.length;
  const lines = [
    '',
    `Wrote ${BASELINE_FILE}: ${entryCount(entries.length)}, ${added.length} added, ${kept.length} kept, ${pruned} pruned`,
    ...problems.map((problem) => `Not written: ${problem}`),
  ];
  if (!options.prune && stale.size > 0) {
    const one = stale.size === 1;
    lines.push(`${stale.size} stale ${one ? 'entry' : 'entries'} kept; bruise baseline --prune removes ${one ? 'it' : 'them'}`);
  }
  if (result.status === 'partial') lines.push('The run was partial: findings in what it did not check are not in the baseline');
  io.stdout(`${lines.join('\n')}\n`);
  return EXIT_CLEAN;
}
