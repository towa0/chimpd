import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  prependSetupFile,
  runVitest,
  type VitestInlineOptions,
  type VitestNodeModule,
} from '../../src/fault-recon/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = resolve(here, '../fixtures/setup-order');

async function loadVitest(packageDir: string, version: string): Promise<VitestNodeModule> {
  const manifestPath = join(packageDir, 'package.json');
  if (!existsSync(manifestPath)) {
    throw new Error(`vitest ${version} is not installed at ${packageDir}`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { version: string };
  expect(manifest.version).toBe(version);
  return (await import(pathToFileURL(join(packageDir, 'dist/node.js')).href)) as VitestNodeModule;
}

interface InnerRun {
  readonly passed: number;
  readonly failed: number;
  readonly unhandled: number;
}

interface InnerTask {
  readonly type: string;
  readonly result?: { readonly state: string } | undefined;
  readonly tasks?: readonly InnerTask[];
}

function countTests(tasks: readonly InnerTask[], state: string): number {
  return tasks.reduce((total, task) => {
    if (task.type === 'test') return total + (task.result?.state === state ? 1 : 0);
    return total + countTests(task.tasks ?? [], state);
  }, 0);
}

async function runFixture(
  vitestNode: VitestNodeModule,
  withChimpdSetup: boolean,
  extra: VitestInlineOptions = {},
): Promise<InnerRun> {
  const vitest = await runVitest(vitestNode, {
    root: fixtureRoot,
    configFile: join(fixtureRoot, 'vitest.config.ts'),
    options: { reporters: [{}], ...extra },
    plugins: withChimpdSetup ? [prependSetupFile()] : [],
  });
  try {
    const files: readonly InnerTask[] = vitest.state.getFiles();
    return {
      passed: countTests(files, 'pass'),
      failed: countTests(files, 'fail'),
      unhandled: vitest.state.getUnhandledErrors().length,
    };
  } finally {
    await vitest.close();
  }
}

export function defineSetupOrderSuite(version: string, packageDir: string): void {
  describe(`setup order: vitest ${version}`, () => {
    afterEach(() => {
      // The inner run sets a failing exit code for the control case; it must not leak into this run.
      process.exitCode = 0;
    });

    it('runs the prepended chimpd setup file before the fixture setup file', async () => {
      const vitestNode = await loadVitest(packageDir, version);
      expect(await runFixture(vitestNode, true)).toEqual({ passed: 1, failed: 0, unhandled: 0 });
    });

    it('keeps that order when the target asks for parallel setup files', async () => {
      const vitestNode = await loadVitest(packageDir, version);
      const run = await runFixture(vitestNode, true, { sequence: { setupFiles: 'parallel' } });
      expect(run).toEqual({ passed: 1, failed: 0, unhandled: 0 });
    });

    it('fails the fixture when the chimpd setup file is not prepended', async () => {
      const vitestNode = await loadVitest(packageDir, version);
      expect(await runFixture(vitestNode, false)).toEqual({ passed: 0, failed: 1, unhandled: 0 });
    });
  });
}
