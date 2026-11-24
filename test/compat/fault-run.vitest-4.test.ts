import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { beforeAll, expect, it } from 'vitest';
import type { ScopeRange } from '../../src/core/index.js';
import { pristineFingerprints } from '../../src/fault-recon/conflicts.js';
import type { VitestNodeModule } from '../../src/fault-recon/index.js';
import { runFaultedSite } from '../../src/fault-run/faulted.js';
import { discoverCallSites, type Discovery } from '../../src/fault-run/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(here, 'vitest-4/node_modules/vitest');
const targetRoot = resolve(here, 'vitest-4/fault-target');
const configFile = join(targetRoot, 'vitest.config.ts');

let vitestNode: VitestNodeModule;
let discovery: Discovery;
const ranges: readonly ScopeRange[] = [{ file: 'src/ping.ts', startLine: 1, endLine: 4, kind: 'changed', staticRegion: false }];

beforeAll(async () => {
  const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as { version: string };
  expect(manifest.version).toBe('4.1.12');
  vitestNode = (await import(pathToFileURL(join(packageDir, 'dist/node.js')).href)) as VitestNodeModule;
  discovery = await discoverCallSites({
    targetRoot,
    configFile,
    ranges,
    vitestNode,
  });
});

it('discovers a call site and separates the test body from hooks on vitest 4.1.12', () => {
  expect(discovery.status).toBe('completed');
  expect(discovery.conflicts).toEqual([]);
  expect(discovery.sites).toHaveLength(1);
  expect(discovery.sites[0]).toMatchObject({
    file: 'src/ping.ts',
    line: 2,
    functionName: 'ping',
    unattributedCalls: 1,
  });
  expect(discovery.sites[0]?.reachedBy.map(({ test }) => `${test.file} > ${test.name}`)).toEqual([
    'ping.spec.ts > pings from its body',
  ]);
});

it('holds the site in the test body only and reports the pending request on vitest 4.1.12', async () => {
  const site = discovery.sites[0];
  if (site === undefined) throw new Error('discovery found no call site');
  const run = await runFaultedSite({
    targetRoot,
    configFile,
    vitestNode,
    pristine: await pristineFingerprints(),
    site,
    tests: site.reachedBy,
    ranges,
    deadlineMs: 300,
  });
  expect(run.tests).toHaveLength(1);
  expect(run.tests[0]?.problem).toBeNull();
  expect(run.tests[0]?.observations).toEqual([
    expect.objectContaining({ signalAttached: false, requestState: 'pending', deadlineHit: true }),
  ]);
});
