import http from 'node:http';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  createPatchGuard,
  patchedSince,
  pristineFingerprints,
  type Fingerprints,
} from '../../src/fault-recon/conflicts.js';
import { installCallCapture } from '../../src/fault-injector/call-capture.js';

const DISPATCHER = Symbol.for('undici.globalDispatcher.1');
const globals = globalThis as Record<symbol, unknown>;

const original = { fetch: globalThis.fetch, httpGet: http.get };
let pristine: Fingerprints;
let originalDispatcher: unknown;

beforeAll(async () => {
  pristine = await pristineFingerprints();
  originalDispatcher = globals[DISPATCHER];
});

afterEach(() => {
  globalThis.fetch = original.fetch;
  http.get = original.httpGet;
  globals[DISPATCHER] = originalDispatcher;
});

class ReplacementDispatcher {}

describe('patchedSince', () => {
  it('reports nothing for an untouched runtime', () => {
    expect(patchedSince(pristine)).toEqual([]);
  });

  it('names a replaced fetch', () => {
    globalThis.fetch = () => Promise.resolve(new Response(null));
    expect(patchedSince(pristine)).toEqual(['fetch']);
  });

  it('names a replaced http entry point', () => {
    http.get = () => new http.ClientRequest('http://chimpd.invalid');
    expect(patchedSince(pristine)).toEqual(['http.get']);
  });

  it('names a replaced undici dispatcher', () => {
    globals[DISPATCHER] = new ReplacementDispatcher();
    expect(patchedSince(pristine)).toEqual(['undici dispatcher']);
  });

  it('sees the call capture wrappers as patches, so they must be restored between files', () => {
    const capture = installCallCapture();
    try {
      expect(patchedSince(pristine)).toContain('fetch');
    } finally {
      capture.restore();
    }
    expect(patchedSince(pristine)).toEqual([]);
  });
});

describe('createPatchGuard', () => {
  it('reports nothing while the installed entry points stay in place', () => {
    const capture = installCallCapture();
    try {
      expect(createPatchGuard(pristine).changed()).toEqual([]);
    } finally {
      capture.restore();
    }
  });

  it('names entry points replaced after it was created', () => {
    const guard = createPatchGuard(pristine);
    globalThis.fetch = () => Promise.resolve(new Response(null));
    globals[DISPATCHER] = new ReplacementDispatcher();
    expect(guard.changed()).toEqual(['fetch', 'undici dispatcher']);
  });

  it('accepts the runtime creating its default dispatcher late', () => {
    globals[DISPATCHER] = undefined;
    const guard = createPatchGuard(pristine);
    globals[DISPATCHER] = originalDispatcher;
    expect(guard.changed()).toEqual([]);
  });
});
