import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as vitestNode from 'vitest/node';
import type { ScopeMode } from '../../src/core/index.js';
import { scopeDiff, type DiffScope } from '../../src/diff-scoper/index.js';
import { discoverCallSites, type CallSite, type Discovery } from '../../src/fault-run/index.js';
import { createSampleApp, history, type SampleApp } from '../helpers/sample-app.js';
import type { TempRepo } from '../helpers/temp-repo.js';

const TIMEOUT_MS = 60_000;

async function discover(app: SampleApp, mode: ScopeMode): Promise<{ scope: DiffScope; discovery: Discovery }> {
  const scope = await scopeDiff({ repoRoot: app.dir, mode });
  const discovery = await discoverCallSites({
    targetRoot: app.dir,
    configFile: path.join(app.dir, 'vitest.config.ts'),
    ranges: scope.ranges,
    vitestNode,
  });
  return { scope, discovery };
}

function siteAt(discovery: Discovery, repo: TempRepo, file: string, snippet: string): CallSite | undefined {
  const line = repo.lineOf(file, snippet);
  return discovery.sites.find((site) => site.file === file && site.line === line);
}

function reachingTests(site: CallSite | undefined): string[] {
  return (site?.reachedBy ?? []).map(({ test }) => `${test.file} > ${test.name}`);
}

describe('call-site discovery on the sample app', () => {
  let app: SampleApp;
  let scope: DiffScope;
  let discovery: Discovery;

  beforeAll(async () => {
    app = createSampleApp();
    history.clientChanges(app);
    ({ scope, discovery } = await discover(app, 'changed-lines'));
  }, TIMEOUT_MS);

  afterAll(() => app.cleanup());

  it('completes and finds each changed call with the test whose body reaches it', () => {
    expect(discovery.status).toBe('completed');
    expect(discovery.sites.map((site) => site.file)).toEqual([
      'src/clients/inventory.ts',
      'src/clients/profile.ts',
      'src/telemetry.ts',
    ]);
    expect(reachingTests(siteAt(discovery, app, 'src/clients/inventory.ts', 'await fetch('))).toEqual([
      'test/product-page.test.ts > renders a product page for the requested sku',
    ]);
    expect(reachingTests(siteAt(discovery, app, 'src/clients/profile.ts', 'await fetch('))).toEqual([
      'test/profile.test.ts > loads a profile',
    ]);
    expect(reachingTests(siteAt(discovery, app, 'src/telemetry.ts', 'void fetch('))).toEqual([
      'test/checkout.test.ts > returns the discounted total',
    ]);
  });

  it('describes a site by its innermost frame and keeps the callers', () => {
    const site = siteAt(discovery, app, 'src/clients/inventory.ts', 'await fetch(');
    expect(site).toMatchObject({
      key: `src/clients/inventory.ts:${site?.line}:${site?.column}`,
      functionName: 'checkStock',
      path: 'fetch',
      scopeKind: 'changed',
      unattributedCalls: 0,
    });
    expect(site?.frames.map((frame) => frame.file)).toEqual(['src/clients/inventory.ts', 'src/product-page.ts']);
    expect(site?.reachedBy[0]?.calls).toBe(1);
    expect(site?.reachedBy[0]?.durationMs).toBeGreaterThan(0);
  });

  it('leaves out a call whose own line did not change', () => {
    expect(siteAt(discovery, app, 'src/clients/ledger.ts', 'http.request(')).toBeUndefined();
    expect(discovery.outOfScopeSites).toBe(1);
  });

  it('reports a test file that replaces fetch as a conflict and finds no site under it', () => {
    expect(discovery.conflicts).toEqual([{ testFile: 'test/notifications.test.ts', patched: ['fetch'] }]);
    expect(discovery.sites.some((site) => site.file === 'src/notifications.ts')).toBe(false);
  });

  it('finds no site for a call the only related test mocks away', () => {
    expect(discovery.sites.some((site) => site.file === 'src/clients/rates.ts')).toBe(false);
  });

  it('leaves nothing behind in the target', async () => {
    expect(fs.readdirSync(path.join(app.dir, '.chimpd'))).toEqual(['.gitignore']);
    expect(await scopeDiff({ repoRoot: app.dir, mode: 'changed-lines' })).toEqual(scope);
    expect(scope.dirty).toBe(false);
  });
});

describe('call-site discovery with enclosing functions', () => {
  let app: SampleApp;
  let discovery: Discovery;

  beforeAll(async () => {
    app = createSampleApp();
    history.clientChanges(app);
    ({ discovery } = await discover(app, 'enclosing-functions'));
  }, TIMEOUT_MS);

  afterAll(() => app.cleanup());

  it('includes an http call inside a changed function', () => {
    const site = siteAt(discovery, app, 'src/clients/ledger.ts', 'http.request(');
    // The call sits in a Promise executor, so its name comes from the function around it.
    expect(site).toMatchObject({ path: 'http', scopeKind: 'enclosing-function', functionName: 'postLedgerEntry' });
    expect(reachingTests(site)).toEqual(['test/ledger.test.ts > posts a ledger entry']);
    expect(discovery.outOfScopeSites).toBe(0);
  });
});

const PING_SOURCE = [
  'export function ping(baseUrl: string): Promise<number> {',
  '  return fetch(`${baseUrl}/ping`).then((response) => response.status);',
  '}',
  '',
  'export function pong(baseUrl: string): Promise<number> {',
  '  return fetch(`${baseUrl}/pong`).then((response) => response.status);',
  '}',
  '',
  "export const warmed = fetch('http://127.0.0.1:1/warm').catch(() => undefined);",
  '',
].join('\n');

const HOOKS_TEST = [
  "import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';",
  "import { ping } from '../src/ping.js';",
  "import { startServer, type TestServer } from './helpers/server.js';",
  '',
  'let server: TestServer;',
  '',
  'beforeAll(async () => {',
  "  server = await startServer({ 'GET /ping': { body: null } });",
  '  await ping(server.url);',
  '});',
  'beforeEach(async () => {',
  '  await ping(server.url);',
  '});',
  'afterEach(async () => {',
  '  await ping(server.url);',
  '});',
  'afterAll(() => server.close());',
  '',
  "it('pings from its body', async () => {",
  '  expect(await ping(server.url)).toBe(200);',
  '});',
  '',
  "it('pings only from hooks', () => {",
  '  expect(server.url).toContain(\'127.0.0.1\');',
  '});',
  '',
  "it('pings and then fails', async () => {",
  '  expect(await ping(server.url)).toBe(500);',
  '});',
  '',
].join('\n');

const CONCURRENT_TEST = [
  "import { afterAll, beforeAll, expect, it } from 'vitest';",
  "import { ping, pong } from '../src/ping.js';",
  "import { startServer, type TestServer } from './helpers/server.js';",
  '',
  'let server: TestServer;',
  'const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));',
  '',
  'beforeAll(async () => {',
  "  server = await startServer({ 'GET /ping': { body: null }, 'GET /pong': { body: null } });",
  '});',
  'afterAll(() => server.close());',
  '',
  "it.concurrent('pings late', async () => {",
  '  await sleep(40);',
  '  expect(await ping(server.url)).toBe(200);',
  '});',
  '',
  "it.concurrent('pongs early', async () => {",
  '  expect(await pong(server.url)).toBe(200);',
  '  await sleep(40);',
  '});',
  '',
].join('\n');

describe('call-site attribution', () => {
  let app: SampleApp;
  let discovery: Discovery;

  beforeAll(async () => {
    app = createSampleApp();
    app.write('src/ping.ts', PING_SOURCE);
    app.write('test/hooks.test.ts', HOOKS_TEST);
    app.write('test/concurrent.test.ts', CONCURRENT_TEST);
    ({ discovery } = await discover(app, 'changed-lines'));
  }, TIMEOUT_MS);

  afterAll(() => app.cleanup());

  it('attributes a call only to passing tests whose body made it, cheapest first, even when tests overlap', () => {
    expect(reachingTests(siteAt(discovery, app, 'src/ping.ts', '/ping`'))).toEqual([
      'test/hooks.test.ts > pings from its body',
      'test/concurrent.test.ts > pings late',
    ]);
    expect(reachingTests(siteAt(discovery, app, 'src/ping.ts', '/pong`'))).toEqual([
      'test/concurrent.test.ts > pongs early',
    ]);
  });

  it('counts calls from hooks as unattributed', () => {
    // One beforeAll call, then a beforeEach and an afterEach call around each of the three tests.
    expect(siteAt(discovery, app, 'src/ping.ts', '/ping`')?.unattributedCalls).toBe(7);
  });

  it('records an import-time call as a site that no test reaches', () => {
    const site = siteAt(discovery, app, 'src/ping.ts', '/warm');
    expect(site?.reachedBy).toEqual([]);
    expect(site?.unattributedCalls).toBeGreaterThanOrEqual(1);
  });
});

describe('call-site discovery preconditions', () => {
  it('does not run anything when the scope is empty', async () => {
    const neverLoaded = new Proxy({}, {
      get() {
        throw new Error('vitest must not be started for an empty scope');
      },
    }) as typeof vitestNode;
    const discovery = await discoverCallSites({
      targetRoot: process.cwd(),
      configFile: 'vitest.config.ts',
      ranges: [],
      vitestNode: neverLoaded,
    });
    expect(discovery).toEqual({
      status: 'completed',
      statusReason: null,
      budgetExhausted: false,
      sites: [],
      outOfScopeSites: 0,
      conflicts: [],
    });
  });

  it(
    'is inconclusive when fetch was patched before the tests loaded',
    async () => {
      const app = createSampleApp();
      try {
        history.clientChanges(app);
        app.write('patch-fetch.mjs', 'globalThis.fetch = () => Promise.resolve(new Response(null));\n');
        const preload = pathToFileURL(path.join(app.dir, 'patch-fetch.mjs')).href;
        app.write(
          'vitest.config.ts',
          [
            "import { defineConfig } from 'vitest/config';",
            '',
            'export default defineConfig({',
            `  test: { include: ['test/**/*.test.ts'], execArgv: ['--import', ${JSON.stringify(preload)}] },`,
            '});',
            '',
          ].join('\n'),
        );
        app.commit('Preload a fetch replacement');
        const { discovery } = await discover(app, 'changed-lines');
        expect(discovery.status).toBe('inconclusive');
        expect(discovery.statusReason).toContain('fetch');
        expect(discovery.sites).toEqual([]);
      } finally {
        app.cleanup();
      }
    },
    TIMEOUT_MS,
  );
});
