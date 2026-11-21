import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Digests of the entry points a builtin Vitest environment installs in place of the runtime's own. */
export type EnvironmentDigests = Readonly<Record<string, string>>;

interface Environment {
  setup(global: Record<string, unknown>, options: Record<string, unknown>): Promise<{ teardown(global: unknown): unknown }>;
}

interface RuntimeModule {
  readonly builtinEnvironments?: Readonly<Record<string, Environment | undefined>>;
}

interface Manifest {
  readonly exports?: Readonly<Record<string, unknown>>;
}

const REPLACEABLE = ['fetch', 'Request'] as const;

function entryOf(manifest: Manifest, subpath: string): string | null {
  const entry = manifest.exports?.[subpath];
  if (typeof entry === 'string') return entry;
  const { import: viaImport, default: viaDefault } = (entry ?? {}) as { import?: unknown; default?: unknown };
  const chosen = viaImport ?? viaDefault;
  return typeof chosen === 'string' ? chosen : null;
}

async function targetJsdom(targetRoot: string): Promise<Environment | null> {
  let manifestFile: string;
  try {
    manifestFile = createRequire(path.join(targetRoot, 'package.json')).resolve('vitest/package.json');
    // The environment imports jsdom from Vitest's own location, so that is where it has to resolve.
    createRequire(manifestFile).resolve('jsdom');
  } catch {
    return null;
  }
  const entry = entryOf(JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as Manifest, './runtime');
  if (entry === null) return null;
  const runtime = (await import(pathToFileURL(path.join(path.dirname(manifestFile), entry)).href)) as RuntimeModule;
  return runtime.builtinEnvironments?.['jsdom'] ?? null;
}

/**
 * Runs the target's own jsdom environment against a scratch global and records what it puts in
 * place of fetch and Request, when that is a subclass of the runtime's own. Only these exact
 * values, still extending the runtime's own, are later accepted as the environment's.
 */
export async function environmentDigests(targetRoot: string, digest: (value: unknown) => string): Promise<EnvironmentDigests> {
  const jsdom = await targetJsdom(targetRoot);
  if (jsdom === null) return {};
  const scratch: Record<string, unknown> = {};
  const environment = await jsdom.setup(scratch, {});
  try {
    const provided: Record<string, string> = {};
    for (const name of REPLACEABLE) {
      const value = scratch[name];
      if (value === undefined || value === globalThis[name]) continue;
      if (typeof value === 'function' && Object.getPrototypeOf(value) === globalThis[name]) provided[name] = digest(value);
    }
    return provided;
  } finally {
    await environment.teardown(scratch);
  }
}
