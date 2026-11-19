import { describe, expect, it } from 'vitest';
import { packageVersion, runCli, type CliDeps } from '../../src/cli/run.js';
import type { RunOptions, RunResult } from '../../src/orchestrator/index.js';
import { runResult } from '../helpers/run-fixtures.js';

interface Captured {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly calls: RunOptions[];
}

async function cli(argv: string[], result: RunResult | Error = runResult()): Promise<Captured> {
  let stdout = '';
  let stderr = '';
  const calls: RunOptions[] = [];
  const deps: Partial<CliDeps> = {
    cwd: '/work',
    version: () => '9.9.9',
    run: (options) => {
      calls.push(options);
      return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
    },
  };
  const code = await runCli(argv, { stdout: (text) => (stdout += text), stderr: (text) => (stderr += text) }, deps);
  return { code, stdout, stderr, calls };
}

const partial = runResult({
  status: 'partial',
  findings: [],
  skipped: [{ source: 'fault', file: 'src/b.ts', line: 3, reason: 'not faulted: over the preset cap of 3 call sites' }],
});

describe('the run command', () => {
  it('passes the options through and prints the text report', async () => {
    const run = await cli(['run', '--level', 'prod', '--base', 'main', '--seed', '5']);
    expect(run.calls).toEqual([{ cwd: expect.stringContaining('work') as string, level: 'prod', base: 'main', seed: 5 }]);
    expect(run.stdout).toContain('Findings, most severe first:');
    expect(run.stderr).toBe('');
    expect(run.code).toBe(1);
  });

  it('prints the JSON report with --json', async () => {
    const run = await cli(['run', '--level', 'poke', '--json']);
    expect(JSON.parse(run.stdout)).toMatchObject({ schemaVersion: 1, exitCode: 1, strict: false });
    expect(run.code).toBe(1);
  });

  it('exits by findings on a partial run, and 2 with --strict', async () => {
    expect((await cli(['run', '--level', 'poke'], partial)).code).toBe(0);
    const strict = await cli(['run', '--level', 'poke', '--strict', '--json'], partial);
    expect(strict.code).toBe(2);
    expect(JSON.parse(strict.stdout)).toMatchObject({ exitCode: 2, strict: true });
  });

  it('exits 0 on a clean run and 2 on a tool error or an inconclusive run', async () => {
    expect((await cli(['run', '--level', 'poke'], runResult({ findings: [] }))).code).toBe(0);
    const failed = await cli(['run', '--level', 'poke'], runResult({ status: 'error', error: 'not a git repository', findings: [] }));
    expect(failed.code).toBe(2);
    expect(failed.stdout).toContain('Error: not a git repository');
    expect((await cli(['run', '--level', 'poke'], runResult({ status: 'inconclusive', findings: [] }))).code).toBe(2);
  });

  it('reports an unexpected exception on stderr and exits 2', async () => {
    const run = await cli(['run', '--level', 'poke'], new Error('kaboom'));
    expect(run.code).toBe(2);
    expect(run.stderr).toContain('chimpd: Error: kaboom');
    expect(run.stdout).toBe('');
  });
});

describe('argument errors', () => {
  it('print the problem and the usage on stderr and exit 2 without running anything', async () => {
    const run = await cli(['run', '--level', 'gentle']);
    expect(run.code).toBe(2);
    expect(run.stderr.startsWith("chimpd: --level must be poke, prod or shake, not 'gentle'\n\nUsage: chimpd run")).toBe(true);
    expect(run.stdout).toBe('');
    expect(run.calls).toEqual([]);
  });
});

describe('help and version', () => {
  it('prints the usage and exits 0', async () => {
    const run = await cli(['--help']);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain('Usage: chimpd run --level poke|prod|shake');
    expect(run.stdout).toContain('--strict');
  });

  it('prints the version and exits 0', async () => {
    expect(await cli(['--version'])).toMatchObject({ code: 0, stdout: '9.9.9\n' });
  });

  it('reads the version from the package manifest', () => {
    expect(packageVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('writes only printable ASCII', async () => {
    const outputs = [await cli(['--help']), await cli(['run', '--level', 'x']), await cli(['run', '--level', 'poke'], partial)];
    for (const output of outputs) expect(output.stdout + output.stderr).toMatch(/^[\n\x20-\x7e]*$/);
  });
});
