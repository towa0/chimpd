import { describe, expect, it } from 'vitest';
import { runCli, type CliDeps, type CliTerminal } from '../../src/cli/run.js';
import type { RunOptions, RunResult } from '../../src/orchestrator/index.js';
import { renderJson, renderPlanText, renderText } from '../../src/reporter/index.js';
import { stripAnsi } from '../../src/terminal/color.js';
import { RECORDED } from '../helpers/progress-events.js';
import { runPlan, runResult } from '../helpers/run-fixtures.js';

const HIDE = '\u001b[?25l';
const SHOW = '\u001b[?25h';
const ESC = '\u001b[';

interface Captured {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly calls: RunOptions[];
}

function tty(overrides: Partial<CliTerminal> = {}): CliTerminal {
  return {
    stdoutIsTTY: true,
    stderrIsTTY: true,
    env: {},
    stdoutColumns: () => 100,
    stderrColumns: () => 100,
    onResize: () => () => undefined,
    onExit: () => () => undefined,
    ...overrides,
  };
}

async function cli(argv: string[], terminal: CliTerminal | undefined, result: RunResult | Error = runResult()): Promise<Captured> {
  let stdout = '';
  let stderr = '';
  const calls: RunOptions[] = [];
  const deps: Partial<CliDeps> = {
    cwd: '/work',
    version: () => '9.9.9',
    run: (options) => {
      calls.push(options);
      for (const event of RECORDED) options.onProgress?.(event);
      return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
    },
    plan: () => Promise.resolve(runPlan()),
  };
  const io = { stdout: (text: string) => (stdout += text), stderr: (text: string) => (stderr += text) };
  const code = await runCli(argv, terminal === undefined ? io : { ...io, terminal }, deps);
  return { code, stdout, stderr, calls };
}

const RUN = ['run', '--level', 'poke'];
const piped = tty({ stdoutIsTTY: false, stderrIsTTY: false });
const results: RunResult[] = [
  runResult(),
  runResult({ status: 'partial', findings: [], skipped: [{ source: 'mutation', file: 'src/a.ts', line: 2, reason: 'not tested: budget' }] }),
  runResult({ status: 'error', error: 'base ref missing', phases: [], findings: [] }),
];

describe('output without a terminal', () => {
  it('writes the same stdout bytes with and without the terminal layer when stdout is not a TTY', async () => {
    for (const result of results) {
      for (const argv of [RUN, [...RUN, '--json'], [...RUN, '--strict'], [...RUN, '--no-color'], [...RUN, '--no-banner']]) {
        const bare = await cli(argv, undefined, result);
        for (const terminal of [piped, tty({ stdoutIsTTY: false }), tty({ stdoutIsTTY: false, env: { NO_COLOR: '1', CI: 'true' } })]) {
          const layered = await cli(argv, terminal, result);
          expect(layered.stdout).toBe(bare.stdout);
          expect(layered.code).toBe(bare.code);
        }
      }
    }
  });

  it('keeps that stdout exactly the plain or JSON report', async () => {
    const [result] = results;
    if (result === undefined) throw new Error('no result');
    expect((await cli(RUN, tty({ stdoutIsTTY: false }), result)).stdout).toBe(renderText(result, { strict: false }));
    expect((await cli([...RUN, '--json'], tty({ stdoutIsTTY: false }), result)).stdout).toBe(renderJson(result, { strict: false }));
    expect((await cli([...RUN, '--plan'], tty(), result)).stdout).toBe(renderPlanText(runPlan()));
  });

  it('writes nothing extra to a stderr that is not a TTY, and gives the run no progress listener', async () => {
    const run = await cli(RUN, piped);
    expect(run.stderr).toBe('');
    expect(run.calls[0]?.onProgress).toBeUndefined();
  });
});

describe('output on a terminal', () => {
  it('shows the header line and live progress on stderr, and leaves the cursor visible at the end', async () => {
    const run = await cli(RUN, tty());
    expect(run.stderr.startsWith(`${ESC}1m${ESC}35mbruise 9.9.9${ESC}39m${ESC}22m  ${ESC}2mfind the soft spots in your tests${ESC}22m\n\n`)).toBe(true);
    expect(run.stderr).toContain(HIDE);
    expect(stripAnsi(run.stderr)).toContain('== Mutation phase, budget 84.0 s ==');
    expect(stripAnsi(run.stderr)).toContain('5/10 mutants');
    expect(run.stderr.endsWith(SHOW)).toBe(true);
    expect(run.stderr.indexOf(HIDE)).toBeLessThan(run.stderr.lastIndexOf(SHOW));
  });

  it('shows the cursor again before reporting a run that failed', async () => {
    const run = await cli(RUN, tty(), new Error('exploded'));
    expect(run.code).toBe(2);
    expect(run.stderr.lastIndexOf(SHOW)).toBeLessThan(run.stderr.indexOf('bruise: Error: exploded'));
  });

  it('leaves the header out with --json, --no-banner and in CI, but keeps the progress', async () => {
    for (const [argv, env] of [
      [[...RUN, '--json'], {}],
      [[...RUN, '--no-banner'], {}],
      [RUN, { CI: 'true' }],
    ] as const) {
      const run = await cli([...argv], tty({ env }));
      expect(stripAnsi(run.stderr)).not.toContain('bruise 9.9.9');
      expect(stripAnsi(run.stderr)).toContain('== Mutation phase');
    }
  });

  it('shows the same header line without colour under NO_COLOR or --no-color', async () => {
    for (const run of [await cli([...RUN, '--no-color'], tty()), await cli(RUN, tty({ env: { NO_COLOR: '1' } }))]) {
      expect(run.stderr.startsWith('bruise 9.9.9  find the soft spots in your tests\n\n')).toBe(true);
      expect(run.stderr).not.toMatch(/\u001b\[[0-9;]*m/);
    }
  });

  it('gives no progress with --verbose, whose target output would break the redrawn line', async () => {
    const run = await cli([...RUN, '--verbose'], tty({ env: { CI: '1' } }));
    expect(run.calls[0]?.onProgress).toBeUndefined();
    expect(run.stderr).toBe('');
  });

  it('prints the terminal report with colour and a summary on a stdout TTY', async () => {
    const run = await cli(RUN, tty());
    expect(run.stdout).toContain(`${ESC}1m${ESC}35mScope: `);
    expect(stripAnsi(run.stdout)).toContain('| Summary');
    expect(stripAnsi(run.stdout)).toContain('src/clients/ledger.ts:12:20 [high 70] in postLedgerEntry');
    expect(stripAnsi(run.stdout).trimEnd().endsWith('Result: 2 findings (exit 1)')).toBe(true);
  });

  it('prints the terminal report without colour on a stdout TTY under NO_COLOR or --no-color', async () => {
    for (const run of [await cli(RUN, tty({ env: { NO_COLOR: '1' } })), await cli([...RUN, '--no-color'], tty())]) {
      expect(run.stdout).not.toContain(ESC);
      expect(run.stdout).toContain('| Summary');
    }
  });

  it('colours a piped stdout only when --color or FORCE_COLOR asks for it', async () => {
    for (const run of [await cli([...RUN, '--color'], piped), await cli(RUN, tty({ stdoutIsTTY: false, stderrIsTTY: false, env: { FORCE_COLOR: '1' } }))]) {
      expect(run.stdout).toContain(ESC);
      expect(stripAnsi(run.stdout)).toContain('| Summary');
    }
  });

  it('keeps --json plain on a TTY', async () => {
    const run = await cli([...RUN, '--json'], tty());
    expect(run.stdout).toBe(renderJson(runResult(), { strict: false }));
  });
});
