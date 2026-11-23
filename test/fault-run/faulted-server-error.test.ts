import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as vitestNode from 'vitest/node';
import { scopeDiff } from '../../src/diff-scoper/index.js';
import { pristineFingerprints, type Fingerprints } from '../../src/fault-recon/conflicts.js';
import { discoverCallSites } from '../../src/fault-run/discover.js';
import { runFaultedSite } from '../../src/fault-run/faulted.js';
import type { CallSite, Discovery } from '../../src/fault-run/types.js';
import { createSampleApp, history, type SampleApp } from '../helpers/sample-app.js';

const TIMEOUT_MS = 60_000;
const DEADLINE_MS = 400;

const unused = { statusRead: false, bodyConsumed: false, bodyBeforeStatus: false };
const checked = { statusRead: true, bodyConsumed: false, bodyBeforeStatus: false };
const bodyFirst = { statusRead: false, bodyConsumed: true, bodyBeforeStatus: true };

let pristine: Fingerprints;
let app: SampleApp;
let discovery: Discovery;

beforeAll(async () => {
  pristine = await pristineFingerprints();
  app = createSampleApp();
  history.clientChanges(app);
  history.faultKindChanges(app);
  const scope = await scopeDiff({ repoRoot: app.dir, mode: 'enclosing-functions' });
  discovery = await discoverCallSites({ targetRoot: app.dir, configFile: path.join(app.dir, 'vitest.config.ts'), ranges: scope.ranges, vitestNode, pristine });
}, TIMEOUT_MS);

afterAll(() => app.cleanup());

function siteAt(file: string, snippet: string): CallSite {
  const line = app.lineOf(file, snippet);
  const site = discovery.sites.find((entry) => entry.file === file && entry.line === line);
  if (site === undefined) throw new Error(`no call site at ${file}:${line}`);
  return site;
}

describe('http-500 runs on the sample app', () => {
  it.each([
    ['a fetch whose body is parsed without a status check', 'src/clients/inventory.ts', 'await fetch(', { attempts: 1, testOutcome: 'passed', response: bodyFirst }],
    ['a fetch whose status check throws into the test', 'src/clients/profile.ts', 'await fetch(', { attempts: 1, testOutcome: 'failed', response: checked }],
    ['an http request that discards the body and returns the status', 'src/clients/ledger.ts', 'http.request(', { attempts: 1, testOutcome: 'failed', response: checked }],
    ['a fire-and-forget fetch that never looks at the response', 'src/telemetry.ts', 'void fetch(', { attempts: 1, testOutcome: 'passed', response: unused }],
    ['an unawaited parse whose rejection escapes', 'src/clients/audit.ts', 'void fetch(', { attempts: 1, errorEscaped: true, response: bodyFirst }],
    ['a search that checks the status and tries again', 'src/clients/search.ts', 'await fetch(', { attempts: 3, testOutcome: 'passed', errorEscaped: false, response: checked }],
  ] as const)(
    'observes %s',
    async (_label, file, snippet, expected) => {
      const site = siteAt(file, snippet);
      const run = await runFaultedSite({
        targetRoot: app.dir,
        configFile: path.join(app.dir, 'vitest.config.ts'),
        vitestNode,
        pristine,
        site,
        tests: site.reachedBy,
        deadlineMs: DEADLINE_MS,
        kind: 'http-500',
      });
      expect(run.tests).toHaveLength(1);
      expect(run.tests[0]?.problem).toBeNull();
      expect(run.tests[0]?.injected).toMatchObject({ kind: 'http-500', ...expected });
    },
    TIMEOUT_MS,
  );
});
