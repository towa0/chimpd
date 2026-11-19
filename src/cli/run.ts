import fs from 'node:fs';
import { EXIT_CLEAN, EXIT_INCONCLUSIVE, exitCodeOf, runChimpd, type RunOptions, type RunResult } from '../orchestrator/index.js';
import { renderJson, renderText } from '../reporter/index.js';
import { parseCliArgs, USAGE } from './args.js';

export interface CliIo {
  stdout(text: string): void;
  stderr(text: string): void;
}

export interface CliDeps {
  readonly cwd: string;
  readonly run: (options: RunOptions) => Promise<RunResult>;
  readonly version: () => string;
}

export function packageVersion(): string {
  const manifest = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version?: string };
  return manifest.version ?? 'unknown';
}

const DEFAULT_DEPS: CliDeps = { cwd: process.cwd(), run: runChimpd, version: packageVersion };

/** Runs one command line and returns its exit code; it never throws and never exits the process. */
export async function runCli(argv: readonly string[], io: CliIo, deps: Partial<CliDeps> = {}): Promise<number> {
  const { cwd, run, version } = { ...DEFAULT_DEPS, ...deps };
  const parsed = parseCliArgs(argv, cwd);
  if (parsed.kind === 'help') {
    io.stdout(`${USAGE}\n`);
    return EXIT_CLEAN;
  }
  if (parsed.kind === 'version') {
    io.stdout(`${version()}\n`);
    return EXIT_CLEAN;
  }
  if (parsed.kind === 'error') {
    io.stderr(`chimpd: ${parsed.message}\n\n${USAGE}\n`);
    return EXIT_INCONCLUSIVE;
  }

  const { options } = parsed;
  let result: RunResult;
  try {
    result = await run({
      cwd: options.cwd,
      level: options.level,
      ...(options.base === undefined ? {} : { base: options.base }),
      ...(options.seed === undefined ? {} : { seed: options.seed }),
    });
  } catch (error) {
    io.stderr(`chimpd: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    return EXIT_INCONCLUSIVE;
  }
  const exit = { strict: options.strict };
  io.stdout(options.json ? renderJson(result, exit) : renderText(result, exit));
  return exitCodeOf(result, exit);
}
