import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as vitestNode from 'vitest/node';
import type { ScopeRange } from '../../src/core/index.js';
import { scopeDiff } from '../../src/diff-scoper/index.js';
import { pristineFingerprints, type Fingerprints } from '../../src/fault-recon/conflicts.js';
import { discoverCallSites } from '../../src/fault-run/discover.js';
import { runFaultedSite, type SiteRun } from '../../src/fault-run/faulted.js';
import type { CallSite, Discovery } from '../../src/fault-run/types.js';
import { addCrashOnFaultModule, addPairModule, addSetupFailureModule } from '../helpers/fault-fixtures.js';
import { createSampleApp, history, type SampleApp } from '../helpers/sample-app.js';

const TIMEOUT_MS = 60_000;
const DEADLINE_MS = 400;

let pristine: Fingerprints;

beforeAll(async () => {
  pristine = await pristineFingerprints();
});

const scopes = new WeakMap<SampleApp, readonly ScopeRange[]>();

function rangesOf(app: SampleApp): readonly ScopeRange[] {
  const ranges = scopes.get(app);
  if (ranges === undefined) throw new Error('discover the app before faulting it');
  return ranges;
}

async function discover(app: SampleApp): Promise<Discovery> {
  const scope = await scopeDiff({ repoRoot: app.dir, mode: 'enclosing-functions' });
  scopes.set(app, scope.ranges);
  return discoverCallSites({ targetRoot: app.dir, configFile: path.join(app.dir, 'vitest.config.ts'), ranges: scope.ranges, vitestNode, pristine });
}

function siteAt(discovery: Discovery, app: SampleApp, file: string, snippet: string): CallSite {
  const line = app.lineOf(file, snippet);
  const site = discovery.sites.find((entry) => entry.file === file && entry.line === line);
  if (site === undefined) throw new Error(`no call site at ${file}:${line}`);
  return site;
}

function refuse(app: SampleApp, site: CallSite): Promise<SiteRun> {
  return runFaultedSite({
    targetRoot: app.dir,
    configFile: path.join(app.dir, 'vitest.config.ts'),
    vitestNode,
    pristine,
    site,
    tests: site.reachedBy,
    ranges: rangesOf(app),
    deadlineMs: DEADLINE_MS,
    kind: 'connection-refused',
  });
}

describe('connection-refused runs on the sample app', () => {
  let app: SampleApp;
  let discovery: Discovery;

  beforeAll(async () => {
    app = createSampleApp();
    history.clientChanges(app);
    history.faultKindChanges(app);
    discovery = await discover(app);
  }, TIMEOUT_MS);

  afterAll(() => app.cleanup());

  it.each([
    ['a fetch whose caller catches the error', 'src/clients/inventory.ts', 'await fetch(', { attempts: 1, testOutcome: 'passed', errorEscaped: false }],
    ['a fetch whose error fails the test', 'src/clients/profile.ts', 'await fetch(', { attempts: 1, testOutcome: 'failed', errorEscaped: false }],
    ['an http request whose error listener rejects', 'src/clients/ledger.ts', 'http.request(', { attempts: 1, errorReachedCaller: true, testOutcome: 'failed' }],
    ['an unawaited fetch whose rejection escapes', 'src/clients/audit.ts', 'void fetch(', { attempts: 1, testOutcome: 'passed', errorEscaped: true }],
    ['a fire-and-forget fetch that catches its error', 'src/telemetry.ts', 'void fetch(', { attempts: 1, testOutcome: 'passed', errorEscaped: false }],
    ['a search that retries before giving up', 'src/clients/search.ts', 'await fetch(', { attempts: 3, testOutcome: 'passed', errorEscaped: false }],
  ] as const)(
    'observes %s',
    async (_label, file, snippet, expected) => {
      const run = await refuse(app, siteAt(discovery, app, file, snippet));
      expect(run.tests).toHaveLength(1);
      expect(run.tests[0]?.problem).toBeNull();
      expect(run.tests[0]?.observations).toEqual([]);
      expect(run.tests[0]?.injected).toMatchObject({ kind: 'connection-refused', errorReachedCaller: true, ...expected });
    },
    TIMEOUT_MS,
  );
});

describe('connection-refused run boundaries', () => {
  let app: SampleApp;
  let discovery: Discovery;

  beforeAll(async () => {
    app = createSampleApp();
    addPairModule(app);
    addCrashOnFaultModule(app);
    addSetupFailureModule(app);
    discovery = await discover(app);
  }, TIMEOUT_MS);

  afterAll(() => app.cleanup());

  it(
    'refuses only the targeted site, and only inside the test body',
    async () => {
      const run = await refuse(app, siteAt(discovery, app, 'src/pair.ts', '/first`'));
      const test = run.tests.find((entry) => entry.test.name === 'calls both dependencies');
      // The beforeEach hook reaches the same site and must get its real answer for the test to pass.
      expect(test?.problem).toBeNull();
      expect(test?.injected).toMatchObject({ attempts: 1, testOutcome: 'passed', errorEscaped: false });
    },
    TIMEOUT_MS,
  );

  it(
    'reports a test that no longer reaches the site instead of an observation',
    async () => {
      const run = await refuse(app, siteAt(discovery, app, 'src/pair.ts', '/once`'));
      expect(run.tests).toEqual([
        expect.objectContaining({ injected: null, problem: 'the test did not reach the call site under the fault' }),
      ]);
    },
    TIMEOUT_MS,
  );

  it(
    'names the error of a setup hook that kept the test body from running',
    async () => {
      const run = await refuse(app, siteAt(discovery, app, 'src/setup.ts', 'await fetch('));
      expect(run.tests).toEqual([
        expect.objectContaining({
          injected: null,
          problem: 'the test failed before its body ran: the fixture could not be prepared a second time',
        }),
      ]);
    },
    TIMEOUT_MS,
  );

  it(
    'reports a test whose process dies under the fault',
    async () => {
      const run = await refuse(app, siteAt(discovery, app, 'src/crash.ts', 'await fetch('));
      expect(run.tests).toEqual([
        expect.objectContaining({ injected: null, problem: 'the test process ended before the test body finished' }),
      ]);
    },
    TIMEOUT_MS,
  );
});
