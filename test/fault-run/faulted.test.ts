import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as vitestNode from 'vitest/node';
import { scopeDiff } from '../../src/diff-scoper/index.js';
import { pristineFingerprints, type Fingerprints } from '../../src/fault-recon/conflicts.js';
import { discoverCallSites } from '../../src/fault-run/discover.js';
import { runFaultedSite, type SiteRun } from '../../src/fault-run/faulted.js';
import type { CallSite, Discovery } from '../../src/fault-run/types.js';
import { addPairModule, addSetupFailureModule } from '../helpers/fault-fixtures.js';
import { createSampleApp, history, type SampleApp } from '../helpers/sample-app.js';

const TIMEOUT_MS = 60_000;
const DEADLINE_MS = 400;

let pristine: Fingerprints;

beforeAll(async () => {
  pristine = await pristineFingerprints();
});

async function discover(app: SampleApp): Promise<Discovery> {
  const scope = await scopeDiff({ repoRoot: app.dir, mode: 'enclosing-functions' });
  return discoverCallSites({
    targetRoot: app.dir,
    configFile: path.join(app.dir, 'vitest.config.ts'),
    ranges: scope.ranges,
    vitestNode,
    pristine,
  });
}

function siteAt(discovery: Discovery, app: SampleApp, file: string, snippet: string): CallSite {
  const line = app.lineOf(file, snippet);
  const site = discovery.sites.find((entry) => entry.file === file && entry.line === line);
  if (site === undefined) throw new Error(`no call site at ${file}:${line}`);
  return site;
}

function fault(app: SampleApp, site: CallSite): Promise<SiteRun> {
  return runFaultedSite({
    targetRoot: app.dir,
    configFile: path.join(app.dir, 'vitest.config.ts'),
    vitestNode,
    pristine,
    site,
    tests: site.reachedBy,
    deadlineMs: DEADLINE_MS,
  });
}

describe('faulted runs on the sample app', () => {
  let app: SampleApp;
  let discovery: Discovery;

  beforeAll(async () => {
    app = createSampleApp();
    history.clientChanges(app);
    discovery = await discover(app);
  }, TIMEOUT_MS);

  afterAll(() => app.cleanup());

  it(
    'observes a signal timeout that the code handles',
    async () => {
      const run = await fault(app, siteAt(discovery, app, 'src/clients/inventory.ts', 'await fetch('));
      expect(run.tests).toHaveLength(1);
      expect(run.tests[0]?.problem).toBeNull();
      expect(run.tests[0]?.observations).toEqual([
        {
          metadataCaptured: true,
          signalAttached: true,
          signalDeadlineMs: 150,
          socketTimeoutMs: null,
          requestState: 'aborted',
          firedMechanism: 'signal',
          abortKind: 'timeout',
          testOutcome: 'passed',
          errorEscaped: false,
          deadlineHit: false,
        },
      ]);
    },
    TIMEOUT_MS,
  );

  it(
    'observes a fetch without a timeout still pending at the deadline',
    async () => {
      const run = await fault(app, siteAt(discovery, app, 'src/clients/profile.ts', 'await fetch('));
      expect(run.tests[0]?.problem).toBeNull();
      expect(run.tests[0]?.observations).toEqual([
        expect.objectContaining({
          signalAttached: false,
          signalDeadlineMs: null,
          requestState: 'pending',
          firedMechanism: null,
          deadlineHit: true,
        }),
      ]);
    },
    TIMEOUT_MS,
  );

  it(
    'observes an http request without a timeout still pending at the deadline',
    async () => {
      const run = await fault(app, siteAt(discovery, app, 'src/clients/ledger.ts', 'http.request('));
      expect(run.tests[0]?.problem).toBeNull();
      expect(run.tests[0]?.observations).toEqual([
        expect.objectContaining({
          signalAttached: false,
          socketTimeoutMs: null,
          requestState: 'pending',
          deadlineHit: true,
        }),
      ]);
    },
    TIMEOUT_MS,
  );

  it(
    'observes a request the test never waits for',
    async () => {
      const run = await fault(app, siteAt(discovery, app, 'src/telemetry.ts', 'void fetch('));
      expect(run.tests[0]?.problem).toBeNull();
      expect(run.tests[0]?.observations).toEqual([
        expect.objectContaining({
          requestState: 'pending',
          testOutcome: 'passed',
          errorEscaped: false,
          deadlineHit: false,
        }),
      ]);
    },
    TIMEOUT_MS,
  );

  it('leaves nothing behind in the target', async () => {
    const scope = await scopeDiff({ repoRoot: app.dir, mode: 'enclosing-functions' });
    expect(scope.dirty).toBe(false);
  });
});

describe('faulted run boundaries', () => {
  let app: SampleApp;
  let discovery: Discovery;

  beforeAll(async () => {
    app = createSampleApp();
    addPairModule(app);
    addSetupFailureModule(app);
    discovery = await discover(app);
  }, TIMEOUT_MS);

  afterAll(() => app.cleanup());

  it(
    'holds only the targeted site, and only inside the test body',
    async () => {
      const site = siteAt(discovery, app, 'src/pair.ts', '/first`');
      const run = await fault(app, site);
      const test = run.tests.find((entry) => entry.test.name === 'calls both dependencies');
      // The beforeEach hook reaches the same site and must get its real answer for the test to pass.
      expect(test?.problem).toBeNull();
      expect(test?.observations).toEqual([
        expect.objectContaining({ requestState: 'aborted', abortKind: 'timeout', testOutcome: 'passed' }),
      ]);
    },
    TIMEOUT_MS,
  );

  it(
    'reports a test that no longer reaches the site instead of an observation',
    async () => {
      const run = await fault(app, siteAt(discovery, app, 'src/pair.ts', '/once`'));
      expect(run.tests).toEqual([
        expect.objectContaining({ observations: [], problem: 'the test did not reach the call site under the fault' }),
      ]);
    },
    TIMEOUT_MS,
  );

  it(
    'names the error of a setup hook that kept the test body from running',
    async () => {
      const run = await fault(app, siteAt(discovery, app, 'src/setup.ts', 'await fetch('));
      expect(run.tests).toEqual([
        expect.objectContaining({
          observations: [],
          problem: 'the test failed before its body ran: the fixture could not be prepared a second time',
        }),
      ]);
    },
    TIMEOUT_MS,
  );

  it(
    'reports a test whose process dies while the request is held',
    async () => {
      const run = await fault(app, siteAt(discovery, app, 'src/pair.ts', '/slow`'));
      expect(run.tests).toEqual([
        expect.objectContaining({
          observations: [],
          problem: 'the test process ended before the test body finished',
        }),
      ]);
    },
    TIMEOUT_MS,
  );

  it(
    'does not claim the deadline was hit when the test has a shorter timeout of its own',
    async () => {
      const site = siteAt(discovery, app, 'src/pair.ts', '/second`');
      const short = site.reachedBy.filter(({ test }) => test.name === 'runs under a short timeout');
      const run = await runFaultedSite({
        targetRoot: app.dir,
        configFile: path.join(app.dir, 'vitest.config.ts'),
        vitestNode,
        pristine,
        site,
        tests: short,
        deadlineMs: DEADLINE_MS,
      });
      expect(run.tests[0]?.observations).toEqual([
        expect.objectContaining({ requestState: 'pending', testOutcome: 'failed', deadlineHit: false }),
      ]);
    },
    TIMEOUT_MS,
  );
});

describe('faulted run timeouts', () => {
  it(
    'keeps the Vitest test timeout above the fault deadline',
    async () => {
      const app = createSampleApp();
      try {
        history.clientChanges(app);
        // Discovery runs under the target's own timeout, so it must not depend on a body finishing within 100 ms.
        const discovery = await discover(app);
        const site = siteAt(discovery, app, 'src/clients/profile.ts', 'await fetch(');
        expect(site.reachedBy).toHaveLength(1);
        app.write(
          'vitest.config.ts',
          [
            "import { defineConfig } from 'vitest/config';",
            '',
            "export default defineConfig({ test: { include: ['test/**/*.test.ts'], testTimeout: 100 } });",
            '',
          ].join('\n'),
        );
        app.commit('Shorten the test timeout');
        const run = await fault(app, site);
        expect(run.tests[0]?.observations).toEqual([
          expect.objectContaining({ requestState: 'pending', deadlineHit: true }),
        ]);
      } finally {
        app.cleanup();
      }
    },
    TIMEOUT_MS,
  );
});
