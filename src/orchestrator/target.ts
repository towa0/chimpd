import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { VitestNodeModule } from '../fault-recon/index.js';

export class ChimpdError extends Error {
  override readonly name = 'ChimpdError';
}

const CONFIG_NAMES: readonly string[] = ['vitest.config', 'vite.config'].flatMap((stem) =>
  ['ts', 'mts', 'cts', 'js', 'mjs', 'cjs'].map((extension) => `${stem}.${extension}`),
);

export function findVitestConfig(targetRoot: string): string | null {
  const name = CONFIG_NAMES.find((candidate) => fs.existsSync(path.join(targetRoot, candidate)));
  return name === undefined ? null : path.join(targetRoot, name);
}

export function missingConfigMessage(targetRoot: string): string {
  return `no Vitest config found in ${targetRoot}; looked for ${CONFIG_NAMES.join(', ')}`;
}

export const SUPPORTED_VITEST = '>=4.1 <6';

export function isSupportedVitest(version: string): boolean {
  const match = /^(\d+)\.(\d+)\./.exec(version);
  if (match === null) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return (major === 4 && minor >= 1) || major === 5;
}

export interface TargetVitest {
  readonly version: string;
  readonly node: VitestNodeModule;
}

interface VitestManifest {
  readonly version?: unknown;
  readonly exports?: Readonly<Record<string, unknown>>;
}

function nodeEntry(manifest: VitestManifest): string | null {
  const entry = manifest.exports?.['./node'];
  if (typeof entry === 'string') return entry;
  if (typeof entry === 'object' && entry !== null) {
    const { import: viaImport, default: viaDefault } = entry as { import?: unknown; default?: unknown };
    const chosen = viaImport ?? viaDefault;
    return typeof chosen === 'string' ? chosen : null;
  }
  return null;
}

/** The target's own Vitest, so that faulted runs execute under the runner its tests are written for. */
export async function loadTargetVitest(targetRoot: string): Promise<TargetVitest> {
  const require = createRequire(path.join(targetRoot, 'package.json'));
  let manifestFile: string;
  try {
    manifestFile = require.resolve('vitest/package.json');
  } catch {
    throw new ChimpdError(`Vitest is not installed in ${targetRoot}`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as VitestManifest;
  const version = typeof manifest.version === 'string' ? manifest.version : 'unknown';
  if (!isSupportedVitest(version)) {
    throw new ChimpdError(`Vitest ${version} in ${targetRoot} is not supported; chimpd needs Vitest ${SUPPORTED_VITEST}`);
  }
  const entry = nodeEntry(manifest);
  if (entry === null) throw new ChimpdError(`Vitest ${version} in ${targetRoot} has no vitest/node entry point`);
  const node = (await import(pathToFileURL(path.join(path.dirname(manifestFile), entry)).href)) as VitestNodeModule;
  return { version, node };
}
