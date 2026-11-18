import { createHash } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';

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
}

function currentFingerprints(): Fingerprints {
  const digests = Object.entries(entryPoints()).map(([name, value]) => [name, digest(value)] as const);
  return { entryPoints: Object.fromEntries(digests), dispatcher: dispatcherDigest() };
}

/** Fingerprints of this process, which must not have patched its HTTP entry points. */
export async function pristineFingerprints(): Promise<Fingerprints> {
  // Node creates its default dispatcher on the first fetch; an unknown scheme rejects before any I/O.
  await fetch('chimpd-probe:').catch(() => undefined);
  return currentFingerprints();
}

function dispatcherPatched(pristine: Fingerprints): boolean {
  const current = dispatcherDigest();
  return current !== null && current !== pristine.dispatcher;
}

/** Names of the HTTP entry points that differ from the pristine runtime. */
export function patchedSince(pristine: Fingerprints): string[] {
  const current = currentFingerprints();
  const patched = Object.keys(pristine.entryPoints).filter(
    (name) => current.entryPoints[name] !== pristine.entryPoints[name],
  );
  if (dispatcherPatched(pristine)) patched.push('undici dispatcher');
  return patched;
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
