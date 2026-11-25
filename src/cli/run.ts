import fs from 'node:fs';
import { realNow } from '../core/index.js';
import { EXIT_CLEAN, EXIT_INCONCLUSIVE, exitCodeOf, runBruise, type RunOptions, type RunResult } from '../orchestrator/index.js';
import { exitCodeOfPlan, planRun, type PlanOptions, type RunPlan } from '../plan/index.js';
import { startProgress, type ProgressDisplay } from '../progress/terminal.js';
import { renderJson, renderPlanJson, renderPlanText, renderText } from '../reporter/index.js';
import { colorEnabled, type Env } from '../terminal/color.js';
import { renderHeader, showHeader } from '../terminal/header.js';
import { themeFor } from '../terminal/theme.js';
import { renderFancyText } from '../terminal/report.js';
import { parseCliArgs, USAGE } from './args.js';
import { runBaseline } from './baseline.js';

/** What the CLI knows about the terminal it writes to; without it, output is plain, as for a pipe. */
export interface CliTerminal {
  readonly stdoutIsTTY: boolean;
  readonly stderrIsTTY: boolean;
  readonly env: Env;
  stdoutColumns(): number;
  stderrColumns(): number;
  /** Returns a function that stops listening. */
  onResize(listener: () => void): () => void;
  /** Runs `restore` on process exit, Ctrl-C and termination; returns a function that stops that. */
  onExit(restore: () => void): () => void;
}

export interface CliIo {
  stdout(text: string): void;
  stderr(text: string): void;
  readonly terminal?: CliTerminal;
}

const PIPED: CliTerminal = {
  stdoutIsTTY: false,
  stderrIsTTY: false,
  env: {},
  stdoutColumns: () => 80,
  stderrColumns: () => 80,
  onResize: () => () => undefined,
  onExit: () => () => undefined,
};

function progressOn(io: CliIo, terminal: CliTerminal, color: boolean | undefined): ProgressDisplay {
  return startProgress(
    {
      write: (text) => io.stderr(text),
      columns: () => terminal.stderrColumns(),
      onResize: (listener) => terminal.onResize(listener),
      onExit: (restore) => terminal.onExit(restore),
      now: realNow,
      setInterval: (callback, ms) => setInterval(callback, ms).unref(),
      clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
    },
    themeFor(colorEnabled({ flag: color, env: terminal.env, isTTY: true })),
  );
}

export interface CliDeps {
  readonly cwd: string;
  readonly run: (options: RunOptions) => Promise<RunResult>;
  readonly plan: (options: PlanOptions) => Promise<RunPlan>;
  readonly version: () => string;
}

export function packageVersion(): string {
  const manifest = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version?: string };
  return manifest.version ?? 'unknown';
}

const DEFAULT_DEPS: CliDeps = { cwd: process.cwd(), run: runBruise, plan: planRun, version: packageVersion };

/** Runs one command line and returns its exit code; it never throws and never exits the process. */
export async function runCli(argv: readonly string[], io: CliIo, deps: Partial<CliDeps> = {}): Promise<number> {
  const { cwd, run, plan, version } = { ...DEFAULT_DEPS, ...deps };
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
    io.stderr(`bruise: ${parsed.message}\n\n${USAGE}\n`);
    return EXIT_INCONCLUSIVE;
  }

  if (parsed.kind === 'baseline') return runBaseline(parsed.options, io, run);

  const { options } = parsed;
  const terminal = io.terminal ?? PIPED;
  if (showHeader({ stderrIsTTY: terminal.stderrIsTTY, json: options.json, banner: options.banner, env: terminal.env })) {
    io.stderr(renderHeader(version(), themeFor(colorEnabled({ flag: options.color, env: terminal.env, isTTY: true }))));
  }
  if (options.plan) {
    let planned: RunPlan;
    try {
      planned = await plan({
        cwd: options.cwd,
        level: options.level,
        ...(options.base === undefined ? {} : { base: options.base }),
        ...(options.seed === undefined ? {} : { seed: options.seed }),
      });
    } catch (error) {
      io.stderr(`bruise: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
      return EXIT_INCONCLUSIVE;
    }
    io.stdout(options.json ? renderPlanJson(planned) : renderPlanText(planned));
    return exitCodeOfPlan(planned);
  }

  // Target output forwarded by --verbose would land in the middle of a redrawn line.
  const progress = terminal.stderrIsTTY && !options.verbose ? progressOn(io, terminal, options.color) : null;
  let result: RunResult;
  try {
    result = await run({
      cwd: options.cwd,
      level: options.level,
      ...(options.base === undefined ? {} : { base: options.base }),
      ...(options.seed === undefined ? {} : { seed: options.seed }),
      ...(options.verbose ? { onTargetOutput: (text: string) => io.stderr(text) } : {}),
      ...(progress === null ? {} : { onProgress: progress.listener }),
    });
  } catch (error) {
    progress?.stop();
    io.stderr(`bruise: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    return EXIT_INCONCLUSIVE;
  }
  progress?.stop();
  const exit = { strict: options.strict };
  const theme = themeFor(colorEnabled({ flag: options.color, env: terminal.env, isTTY: terminal.stdoutIsTTY }));
  const fancy = terminal.stdoutIsTTY || theme.enabled;
  io.stdout(
    options.json
      ? renderJson(result, exit)
      : fancy
        ? renderFancyText(result, exit, theme, terminal.stdoutColumns())
        : renderText(result, exit),
  );
  return exitCodeOf(result, exit);
}
