import { fileURLToPath } from 'node:url';
import type { Vite, Vitest } from 'vitest/node';
// The configureVitest hook is declared on Vite's Plugin type only by this module's augmentation.
import type {} from 'vitest/config';

export type VitestNodeModule = typeof import('vitest/node');
export type VitestInlineOptions = NonNullable<Parameters<VitestNodeModule['createVitest']>[1]>;

export interface VitestRunRequest {
  readonly root: string;
  readonly configFile: string;
  readonly filters?: readonly string[];
  readonly options?: VitestInlineOptions;
  readonly plugins?: readonly Vite.Plugin[];
}

export function setupFilePath(): string {
  const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
  return fileURLToPath(new URL(`./setup.${extension}`, import.meta.url));
}

export function prependSetupFile(setupFile: string = setupFilePath()): Vite.Plugin {
  return {
    name: 'chimpd:prepend-setup',
    configureVitest({ project }) {
      project.config.setupFiles.unshift(setupFile);
      // Parallel setup files have no defined order, and ours must run first.
      project.config.sequence.setupFiles = 'list';
    },
  };
}

export function runVitest(vitestNode: VitestNodeModule, request: VitestRunRequest): Promise<Vitest> {
  return vitestNode.startVitest(
    'test',
    [...(request.filters ?? [])],
    { ...request.options, root: request.root, config: request.configFile, watch: false },
    { plugins: [...(request.plugins ?? [])] },
  );
}

/** A Vite logger that sends what Vite itself prints, such as a config that fails to load, to the target output sink. */
export function targetViteLogger(onOutput: ((text: string) => void) | undefined): Vite.Logger {
  const warned = new Set<string>();
  const write = (message: string): void => onOutput?.(`${message}\n`);
  return {
    hasWarned: false,
    info: write,
    warn: write,
    warnOnce(message) {
      if (warned.has(message)) return;
      warned.add(message);
      write(message);
    },
    error: write,
    clearScreen: () => undefined,
    hasErrorLogged: () => false,
  };
}
