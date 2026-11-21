import path from 'node:path';
import { parseArgs } from 'node:util';
import { LEVELS, type Level } from '../orchestrator/index.js';

export interface CliOptions {
  readonly level: Level;
  readonly base: string | undefined;
  readonly json: boolean;
  readonly strict: boolean;
  readonly verbose: boolean;
  readonly seed: number | undefined;
  readonly cwd: string;
}

export type ParsedArgs =
  | { readonly kind: 'run'; readonly options: CliOptions }
  | { readonly kind: 'help' }
  | { readonly kind: 'version' }
  | { readonly kind: 'error'; readonly message: string };

export const USAGE = [
  'Usage: chimpd run --level poke|prod|shake [--base <ref>] [--json] [--strict] [--verbose] [--seed <n>] [--cwd <dir>]',
  '',
  'Options:',
  '  --level <name>  poke (2 min), prod (5 min) or shake (10 min); required',
  '  --base <ref>    the ref the branch is compared against; default origin/main',
  '  --json          print the versioned JSON report instead of text',
  '  --strict        exit 2 whenever anything in scope was not checked',
  "  --verbose       pass on what the project's own tests print, to stderr",
  '  --seed <n>      a non-negative integer recorded with the run',
  '  --cwd <dir>     the project to check; default the current directory',
  '  -h, --help      print this help',
  '  --version       print the version',
  '',
  'Exit codes: 0 no findings, 1 findings, 2 tool error, phase error or inconclusive run.',
].join('\n');

const MAX_SEED = 2 ** 31 - 1;

function isLevel(value: string): value is Level {
  return Object.hasOwn(LEVELS, value);
}

function messageOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // parseArgs messages end with advice about '--' that does not apply to this command line.
  return message.replace(/\. To specify a positional argument.*$/s, '');
}

export function parseCliArgs(argv: readonly string[], defaultCwd: string): ParsedArgs {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (error) {
    return { kind: 'error', message: messageOf(error) };
  }
  const { values, positionals } = parsed;
  if (values.help === true) return { kind: 'help' };
  if (values.version === true) return { kind: 'version' };

  const [command, ...extra] = positionals;
  if (command === undefined) return { kind: 'error', message: 'missing command; the only command is run' };
  if (command !== 'run') return { kind: 'error', message: `unknown command '${command}'; the only command is run` };
  if (extra.length > 0) return { kind: 'error', message: `unexpected argument '${extra[0] ?? ''}'` };

  const level = values.level;
  if (level === undefined) return { kind: 'error', message: '--level is required: poke, prod or shake' };
  if (!isLevel(level)) return { kind: 'error', message: `--level must be poke, prod or shake, not '${level}'` };

  let seed: number | undefined;
  if (values.seed !== undefined) {
    if (!/^\d+$/.test(values.seed) || Number(values.seed) > MAX_SEED) {
      return { kind: 'error', message: `--seed must be an integer from 0 to ${MAX_SEED}, not '${values.seed}'` };
    }
    seed = Number(values.seed);
  }

  if (values.base?.trim() === '') return { kind: 'error', message: '--base needs a ref' };
  if (values.cwd?.trim() === '') return { kind: 'error', message: '--cwd needs a directory' };

  return {
    kind: 'run',
    options: {
      level,
      base: values.base,
      json: values.json === true,
      strict: values.strict === true,
      verbose: values.verbose === true,
      seed,
      cwd: path.resolve(defaultCwd, values.cwd ?? '.'),
    },
  };
}

function parse(argv: readonly string[]) {
  return parseArgs({
    args: [...argv],
    allowPositionals: true,
    strict: true,
    options: {
      level: { type: 'string' },
      base: { type: 'string' },
      json: { type: 'boolean' },
      strict: { type: 'boolean' },
      verbose: { type: 'boolean' },
      seed: { type: 'string' },
      cwd: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean' },
    },
  });
}
