import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as vitestNode from 'vitest/node';
import { PRESETS, type Intensity } from '../../src/core/index.js';
import { scopeDiff } from '../../src/diff-scoper/index.js';
import { pristineFingerprints } from '../../src/fault-recon/conflicts.js';
import { isRunnableKind, runFaults, type CallSiteResult, type FaultRunResult } from '../../src/fault-run/index.js';
import { runInstrumented } from '../../src/fault-run/instrumented.js';
import { selectCallSites } from '../../src/fault-run/select.js';
import type { ProgressEvent, ProgressListener } from '../../src/progress/events.js';
import { addPairModule } from '../helpers/fault-fixtures.js';
import { createSampleApp, history, type SampleApp } from '../helpers/sample-app.js';

const TIMEOUT_MS = 90_000;
const DEADLINE_MS = 400;

interface RunOptions {
  readonly intensity: Intensity;
  readonly budgetMs?: number;
  readonly now?: () => number;
  readonly seed?: number;
  readonly onProgress?: ProgressListener;
}

async function run(app: SampleApp, options: RunOptions): Promise<FaultRunResult> {
  const scope = await scopeDiff({ repoRoot: app.dir, mode: 'enclosing-functions' });
  return runFaults({
    targetRoot: app.dir,
    configFile: path.join(app.dir, 'vitest.config.ts'),
    ranges: scope.ranges,
    intensity: options.intensity,
    budgetMs: options.budgetMs ?? 60_000,
    testDeadlineMs: DEADLINE_MS,
    vitestNode,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.seed === undefined ? {} : { seed: options.seed }),
    ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
  });
}

function verdicts(results: readonly CallSiteResult[]): Record<string, string> {
  return Object.fromEntries(results.map((result) => [`${result.site.file} ${result.site.functionName}`, result.verdict]));
}

function workDirEntries(app: SampleApp): string[] {
  return fs.readdirSync(path.join(app.dir, '.chimpd'));
}

describe('fault run on the sample app', () => {
  let app: SampleApp;

  beforeAll(() => {
    app = createSampleApp();
    history.clientChanges(app);
  });

  afterAll(() => app.cleanup());

  it(
    'gives one verdict per changed call site',
    async () => {
      const events: ProgressEvent[] = [];
      const result = await run(app, { intensity: 2, onProgress: (event) => events.push(event) });
      const held = result.results.filter((entry) => entry.kind === 'blackhole');
      const serverError = result.results.filter((entry) => entry.kind === 'http-500');

      expect(result.status).toBe('completed');
      expect(result.statusReason).toBeNull();
      expect(verdicts(held)).toEqual({
        'src/clients/inventory.ts checkStock': 'handled-timeout',
        'src/clients/ledger.ts postLedgerEntry': 'hang',
        'src/clients/profile.ts fetchProfile': 'hang',
        'src/telemetry.ts trackEvent': 'detached',
      });
      expect(held.map((entry) => entry.findingKind)).toEqual([
        null,
        'hang-no-timeout',
        'hang-no-timeout',
        'fire-and-forget',
      ]);
      expect(verdicts(serverError)).toEqual({
        'src/clients/inventory.ts checkStock': 'status-ignored',
        'src/clients/ledger.ts postLedgerEntry': 'status-mishandled',
        'src/clients/profile.ts fetchProfile': 'status-mishandled',
        'src/telemetry.ts trackEvent': 'response-unused',
      });
      expect(serverError.map((entry) => entry.findingKind)).toEqual([
        'error-status-ignored',
        'error-status-mishandled',
        'error-status-mishandled',
        null,
      ]);
      expect(held.map((entry) => entry.tests.map(({ test }) => test.name))).toEqual([
        ['renders a product page for the requested sku'],
        ['posts a ledger entry'],
        ['loads a profile'],
        ['returns the discounted total'],
      ]);
      expect(result.skipped).toEqual([]);
      expect(result.conflicts).toEqual([{ testFile: 'test/notifications.test.ts', patched: ['fetch'] }]);
      expect(result.spentMs).toBeGreaterThan(0);
      expect(result.timings.faultRuns).toBe(8);
      expect(events.map((event) => (event.type === 'site-faulted' ? [event.done, event.total, event.kind] : null))).toEqual(
        [1, 2, 3, 4, 5, 6, 7, 8].map((done) => [done, 8, done <= 4 ? 'blackhole' : 'http-500']),
      );
      expect(result.timings.discoveryMs).toBeGreaterThan(0);
      expect(result.timings.faultRunsMs).toBeGreaterThan(0);
      expect((result.timings.discoveryMs ?? 0) + result.timings.faultRunsMs).toBeLessThanOrEqual(result.spentMs + 1);
      expect(workDirEntries(app)).toEqual(['.gitignore']);
      expect((await scopeDiff({ repoRoot: app.dir, mode: 'enclosing-functions' })).dirty).toBe(false);
    },
    TIMEOUT_MS,
  );

  it(
    'faults no more call sites than the preset allows and skips the rest as over-cap',
    async () => {
      const result = await run(app, { intensity: 1 });
      expect(result.status).toBe('completed');
      expect(result.results.map((entry) => entry.site.file)).toEqual([
        'src/clients/inventory.ts',
        'src/clients/ledger.ts',
        'src/clients/profile.ts',
      ]);
      expect(result.skipped.map((entry) => [entry.site.file, entry.reason])).toEqual([['src/telemetry.ts', 'over-cap']]);
    },
    TIMEOUT_MS,
  );

  it(
    'runs every kind on every selected site, kind by kind in the order the preset lists them',
    async () => {
      const result = await run(app, { intensity: 3 });
      const kinds = PRESETS[3].faultKinds.filter(isRunnableKind);
      expect(kinds.slice(0, 1)).toEqual(['blackhole']);
      expect(kinds).toContain('connection-refused');
      const sites = [...new Set(result.results.map((entry) => entry.site.key))];
      expect(sites).toHaveLength(4);
      expect(result.results.map((entry) => [entry.kind, entry.site.key])).toEqual(kinds.flatMap((kind) => sites.map((key) => [kind, key])));
      const refused = result.results.filter((entry) => entry.kind === 'connection-refused');
      expect(verdicts(refused)).toEqual({
        'src/clients/inventory.ts checkStock': 'refusal-handled',
        'src/clients/ledger.ts postLedgerEntry': 'refusal-mishandled',
        'src/clients/profile.ts fetchProfile': 'refusal-mishandled',
        'src/telemetry.ts trackEvent': 'refusal-handled',
      });
      expect(refused.map((entry) => entry.findingKind)).toEqual([null, 'refusal-mishandled', 'refusal-mishandled', null]);
      expect(result.status).toBe('completed');
    },
    TIMEOUT_MS * 2,
  );

  it(
    'lets the seed pick among call sites of equal severity over the cap',
    async () => {
      const all = await run(app, { intensity: 2 });
      const sites = all.results.filter((entry) => entry.kind === 'blackhole').map((entry) => entry.site);
      const expected = (seed: number) => selectCallSites(sites, PRESETS[1], seed);
      const seed = Array.from({ length: 50 }, (_, index) => index).find(
        (candidate) => expected(candidate).skipped.map(({ site }) => site.file).join() !== 'src/telemetry.ts',
      );
      expect(seed).toBeDefined();
      const result = await run(app, { intensity: 1, seed: seed ?? 0 });
      const selection = expected(seed ?? 0);
      expect(result.results.map((entry) => entry.site.key)).toEqual(selection.planned.map(({ site }) => site.key));
      expect(result.skipped.map((entry) => [entry.site.key, entry.reason])).toEqual(
        selection.skipped.map(({ site, reason }) => [site.key, reason]),
      );
    },
    TIMEOUT_MS * 2,
  );

  it(
    'stops when the budget runs out and returns what finished plus the sites it skipped',
    async () => {
      // Each reading of the clock is 30 s later: one before discovery, then one before each site.
      let readings = 0;
      const now = (): number => readings++ * 30_000;
      const result = await run(app, { intensity: 2, budgetMs: 100_000, now });

      expect(result.status).toBe('budget-exhausted');
      expect(result.statusReason).toBe('the budget ran out before every call site was faulted');
      expect(verdicts(result.results)).toEqual({
        'src/clients/inventory.ts checkStock': 'handled-timeout',
        'src/clients/ledger.ts postLedgerEntry': 'hang',
      });
      const later = PRESETS[2].faultKinds.filter(isRunnableKind).slice(1);
      const sites = ['src/clients/inventory.ts', 'src/clients/ledger.ts', 'src/clients/profile.ts', 'src/telemetry.ts'];
      expect(result.skipped.map((entry) => [entry.site.file, entry.kind, entry.reason])).toEqual([
        ['src/clients/profile.ts', 'blackhole', 'budget'],
        ['src/telemetry.ts', 'blackhole', 'budget'],
        ...later.flatMap((kind) => sites.map((file) => [file, kind, 'budget'])),
      ]);
      expect(workDirEntries(app)).toEqual(['.gitignore']);
    },
    TIMEOUT_MS,
  );

  it(
    'returns no verdicts when the budget ends during discovery',
    async () => {
      const result = await run(app, { intensity: 2, budgetMs: 1 });
      expect(result).toMatchObject({
        status: 'budget-exhausted',
        statusReason: 'the budget ran out before call sites were discovered',
        results: [],
        skipped: [],
      });
      expect(workDirEntries(app)).toEqual(['.gitignore']);
    },
    TIMEOUT_MS,
  );
});

describe('fault run uncertainty', () => {
  let app: SampleApp;
  let result: FaultRunResult;

  beforeAll(async () => {
    app = createSampleApp();
    addPairModule(app);
    result = await run(app, { intensity: 3 });
  }, TIMEOUT_MS);

  afterAll(() => app.cleanup());

  const resultFor = (functionName: string | null): CallSiteResult | undefined =>
    result.results.find((entry) => entry.site.file === 'src/pair.ts' && entry.site.functionName === functionName);

  it('still reports the sites it could decide', () => {
    expect(result.status).toBe('completed');
    expect(resultFor('first')?.verdict).toBe('handled-timeout');
    expect(resultFor('second')?.verdict).toBe('hang');
  });

  it('is inconclusive, not handled, when the test stops reaching the site', () => {
    expect(resultFor('once')).toMatchObject({
      verdict: 'inconclusive',
      findingKind: null,
      reason: 'the test did not reach the call site under the fault',
    });
  });

  it('is inconclusive, not handled, when the test process dies mid-test', () => {
    expect(resultFor('slow')).toMatchObject({
      verdict: 'inconclusive',
      findingKind: null,
      reason: 'the test process ended before the test body finished',
    });
  });

  it('is inconclusive for a call made at import time, which is never faulted', () => {
    const warm = result.results.find((entry) => entry.site.line === app.lineOf('src/pair.ts', '/warm'));
    expect(warm).toMatchObject({ verdict: 'inconclusive', tests: [] });
    expect(warm?.reason).toContain('outside a test body');
  });
});

describe('fault run preconditions', () => {
  it(
    'is inconclusive as a whole when fetch was patched before the tests loaded',
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
        const result = await run(app, { intensity: 2 });
        expect(result.status).toBe('inconclusive');
        expect(result.statusReason).toContain('fetch');
        expect(result.results).toEqual([]);
      } finally {
        app.cleanup();
      }
    },
    TIMEOUT_MS,
  );
});

describe('instrumented run cleanup', () => {
  let app: SampleApp;

  beforeAll(() => {
    app = createSampleApp();
  });

  afterAll(() => app.cleanup());

  async function recon(timeoutMs?: number) {
    return runInstrumented({
      targetRoot: app.dir,
      configFile: path.join(app.dir, 'vitest.config.ts'),
      vitestNode,
      pristine: await pristineFingerprints(),
      mode: { kind: 'recon' },
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
  }

  it(
    'removes its stub when the run is killed at its time limit',
    async () => {
      const killed = await recon(1);
      expect(killed.killed).toBe(true);
      expect(workDirEntries(app)).toEqual(['.gitignore']);
    },
    TIMEOUT_MS,
  );

  it(
    'removes the stub a crashed run left behind, and leaves a live run alone',
    async () => {
      const workDir = path.join(app.dir, '.chimpd');
      const abandoned = path.join(workDir, 'fault-2147483646-crashed');
      const live = path.join(workDir, `fault-${process.pid}-live`);
      fs.mkdirSync(abandoned);
      fs.writeFileSync(path.join(abandoned, 'setup.mjs'), '');
      fs.mkdirSync(live);

      const finished = await recon();
      expect(finished.killed).toBe(false);
      expect(workDirEntries(app).sort()).toEqual(['.gitignore', path.basename(live)]);
    },
    TIMEOUT_MS,
  );
});
