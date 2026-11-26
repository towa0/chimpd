import type { TempRepo } from './temp-repo.js';

const PAIR_SOURCE = [
  "import fs from 'node:fs';",
  '',
  'export async function first(baseUrl: string, timeoutMs = 100): Promise<string> {',
  '  try {',
  '    const response = await fetch(`${baseUrl}/first`, { signal: AbortSignal.timeout(timeoutMs) });',
  '    return String(response.status);',
  '  } catch {',
  "    return 'unavailable';",
  '  }',
  '}',
  '',
  'export async function second(baseUrl: string): Promise<number> {',
  '  const response = await fetch(`${baseUrl}/second`);',
  '  return response.status;',
  '}',
  '',
  'export async function once(baseUrl: string, marker: string): Promise<number> {',
  '  if (fs.existsSync(marker)) return 0;',
  "  fs.writeFileSync(marker, '');",
  '  const response = await fetch(`${baseUrl}/once`);',
  '  return response.status;',
  '}',
  '',
  'export async function slow(baseUrl: string): Promise<number> {',
  '  const response = await fetch(`${baseUrl}/slow`);',
  '  return response.status;',
  '}',
  '',
  "export const warmed = fetch('http://127.0.0.1:1/warm').catch(() => undefined);",
  '',
].join('\n');

const PAIR_TEST = [
  "import os from 'node:os';",
  "import path from 'node:path';",
  "import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';",
  "import { first, once, second, slow } from '../src/pair.js';",
  "import { startServer, type TestServer } from './helpers/server.js';",
  '',
  'let server: TestServer;',
  '',
  'beforeAll(async () => {',
  '  server = await startServer({',
  "    'GET /first': { body: null },",
  "    'GET /second': { body: null },",
  "    'GET /once': { body: null },",
  "    'GET /slow': { body: null },",
  '  });',
  '});',
  'beforeEach(async () => {',
  "  expect(await first(server.url, 5_000)).toBe('200');",
  '});',
  'afterAll(() => server.close());',
  '',
  "it('calls both dependencies', async () => {",
  '  const [one, two] = await Promise.all([first(server.url), second(server.url)]);',
  "  expect(['200', 'unavailable']).toContain(one);",
  '  expect(two).toBe(200);',
  '});',
  '',
  "it('calls a dependency once per checkout', async () => {",
  "  expect([0, 200]).toContain(await once(server.url, path.join(os.tmpdir(), 'MARKER')));",
  '});',
  '',
  "it('gives up on the process when a dependency stalls', async () => {",
  // 300 ms leaves a loaded runner time to answer the real request in discovery, and still fires before a 400 ms fault deadline.
  '  const timer = setTimeout(() => process.kill(process.pid), 300);',
  '  expect(await slow(server.url)).toBe(200);',
  '  clearTimeout(timer);',
  '});',
  '',
  // The same margin: long enough for discovery on a loaded runner, short of a 400 ms fault deadline.
  "it('runs under a short timeout', { timeout: 300 }, async () => {",
  '  expect(await second(server.url)).toBe(200);',
  '});',
  '',
].join('\n');

let markers = 0;

/**
 * Adds untracked calls that behave differently under a fault: one handled, one hanging, one reached
 * only on the first run, one whose test kills its own process, and one made at import time.
 */
export function addPairModule(repo: TempRepo): void {
  markers += 1;
  repo.write('src/pair.ts', PAIR_SOURCE);
  repo.write('test/pair.test.ts', PAIR_TEST.replace('MARKER', `bruise-once-${process.pid}-${Date.now()}-${markers}`));
}

const CRASH_SOURCE = [
  'export async function lookup(baseUrl: string): Promise<number> {',
  '  const response = await fetch(`${baseUrl}/lookup`);',
  '  return response.status;',
  '}',
  '',
].join('\n');

const CRASH_TEST = [
  "import { afterAll, beforeAll, expect, it } from 'vitest';",
  "import { lookup } from '../src/crash.js';",
  "import { startServer, type TestServer } from './helpers/server.js';",
  '',
  'let server: TestServer;',
  '',
  "beforeAll(async () => {\n  server = await startServer({ 'GET /lookup': { body: null } });\n});",
  'afterAll(() => server.close());',
  '',
  "it('looks a value up, and takes its process down when the lookup fails', async () => {",
  '  try {',
  '    expect(await lookup(server.url)).toBe(200);',
  '  } catch {',
  '    process.kill(process.pid);',
  '    await new Promise(() => undefined);',
  '  }',
  '});',
  '',
].join('\n');

const SETUP_SOURCE = [
  'export async function load(baseUrl: string): Promise<number> {',
  '  const response = await fetch(`${baseUrl}/load`);',
  '  return response.status;',
  '}',
  '',
].join('\n');

const SETUP_TEST = [
  "import fs from 'node:fs';",
  "import os from 'node:os';",
  "import path from 'node:path';",
  "import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';",
  "import { load } from '../src/setup.js';",
  "import { startServer, type TestServer } from './helpers/server.js';",
  '',
  "const marker = path.join(os.tmpdir(), 'MARKER');",
  'let server: TestServer;',
  '',
  "beforeAll(async () => {\n  server = await startServer({ 'GET /load': { body: null } });\n});",
  'beforeEach(() => {',
  "  if (fs.existsSync(marker)) throw new Error('the fixture could not be prepared a second time');",
  '});',
  'afterAll(async () => {',
  "  fs.writeFileSync(marker, '');",
  '  await server.close();',
  '});',
  '',
  "it('loads a value', async () => {",
  '  expect(await load(server.url)).toBe(200);',
  '});',
  '',
].join('\n');

/** Adds a call whose test passes once and whose setup fails on every later run, before the body starts. */
export function addSetupFailureModule(repo: TempRepo): void {
  markers += 1;
  repo.write('src/setup.ts', SETUP_SOURCE);
  repo.write('test/setup.test.ts', SETUP_TEST.replace('MARKER', `bruise-setup-${process.pid}-${Date.now()}-${markers}`));
}

/** Adds a call whose test kills its own process when the call fails, as it does under any fault that rejects it. */
export function addCrashOnFaultModule(repo: TempRepo): void {
  repo.write('src/crash.ts', CRASH_SOURCE);
  repo.write('test/crash.test.ts', CRASH_TEST);
}

const WRAPPER_SOURCE = [
  'export async function getJson(url: string, timeoutMs: number): Promise<unknown> {',
  '  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });',
  '  return response.json();',
  '}',
  '',
].join('\n');

const STATUSES_SOURCE = [
  "import { getJson } from './http-client.js';",
  '',
  'export async function getStatuses(baseUrl: string): Promise<unknown> {',
  '  try {',
  // 300 ms leaves a loaded runner time to answer in discovery; the faulted test holds the call for longer.
  '    return await getJson(`${baseUrl}/statuses`, 300);',
  '  } catch {',
  '    return null;',
  '  }',
  '}',
  '',
].join('\n');

const PLACES_SOURCE = [
  "import { getJson } from './http-client.js';",
  '',
  'export function getPlaces(baseUrl: string): Promise<unknown> {',
  '  return getJson(`${baseUrl}/places`, 10_000);',
  '}',
  '',
].join('\n');

const WRAPPER_TEST = [
  "import { afterAll, beforeAll, expect, it } from 'vitest';",
  "import { getPlaces } from '../src/places.js';",
  "import { getStatuses } from '../src/statuses.js';",
  "import { startServer, type TestServer } from './helpers/server.js';",
  '',
  'let server: TestServer;',
  '',
  'beforeAll(async () => {',
  "  server = await startServer({ 'GET /statuses': { body: { ok: 'statuses' } }, 'GET /statuses?limit=500': { body: { ok: 'statuses' } }, 'GET /places': { body: { ok: 'places' } } });",
  '});',
  'afterAll(() => server.close());',
  '',
  "it('loads places', async () => {",
  "  expect(await getPlaces(server.url)).toEqual({ ok: 'places' });",
  '});',
  '',
  "it('loads statuses and places', async () => {",
  "  expect(await getPlaces(server.url)).toEqual({ ok: 'places' });",
  "  expect([{ ok: 'statuses' }, null]).toContainEqual(await getStatuses(server.url));",
  '});',
  '',
].join('\n');

/**
 * A fetch wrapper in its own unchanged file, called from a changed function and from an unchanged one.
 * Commits the wrapper as the base, then changes only the line in getStatuses that calls it.
 */
export function addWrapperModule(repo: TempRepo): void {
  repo.write('src/http-client.ts', WRAPPER_SOURCE);
  repo.write('src/statuses.ts', STATUSES_SOURCE);
  repo.write('src/places.ts', PLACES_SOURCE);
  repo.write('test/wrapper.test.ts', WRAPPER_TEST);
  repo.branch('origin/main', repo.commit('Add a fetch wrapper and its callers'));
  repo.edit('src/statuses.ts', '`${baseUrl}/statuses`, 300', '`${baseUrl}/statuses?limit=500`, 300');
}

const EVIDENCE_SOURCE = [
  'export async function checkedRate(baseUrl: string): Promise<number> {',
  '  const response = await fetch(`${baseUrl}/checked`);',
  '  if (!response.ok) {',
  '    throw new Error(`rate request failed with ${response.status}`);',
  '  }',
  '  return ((await response.json()) as { rate: number }).rate;',
  '}',
  '',
  'export async function fallbackRate(baseUrl: string): Promise<number> {',
  '  try {',
  '    const response = await fetch(`${baseUrl}/fallback`);',
  '    return ((await response.json()) as { rate: number }).rate;',
  '  } catch {',
  '    return 1;',
  '  }',
  '}',
  '',
  'export async function escapingRate(baseUrl: string): Promise<number> {',
  '  const response = await fetch(`${baseUrl}/escaping`);',
  '  return ((await response.json()) as { rate: number }).rate;',
  '}',
  '',
  'export async function wrappedRate(baseUrl: string): Promise<number> {',
  '  const response = await fetch(`${baseUrl}/wrapped`);',
  '  try {',
  '    return ((await response.json()) as { rate: number }).rate;',
  '  } catch (error) {',
  "    throw new Error('the rate payload could not be read', { cause: error });",
  '  }',
  '}',
  '',
].join('\n');

const EVIDENCE_TEST = [
  "import { afterAll, beforeAll, expect, it } from 'vitest';",
  "import { checkedRate, escapingRate, fallbackRate, wrappedRate } from '../src/evidence.js';",
  "import { startServer, type TestServer } from './helpers/server.js';",
  '',
  'let server: TestServer;',
  '',
  'beforeAll(async () => {',
  '  server = await startServer({',
  "    'GET /checked': { body: { rate: 1.5 } },",
  "    'GET /fallback': { body: { rate: 1.5 } },",
  "    'GET /escaping': { body: { rate: 1.5 } },",
  "    'GET /wrapped': { body: { rate: 1.5 } },",
  '  });',
  '});',
  'afterAll(() => server.close());',
  '',
  "it('loads a checked rate', async () => {",
  '  expect(await checkedRate(server.url)).toBe(1.5);',
  '});',
  '',
  "it('loads a rate with a fallback', async () => {",
  '  expect(await fallbackRate(server.url)).toBe(1.5);',
  '});',
  '',
  "it('loads a rate without handling', async () => {",
  '  expect(await escapingRate(server.url)).toBe(1.5);',
  '});',
  '',
  "it('loads a rate that wraps a bad payload', async () => {",
  '  expect(await wrappedRate(server.url)).toBe(1.5);',
  '});',
  '',
].join('\n');

/**
 * Four functions whose happy-path tests fail under any fault, each for a different reason: a status check
 * that throws its own error, a catch that returns a fallback, nothing at all, and a parse wrapped in its own error.
 */
export function addEvidenceModule(repo: TempRepo): void {
  repo.write('src/evidence.ts', EVIDENCE_SOURCE);
  repo.write('test/evidence.test.ts', EVIDENCE_TEST);
}
