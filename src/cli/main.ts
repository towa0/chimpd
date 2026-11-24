#!/usr/bin/env node
import { runCli, type CliTerminal } from './run.js';

const SIGNAL_EXIT_CODES = { SIGINT: 130, SIGTERM: 143 } as const;

const terminal: CliTerminal = {
  stdoutIsTTY: process.stdout.isTTY === true,
  stderrIsTTY: process.stderr.isTTY === true,
  env: process.env,
  stdoutColumns: () => process.stdout.columns,
  stderrColumns: () => process.stderr.columns,
  onResize(listener) {
    process.stderr.on('resize', listener);
    return () => process.stderr.off('resize', listener);
  },
  onExit(restore) {
    // An uncaught error still ends in 'exit'; a signal does not, so it restores first and then exits with the signal's code.
    const signals = Object.entries(SIGNAL_EXIT_CODES).map(([signal, code]) => {
      const handler = (): void => {
        restore();
        process.exit(code);
      };
      process.once(signal, handler);
      return () => process.off(signal, handler);
    });
    process.once('exit', restore);
    return () => {
      for (const off of signals) off();
      process.off('exit', restore);
    };
  },
};

process.exitCode = await runCli(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  terminal,
});
