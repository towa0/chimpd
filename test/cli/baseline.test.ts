import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BASELINE_FILE, parseBaseline, serializeBaseline, type BaselineEntry } from '../../src/baseline/index.js';
import { parseCliArgs } from '../../src/cli/args.js';
import { runCli } from '../../src/cli/run.js';
import type { Finding, RunOptions, RunResult } from '../../src/orchestrator/index.js';
import { severityOf } from '../../src/severity/index.js';
import { faultFinding, mutationFinding, runResult } from '../helpers/run-fixtures.js';
import { createTempRepo, type TempRepo } from '../helpers/temp-repo.js';

const repos: TempRepo[] = [];

afterEach(() => {
  for (const repo of repos.splice(0)) repo.cleanup();
});

function repo(): TempRepo {
  const created = createTempRepo();
  repos.push(created);
  created.write('README.md', '# a\n');
  created.commit('Base');
  return created;
}

function survivor(statement: string | null, replacement = 'orderTotal > 120'): Finding {
  return mutationFinding({
    file: 'src/discount.ts',
    mutation: { mutatorName: 'EqualityOperator', replacement, status: 'Survived', endLine: 3, endColumn: 24, coveredBy: [], statement },
  });
}

const MUTATION_ENTRY: BaselineEntry = {
  source: 'mutation',
  file: 'src/discount.ts',
  mutator: 'EqualityOperator',
  replacement: 'orderTotal > 120',
  statement: 'aaaaaaaaaaaaaaaa',
  reason: null,
};

interface Captured {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly calls: RunOptions[];
}

async function baseline(argv: string[], result: RunResult): Promise<Captured> {
  let stdout = '';
  let stderr = '';
  const calls: RunOptions[] = [];
  const code = await runCli(argv, { stdout: (text) => (stdout += text), stderr: (text) => (stderr += text) }, {
    run: (options) => {
      calls.push(options);
      return Promise.resolve(result);
    },
  });
  return { code, stdout, stderr, calls };
}

function written(target: TempRepo): BaselineEntry[] {
  return parseBaseline(fs.readFileSync(path.join(target.dir, BASELINE_FILE), 'utf8'));
}

describe('chimpd baseline', () => {
  it('runs with the given options and writes the current findings to the baseline at the repository root', async () => {
    const target = repo();
    const fault = faultFinding({ file: 'src/clients/ledger.ts', functionName: 'postLedgerEntry' });
    const run = await baseline(['baseline', '--level', 'prod', '--seed', '3', '--cwd', target.dir], runResult({ findings: [fault, survivor('aaaaaaaaaaaaaaaa')] }));
    expect(run.calls).toMatchObject([{ cwd: target.dir, level: 'prod', seed: 3 }]);
    expect(written(target)).toEqual([
      { source: 'fault', file: 'src/clients/ledger.ts', function: 'postLedgerEntry', kind: 'hang-no-timeout', reason: null },
      MUTATION_ENTRY,
    ]);
    expect(run.stdout).toContain('Wrote chimpd-baseline.json: 2 entries, 2 added, 0 kept, 0 pruned');
    expect(run.code).toBe(0);
  });

  it('keeps existing entries with their reasons and does not add a finding twice', async () => {
    const target = repo();
    const kept = { ...MUTATION_ENTRY, reason: 'equivalent: the bound is checked upstream' };
    target.write(BASELINE_FILE, serializeBaseline([kept]));
    const run = await baseline(['baseline', '--level', 'poke', '--cwd', target.dir], runResult({ findings: [survivor('aaaaaaaaaaaaaaaa'), survivor('bbbbbbbbbbbbbbbb', 'false')] }));
    expect(written(target)).toEqual([{ ...MUTATION_ENTRY, replacement: 'false', statement: 'bbbbbbbbbbbbbbbb' }, kept]);
    expect(run.stdout).toContain('2 entries, 1 added, 1 kept, 0 pruned');
  });

  it('keeps stale entries without --prune and says how to remove them', async () => {
    const target = repo();
    target.write(BASELINE_FILE, serializeBaseline([MUTATION_ENTRY]));
    const result = runResult({
      findings: [],
      baseline: { file: BASELINE_FILE, present: true, entries: 1, stale: [MUTATION_ENTRY], notEvaluated: [] },
    });
    const run = await baseline(['baseline', '--level', 'poke', '--cwd', target.dir], result);
    expect(written(target)).toEqual([MUTATION_ENTRY]);
    expect(run.stdout).toContain('1 stale entry kept; chimpd baseline --prune removes it');
  });

  it('removes only the stale entries with --prune, never the ones it could not evaluate', async () => {
    const target = repo();
    const unknown: BaselineEntry = { source: 'fault', file: 'src/b.ts', function: 'load', kind: 'fire-and-forget', reason: 'later' };
    target.write(BASELINE_FILE, serializeBaseline([MUTATION_ENTRY, unknown]));
    const result = runResult({
      findings: [],
      baseline: { file: BASELINE_FILE, present: true, entries: 2, stale: [MUTATION_ENTRY], notEvaluated: [unknown] },
    });
    const run = await baseline(['baseline', '--level', 'poke', '--prune', '--cwd', target.dir], result);
    expect(written(target)).toEqual([unknown]);
    expect(run.stdout).toContain('1 entry, 0 added, 1 kept, 1 pruned');
    expect(run.code).toBe(0);
  });

  it('does not write findings that cannot be baselined, and says so', async () => {
    const target = repo();
    const invalid = mutationFinding({ kind: 'invalid-ignore', mutation: null, severity: severityOf('invalid-ignore', 0), line: 4, message: 'chimpd-ignore without a reason' });
    const run = await baseline(['baseline', '--level', 'poke', '--cwd', target.dir], runResult({ findings: [invalid, survivor(null)] }));
    expect(written(target)).toEqual([]);
    expect(run.stdout).toContain('Not written: src/discount.ts:4 invalid-ignore, an ignore comment needs a reason, not a baseline entry');
    expect(run.stdout).toContain('Not written: src/discount.ts:3 survived, no enclosing statement was found');
  });

  it('prefixes paths with the target directory when the target is not the repository root', async () => {
    const target = repo();
    target.write('packages/api/package.json', '{}\n');
    await baseline(['baseline', '--level', 'poke', '--cwd', path.join(target.dir, 'packages/api')], runResult({ findings: [survivor('aaaaaaaaaaaaaaaa')] }));
    expect(written(target)).toEqual([{ ...MUTATION_ENTRY, file: 'packages/api/src/discount.ts' }]);
  });

  it.each(['error', 'inconclusive'] as const)('writes nothing and exits 2 when the run is %s', async (status) => {
    const target = repo();
    target.write(BASELINE_FILE, serializeBaseline([MUTATION_ENTRY]));
    const before = target.read(BASELINE_FILE);
    const run = await baseline(['baseline', '--level', 'poke', '--cwd', target.dir], runResult({ status, error: status === 'error' ? 'boom' : null, findings: [] }));
    expect(run.code).toBe(2);
    expect(run.stdout).toContain(`Nothing written: the run is ${status}`);
    expect(target.read(BASELINE_FILE)).toBe(before);
  });

  it('writes nothing and exits 2 when the existing baseline cannot be read', async () => {
    const target = repo();
    target.write(BASELINE_FILE, '{ "version": 2, "entries": [] }\n');
    const run = await baseline(['baseline', '--level', 'poke', '--cwd', target.dir], runResult({ findings: [survivor('aaaaaaaaaaaaaaaa')] }));
    expect(run.code).toBe(2);
    expect(run.stderr).toContain('chimpd: chimpd-baseline.json has version 2; this chimpd reads version 1');
    expect(target.read(BASELINE_FILE)).toBe('{ "version": 2, "entries": [] }\n');
  });
});

describe('baseline arguments', () => {
  const CWD = path.resolve('/work/project');

  it('reads the baseline command with --prune and the run flags it shares', () => {
    expect(parseCliArgs(['baseline', '--level', 'poke', '--prune', '--seed', '2', '--base', 'main'], CWD)).toMatchObject({
      kind: 'baseline',
      options: { level: 'poke', prune: true, seed: 2, base: 'main', cwd: CWD },
    });
    expect(parseCliArgs(['baseline', '--level', 'shake'], CWD)).toMatchObject({ kind: 'baseline', options: { prune: false } });
  });

  it.each([
    [['run', '--level', 'poke', '--prune'], '--prune only applies to chimpd baseline'],
    [['baseline', '--level', 'poke', '--plan'], '--plan only applies to chimpd run'],
    [['baseline', '--level', 'poke', '--json'], '--json only applies to chimpd run'],
    [['baseline', '--level', 'poke', '--strict'], '--strict only applies to chimpd run'],
    [['baseline'], '--level is required: poke, prod or shake'],
    [['scan'], "unknown command 'scan'; the commands are run and baseline"],
  ])('rejects %j', (argv, message) => {
    expect(parseCliArgs(argv, CWD)).toEqual({ kind: 'error', message });
  });
});
