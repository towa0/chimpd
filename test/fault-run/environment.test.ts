import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import * as vitestNode from 'vitest/node';
import { scopeDiff } from '../../src/diff-scoper/index.js';
import { runFaults, type CallSiteResult, type FaultRunResult } from '../../src/fault-run/index.js';
import { createSampleApp, history, type SampleApp } from '../helpers/sample-app.js';

const TIMEOUT_MS = 120_000;
const DEADLINE_MS = 400;

const apps: SampleApp[] = [];

afterEach(() => {
  for (const app of apps.splice(0)) app.cleanup();
});

interface DomApp {
  readonly preload?: string;
  readonly setupFile?: string;
  readonly files?: Readonly<Record<string, string>>;
}

/** The sample app with its client changes, tested under Vitest's jsdom environment. */
function domApp(options: DomApp = {}): SampleApp {
  const app = createSampleApp();
  apps.push(app);
  history.clientChanges(app);
  const test: string[] = ["include: ['test/**/*.test.ts']", "environment: 'jsdom'"];
  if (options.preload !== undefined) {
    app.write('preload.mjs', options.preload);
    test.push(`execArgv: ['--import', ${JSON.stringify(pathToFileURL(path.join(app.dir, 'preload.mjs')).href)}]`);
  }
  if (options.setupFile !== undefined) {
    app.write('test/setup.ts', options.setupFile);
    test.push("setupFiles: ['./test/setup.ts']");
  }
  for (const [file, content] of Object.entries(options.files ?? {})) app.write(file, content);
  app.write(
    'vitest.config.ts',
    ["import { defineConfig } from 'vitest/config';", '', `export default defineConfig({ test: { ${test.join(', ')} } });`, ''].join('\n'),
  );
  app.commit('Test under jsdom');
  return app;
}

async function run(app: SampleApp): Promise<FaultRunResult> {
  const scope = await scopeDiff({ repoRoot: app.dir, mode: 'enclosing-functions' });
  return runFaults({
    targetRoot: app.dir,
    configFile: path.join(app.dir, 'vitest.config.ts'),
    ranges: scope.ranges,
    intensity: 2,
    budgetMs: 90_000,
    testDeadlineMs: DEADLINE_MS,
    vitestNode,
  });
}

function verdicts(results: readonly CallSiteResult[]): Record<string, string> {
  return Object.fromEntries(results.map((result) => [`${result.site.file} ${result.site.functionName}`, result.verdict]));
}

describe('fault run under the jsdom environment', () => {
  it(
    'treats the Request that jsdom installs as the environment, not as a patch',
    async () => {
      const result = await run(domApp());
      expect(result.statusReason).toBeNull();
      expect(result.status).toBe('completed');
      expect(verdicts(result.results.filter((entry) => entry.kind === 'blackhole'))).toEqual({
        'src/clients/inventory.ts checkStock': 'handled-timeout',
        'src/clients/ledger.ts postLedgerEntry': 'hang',
        'src/clients/profile.ts fetchProfile': 'hang',
        'src/telemetry.ts trackEvent': 'detached',
      });
      expect(result.conflicts).toEqual([{ testFile: 'test/notifications.test.ts', patched: ['fetch'] }]);
    },
    TIMEOUT_MS,
  );

  it(
    'still flags fetch replaced before the tests loaded',
    async () => {
      const result = await run(domApp({ preload: 'globalThis.fetch = () => Promise.resolve(new Response(null));\n' }));
      expect(result).toMatchObject({
        status: 'inconclusive',
        statusReason: 'HTTP entry points were already patched before the tests loaded: fetch',
        results: [],
      });
    },
    TIMEOUT_MS,
  );

  it(
    'still flags Request replaced before the tests loaded, though jsdom wraps it in its own class',
    async () => {
      const result = await run(domApp({ preload: 'globalThis.Request = class Request extends globalThis.Request {};\n' }));
      expect(result).toMatchObject({
        status: 'inconclusive',
        statusReason: 'HTTP entry points were already patched before the tests loaded: Request',
        results: [],
      });
    },
    TIMEOUT_MS,
  );

  it(
    'still flags an interceptor that a setup file applies, as msw does',
    async () => {
      const setupFile = [
        "import { FetchInterceptor } from '@mswjs/interceptors/fetch';",
        '',
        'new FetchInterceptor().apply();',
        '',
      ].join('\n');
      const result = await run(domApp({ setupFile }));
      expect(result.conflicts.length).toBeGreaterThan(0);
      expect(result.conflicts.every((conflict) => conflict.patched.includes('fetch'))).toBe(true);
      expect(result.results.filter((entry) => entry.findingKind !== null)).toEqual([]);
    },
    TIMEOUT_MS,
  );

  it(
    'still flags test files that replace http.request, as nock does, or Request',
    async () => {
      const files = {
        'test/nock-style.test.ts': [
          "import http from 'node:http';",
          "import { expect, it } from 'vitest';",
          "import { postLedgerEntry } from '../src/clients/ledger.js';",
          '',
          "it('replaces http.request', () => {",
          '  const original = http.request;',
          '  http.request = ((...args: Parameters<typeof original>) => original(...args)) as typeof original;',
          '  expect(typeof postLedgerEntry).toBe("function");',
          '});',
          '',
        ].join('\n'),
        'test/request-subclass.test.ts': [
          "import { expect, it } from 'vitest';",
          "import { fetchProfile } from '../src/clients/profile.js';",
          '',
          "it('replaces Request', () => {",
          '  globalThis.Request = class Request extends globalThis.Request {};',
          '  expect(typeof fetchProfile).toBe("function");',
          '});',
          '',
        ].join('\n'),
      };
      const result = await run(domApp({ files }));
      expect(result.conflicts).toEqual([
        { testFile: 'test/nock-style.test.ts', patched: ['http.request'] },
        { testFile: 'test/notifications.test.ts', patched: ['fetch'] },
        { testFile: 'test/request-subclass.test.ts', patched: ['Request'] },
      ]);
    },
    TIMEOUT_MS,
  );
});
