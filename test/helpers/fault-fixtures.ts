import type { TempRepo } from './temp-repo.js';

const PAIR_SOURCE = [
  "import fs from 'node:fs';",
  '',
  'export async function first(baseUrl: string): Promise<string> {',
  '  try {',
  '    const response = await fetch(`${baseUrl}/first`, { signal: AbortSignal.timeout(100) });',
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
  "  expect(await first(server.url)).toBe('200');",
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
  '  const timer = setTimeout(() => process.kill(process.pid), 150);',
  '  expect(await slow(server.url)).toBe(200);',
  '  clearTimeout(timer);',
  '});',
  '',
  "it('runs under a short timeout', { timeout: 150 }, async () => {",
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
  repo.write('test/pair.test.ts', PAIR_TEST.replace('MARKER', `chimpd-once-${process.pid}-${Date.now()}-${markers}`));
}
