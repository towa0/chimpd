import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as vitestNode from 'vitest/node';
import type { FaultKind } from '../../src/core/index.js';
import { scopeDiff } from '../../src/diff-scoper/index.js';
import { pristineFingerprints, type Fingerprints } from '../../src/fault-recon/conflicts.js';
import { combineSite } from '../../src/fault-run/combine.js';
import { discoverCallSites } from '../../src/fault-run/discover.js';
import { runFaultedSite } from '../../src/fault-run/faulted.js';
import type { CallSite, CallSiteResult, Discovery } from '../../src/fault-run/types.js';
import { addEvidenceModule } from '../helpers/fault-fixtures.js';
import { createSampleApp, type SampleApp } from '../helpers/sample-app.js';

const TIMEOUT_MS = 60_000;
const DEADLINE_MS = 400;
const ASSERTION = 'AssertionError: expected 1 to be 1.5 // Object.is equality';

let pristine: Fingerprints;
let app: SampleApp;
let discovery: Discovery;
let ranges: Awaited<ReturnType<typeof scopeDiff>>['ranges'];

beforeAll(async () => {
  pristine = await pristineFingerprints();
  app = createSampleApp();
  addEvidenceModule(app);
  const scope = await scopeDiff({ repoRoot: app.dir, mode: 'enclosing-functions' });
  ranges = scope.ranges;
  discovery = await discoverCallSites({ targetRoot: app.dir, configFile: path.join(app.dir, 'vitest.config.ts'), ranges, vitestNode, pristine });
}, TIMEOUT_MS);

afterAll(() => app.cleanup());

function siteOf(functionName: string): CallSite {
  const site = discovery.sites.find((entry) => entry.file === 'src/evidence.ts' && entry.functionName === functionName);
  if (site === undefined) throw new Error(`no call site in ${functionName}`);
  return site;
}

async function fault(functionName: string, kind: FaultKind): Promise<CallSiteResult> {
  const site = siteOf(functionName);
  const run = await runFaultedSite({
    targetRoot: app.dir,
    configFile: path.join(app.dir, 'vitest.config.ts'),
    vitestNode,
    pristine,
    site,
    tests: site.reachedBy,
    ranges,
    deadlineMs: DEADLINE_MS,
    kind,
  });
  return combineSite(site, run.tests, kind);
}

function raisedAt(snippet: string): string {
  return `src/evidence.ts:${app.lineOf('src/evidence.ts', snippet)}`;
}

describe('fault verdicts follow what the code did with the fault, not whether the happy-path test passed', () => {
  it(
    'counts a 500 the code checked and turned into its own error as handled',
    async () => {
      const result = await fault('checkedRate', 'http-500');
      expect(result).toMatchObject({
        verdict: 'status-checked',
        findingKind: null,
        reason: `the code checked the status of the 500 response; the code raised its own error at ${raisedAt('throw new Error(`rate request')}: Error: rate request failed with 500`,
      });
    },
    TIMEOUT_MS,
  );

  it(
    'counts a refusal caught with a fallback value as handled, naming the assertion the test failed on',
    async () => {
      const result = await fault('fallbackRate', 'connection-refused');
      expect(result).toMatchObject({
        verdict: 'refusal-handled',
        findingKind: null,
        reason: `the refused connection did not escape; the test failed on its own check: ${ASSERTION}`,
      });
    },
    TIMEOUT_MS,
  );

  it.each([['checkedRate'], ['escapingRate'], ['wrappedRate']])(
    'keeps a refusal that escapes %s a finding',
    async (functionName) => {
      const result = await fault(functionName, 'connection-refused');
      expect(result).toMatchObject({
        verdict: 'refusal-mishandled',
        findingKind: 'refusal-mishandled',
        reason: "the refused connection's error escaped the code and failed the test: TypeError: fetch failed",
      });
    },
    TIMEOUT_MS,
  );

  it(
    'keeps a parse error the code never caught a finding',
    async () => {
      const result = await fault('escapingRate', 'malformed-json');
      expect(result.verdict).toBe('parse-mishandled');
      expect(result.findingKind).toBe('malformed-json-mishandled');
      expect(result.reason).toMatch(/^the JSON parse error escaped the code and failed the test: SyntaxError: /);
    },
    TIMEOUT_MS,
  );

  it(
    'counts a parse error caught with a fallback value as handled',
    async () => {
      const result = await fault('fallbackRate', 'malformed-json');
      expect(result).toMatchObject({
        verdict: 'parse-handled',
        findingKind: null,
        reason: `the JSON parse error did not escape; the test failed on its own check: ${ASSERTION}`,
      });
    },
    TIMEOUT_MS,
  );

  it(
    'counts a parse error caught and raised again as the code\'s own error as handled',
    async () => {
      const result = await fault('wrappedRate', 'malformed-json');
      expect(result).toMatchObject({
        verdict: 'parse-handled',
        findingKind: null,
        reason: `the JSON parse error did not escape; the code raised its own error at ${raisedAt("throw new Error('the rate payload")}: Error: the rate payload could not be read`,
      });
    },
    TIMEOUT_MS,
  );

  it.each([['fallbackRate'], ['escapingRate'], ['wrappedRate']])(
    'keeps a 500 body %s reads before the status a finding',
    async (functionName) => {
      const result = await fault(functionName, 'http-500');
      expect(result).toMatchObject({ verdict: 'status-ignored', findingKind: 'error-status-ignored' });
    },
    TIMEOUT_MS,
  );
});
