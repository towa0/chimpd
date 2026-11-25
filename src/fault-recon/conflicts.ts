import { createHash } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { environmentDigests, type EnvironmentDigests } from './environment.js';

const DISPATCHER = Symbol.for('undici.globalDispatcher.1');

type EntryPoints = Readonly<Record<string, unknown>>;

function entryPoints(): EntryPoints {
  return {
    fetch: globalThis.fetch,
    Request: globalThis.Request,
    'http.request': http.request,
    'http.get': http.get,
    'https.request': https.request,
    'https.get': https.get,
    'http.ClientRequest': http.ClientRequest,
  };
}

function dispatcher(): unknown {
  return (globalThis as Record<symbol, unknown>)[DISPATCHER];
}

function digest(value: unknown): string {
  return createHash('sha256').update(String(value)).digest('hex');
}

function dispatcherDigest(): string | null {
  const current = dispatcher();
  return typeof current === 'object' && current !== null ? digest(current.constructor) : null;
}

export interface Fingerprints {
  readonly entryPoints: Readonly<Record<string, string>>;
  /** null when the runtime has not created its default dispatcher. */
  readonly dispatcher: string | null;
  /** What the target's test environment puts in place of an entry point, by name; empty without one. */
  readonly environment: EnvironmentDigests;
}

function currentDigests(): Record<string, string> {
  return Object.fromEntries(Object.entries(entryPoints()).map(([name, value]) => [name, digest(value)]));
}

/**
 * Fingerprints of this process, which must not have patched its HTTP entry points. With a target,
 * they also hold what that target's jsdom environment installs, so that it is not taken for a patch.
 */
export async function pristineFingerprints(targetRoot?: string): Promise<Fingerprints> {
  // Node creates its default dispatcher on the first fetch; an unknown scheme rejects before any I/O.
  await fetch('bruise-probe:').catch(() => undefined);
  const environment = targetRoot === undefined ? {} : await environmentDigests(targetRoot, digest);
  return { entryPoints: currentDigests(), dispatcher: dispatcherDigest(), environment };
}

// The environment's own class is accepted only while it still extends the runtime's own one.
function providedByEnvironment(pristine: Fingerprints, name: string, value: unknown): boolean {
  const expected = pristine.environment[name];
  if (expected === undefined || digest(value) !== expected || typeof value !== 'function') return false;
  return digest(Object.getPrototypeOf(value)) === pristine.entryPoints[name];
}

function dispatcherPatched(pristine: Fingerprints): boolean {
  const current = dispatcherDigest();
  return current !== null && current !== pristine.dispatcher;
}

/** Names of the HTTP entry points that differ from the pristine runtime. */
export function patchedSince(pristine: Fingerprints): string[] {
  const values = entryPoints();
  const patched = Object.keys(pristine.entryPoints).filter((name) => {
    if (digest(values[name]) === pristine.entryPoints[name]) return false;
    return !providedByEnvironment(pristine, name, values[name]);
  });
  if (dispatcherPatched(pristine)) patched.push('undici dispatcher');
  return patched;
}

/** Names the environments whose own HTTP entry points bruise cannot fault, instead of calling them a patch. */
export function patchedBeforeTestsReason(patched: readonly string[], environment: string | null | undefined): string {
  if (environment === 'happy-dom') {
    return `the happy-dom test environment replaces ${patched.join(', ')} with its own, which bruise cannot fault yet`;
  }
  return `HTTP entry points were already patched before the tests loaded: ${patched.join(', ')}`;
}

interface WorkerState {
  readonly environment?: { readonly name?: unknown };
}

/** The name of the Vitest environment this worker runs, from Vitest's own worker state; null when unknown. */
export function testEnvironmentName(global: object = globalThis): string | null {
  const state = (global as { __vitest_worker__?: WorkerState }).__vitest_worker__;
  const name = state?.environment?.name;
  return typeof name === 'string' ? name : null;
}

export interface PatchGuard {
  /** Names of the entry points replaced since the guard was created. */
  changed(): string[];
}

export function createPatchGuard(pristine: Fingerprints): PatchGuard {
  const installed = entryPoints();
  const installedDispatcher = dispatcher();
  return {
    changed() {
      const current = entryPoints();
      const changed = Object.keys(installed).filter((name) => current[name] !== installed[name]);
      if (dispatcher() !== installedDispatcher && dispatcherPatched(pristine)) changed.push('undici dispatcher');
      return changed;
    },
  };
}
