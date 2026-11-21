import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseCliArgs } from '../../src/cli/args.js';

const CWD = path.resolve('/work/project');

function error(argv: string[]): string {
  const parsed = parseCliArgs(argv, CWD);
  if (parsed.kind !== 'error') throw new Error(`expected an error, got ${parsed.kind}`);
  return parsed.message;
}

describe('command line parsing', () => {
  it('reads every option of the run command', () => {
    expect(
      parseCliArgs(
        ['run', '--level', 'shake', '--base', 'main', '--json', '--strict', '--verbose', '--seed', '17', '--cwd', 'app'],
        CWD,
      ),
    ).toEqual({
      kind: 'run',
      options: { level: 'shake', base: 'main', json: true, strict: true, verbose: true, seed: 17, cwd: path.join(CWD, 'app') },
    });
  });

  it('defaults to text, non-strict, no base, no seed and the current directory', () => {
    expect(parseCliArgs(['run', '--level=poke'], CWD)).toEqual({
      kind: 'run',
      options: { level: 'poke', base: undefined, json: false, strict: false, verbose: false, seed: undefined, cwd: CWD },
    });
  });

  it('keeps an absolute --cwd as given', () => {
    const elsewhere = path.resolve('/elsewhere');
    expect(parseCliArgs(['run', '--level', 'prod', '--cwd', elsewhere], CWD)).toMatchObject({ options: { cwd: elsewhere } });
  });

  it('answers help and version before checking anything else', () => {
    expect(parseCliArgs(['--help'], CWD)).toEqual({ kind: 'help' });
    expect(parseCliArgs(['run', '-h'], CWD)).toEqual({ kind: 'help' });
    expect(parseCliArgs(['--version'], CWD)).toEqual({ kind: 'version' });
  });

  it('rejects a missing or unknown command', () => {
    expect(error([])).toBe('missing command; the only command is run');
    expect(error(['scan', '--level', 'poke'])).toBe("unknown command 'scan'; the only command is run");
    expect(error(['run', 'extra', '--level', 'poke'])).toBe("unexpected argument 'extra'");
  });

  it('rejects a missing or unknown level', () => {
    expect(error(['run'])).toBe('--level is required: poke, prod or shake');
    expect(error(['run', '--level', 'nudge'])).toBe("--level must be poke, prod or shake, not 'nudge'");
    expect(error(['run', '--level', 'constructor'])).toBe("--level must be poke, prod or shake, not 'constructor'");
  });

  it('rejects a seed that is not a non-negative 31-bit integer', () => {
    for (const seed of ['-1', '1.5', 'abc', '', '2147483648']) {
      expect(error(['run', '--level', 'poke', `--seed=${seed}`])).toContain('--seed must be an integer from 0 to 2147483647');
    }
    expect(parseCliArgs(['run', '--level', 'poke', '--seed', '2147483647'], CWD)).toMatchObject({ options: { seed: 2147483647 } });
  });

  it('rejects unknown options and options without their value', () => {
    expect(error(['run', '--level', 'poke', '--fast'])).toBe("Unknown option '--fast'");
    expect(error(['run', '--level'])).toContain("Option '--level <value>' argument missing");
    expect(error(['run', '--level', 'poke', '--base', ''])).toBe('--base needs a ref');
    expect(error(['run', '--level', 'poke', '--cwd', ' '])).toBe('--cwd needs a directory');
  });
});
