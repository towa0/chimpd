import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  createPatchGuard,
  patchedBeforeTestsReason,
  patchedSince,
  pristineFingerprints,
  testEnvironmentName,
  type Fingerprints,
} from '../../src/fault-recon/conflicts.js';
import { installCallCapture } from '../../src/fault-injector/call-capture.js';
import { repoRoot } from '../helpers/temp-repo.js';

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
    http.get = () => new http.ClientRequest('http://bruise.invalid');
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

describe('the test environment', () => {
  const originalRequest = globalThis.Request;

  afterEach(() => {
    globalThis.Request = originalRequest;
  });

  async function jsdomRequest(): Promise<typeof Request> {
    const { builtinEnvironments } = await import('vitest/runtime');
    const scratch: { Request?: typeof Request } = {};
    const environment = await builtinEnvironments.jsdom.setup(scratch, {});
    const installed = scratch.Request;
    await environment.teardown(scratch);
    if (installed === undefined) throw new Error('jsdom installed no Request');
    return installed;
  }

  it('records the Request that the target jsdom environment installs, and nothing for fetch', async () => {
    const withJsdom = await pristineFingerprints(repoRoot);
    expect(Object.keys(withJsdom.environment)).toEqual(['Request']);
    expect(withJsdom.environment['Request']).not.toBe(withJsdom.entryPoints['Request']);
  });

  it('records nothing for a target without jsdom', async () => {
    const dir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'bruise-nodom-'));
    try {
      fs.writeFileSync(path.join(dir, 'package.json'), '{}');
      expect((await pristineFingerprints(dir)).environment).toEqual({});
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    expect(pristine.environment).toEqual({});
  });

  it('accepts the jsdom Request only with fingerprints that know the environment', async () => {
    const withJsdom = await pristineFingerprints(repoRoot);
    globalThis.Request = await jsdomRequest();
    expect(patchedSince(withJsdom)).toEqual([]);
    expect(patchedSince(pristine)).toEqual(['Request']);
  });

  it('still flags the jsdom Request when the Request it extends was replaced first', async () => {
    const withJsdom = await pristineFingerprints(repoRoot);
    globalThis.Request = class Request extends originalRequest {};
    globalThis.Request = await jsdomRequest();
    expect(Object.getPrototypeOf(globalThis.Request)).not.toBe(originalRequest);
    expect(patchedSince(withJsdom)).toEqual(['Request']);
  });

  it('still flags any other Request class', async () => {
    const withJsdom = await pristineFingerprints(repoRoot);
    globalThis.Request = class Request extends originalRequest {};
    expect(patchedSince(withJsdom)).toEqual(['Request']);
  });

  it('names happy-dom instead of calling its globals a patch', () => {
    expect(patchedBeforeTestsReason(['fetch', 'Request'], 'happy-dom')).toBe(
      'the happy-dom test environment replaces fetch, Request with its own, which bruise cannot fault yet',
    );
    expect(patchedBeforeTestsReason(['fetch'], 'jsdom')).toBe('HTTP entry points were already patched before the tests loaded: fetch');
    expect(patchedBeforeTestsReason(['fetch'], null)).toBe('HTTP entry points were already patched before the tests loaded: fetch');
  });

  it('reads the environment name from the Vitest worker state', () => {
    expect(testEnvironmentName({ __vitest_worker__: { environment: { name: 'happy-dom' } } })).toBe('happy-dom');
    expect(testEnvironmentName({})).toBeNull();
    expect(testEnvironmentName()).toBe('node');
  });
});
