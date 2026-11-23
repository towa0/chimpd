import path from 'node:path';
import { parseArgs } from 'node:util';
import { MAX_SEED } from '../core/index.js';
import { LEVELS, type Level } from '../orchestrator/index.js';

export interface CliOptions {
  readonly level: Level;
  readonly base: string | undefined;
  readonly json: boolean;
  readonly strict: boolean;
  readonly verbose: boolean;
  readonly seed: number | undefined;
  readonly cwd: string;
  /** Print what a run would do, without running mutants or faults. */
  readonly plan: boolean;
}

export interface BaselineCliOptions {
  readonly level: Level;
  readonly base: string | undefined;
  readonly verbose: boolean;
  readonly seed: number | undefined;
  readonly cwd: string;
  /** Remove the entries the run found stale. */
  readonly prune: boolean;
}

export type ParsedArgs =
  | { readonly kind: 'run'; readonly options: CliOptions }
  | { readonly kind: 'baseline'; readonly options: BaselineCliOptions }
  | { readonly kind: 'help' }
  | { readonly kind: 'version' }
  | { readonly kind: 'error'; readonly message: string };

export const USAGE = [
  'Usage: chimpd run --level poke|prod|shake [--plan] [--base <ref>] [--json] [--strict] [--verbose] [--seed <n>] [--cwd <dir>]',
  '       chimpd baseline --level poke|prod|shake [--prune] [--base <ref>] [--verbose] [--seed <n>] [--cwd <dir>]',
  '',
  'run checks the branch; baseline runs the same check and writes its findings to chimpd-baseline.json.',
  '',
  'Options:',
  '  --level <name>  poke (2 min), prod (5 min) or shake (10 min); required',
  '  --plan          run only: print what the run would do, without running mutants or faults',
  '  --prune         baseline only: remove entries that match nothing in scope any more',
  '  --base <ref>    the ref the branch is compared against; default origin/main',
  '  --json          run only: print the versioned JSON report instead of text',
  '  --strict        run only: exit 2 whenever anything in scope was not checked',
  "  --verbose       pass on what the project's own tests print, to stderr",
  '  --seed <n>      breaks ties when a cap or the budget forces a choice; picked and printed when omitted',
  '  --cwd <dir>     the project to check; default the current directory',
  '  -h, --help      print this help',
  '  --version       print the version',
  '',
  'Exit codes: 0 no findings, 1 findings, 2 tool error, phase error or inconclusive run.',
].join('\n');

const COMMANDS = 'the commands are run and baseline';

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
  if (command === undefined) return { kind: 'error', message: `missing command; ${COMMANDS}` };
  if (command !== 'run' && command !== 'baseline') return { kind: 'error', message: `unknown command '${command}'; ${COMMANDS}` };
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
  const cwd = path.resolve(defaultCwd, values.cwd ?? '.');

  if (command === 'baseline') {
    const runOnly = (['plan', 'json', 'strict'] as const).find((name) => values[name] === true);
    if (runOnly !== undefined) return { kind: 'error', message: `--${runOnly} only applies to chimpd run` };
    return {
      kind: 'baseline',
      options: { level, base: values.base, verbose: values.verbose === true, seed, cwd, prune: values.prune === true },
    };
  }
  if (values.prune === true) return { kind: 'error', message: '--prune only applies to chimpd baseline' };

  return {
    kind: 'run',
    options: {
      level,
      base: values.base,
      json: values.json === true,
      strict: values.strict === true,
      verbose: values.verbose === true,
      seed,
      cwd,
      plan: values.plan === true,
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
      plan: { type: 'boolean' },
      prune: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean' },
    },
  });
}
