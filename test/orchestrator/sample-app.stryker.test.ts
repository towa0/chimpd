import { afterEach, expect, it } from 'vitest';
import { exitCodeOf, runChimpd } from '../../src/orchestrator/index.js';
import { createSampleApp, history, type SampleApp } from '../helpers/sample-app.js';

const RUN_TIMEOUT_MS = 600_000;

let app: SampleApp | undefined;

afterEach(() => {
  app?.cleanup();
  app = undefined;
});

it(
  'reports the surviving boundary mutant and finds no call to fault on a pure logic change',
  async () => {
    app = createSampleApp();
    history.boundaryChange(app);
    const result = await runChimpd({ cwd: app.dir, level: 'poke', seed: 3 });

    expect(result.error).toBeNull();
    expect(result.phases.map((phase) => [phase.name, phase.status])).toEqual([
      ['mutation', 'completed'],
      ['faults', 'completed'],
    ]);
    expect(result.findings.map((finding) => [finding.source, finding.kind, finding.file, finding.mutation?.replacement])).toEqual([
      ['mutation', 'survived', 'src/discount.ts', 'orderTotal > 120'],
    ]);
    expect(result).toMatchObject({ status: 'completed', skipped: [], inconclusive: [], conflicts: [], seed: 3 });
    expect(exitCodeOf(result)).toBe(1);
    expect(app.git('status', '--porcelain')).toBe('');
  },
  RUN_TIMEOUT_MS,
);

it(
  'reports the hanging and detached calls of a client change, and the conflict as a coverage gap',
  async () => {
    app = createSampleApp();
    history.clientChanges(app);
    const result = await runChimpd({ cwd: app.dir, level: 'prod' });

    expect(result.error).toBeNull();
    const faults = result.findings.filter((finding) => finding.source === 'fault');
    expect(faults.map((finding) => [finding.kind, finding.fault?.kind, finding.file, finding.functionName])).toEqual([
      ['hang-no-timeout', 'blackhole', 'src/clients/ledger.ts', 'postLedgerEntry'],
      ['hang-no-timeout', 'blackhole', 'src/clients/profile.ts', 'fetchProfile'],
      ['error-status-ignored', 'http-500', 'src/clients/inventory.ts', 'checkStock'],
      ['error-status-mishandled', 'http-500', 'src/clients/ledger.ts', 'postLedgerEntry'],
      ['error-status-mishandled', 'http-500', 'src/clients/profile.ts', 'fetchProfile'],
      ['fire-and-forget', 'blackhole', 'src/telemetry.ts', 'trackEvent'],
    ]);
    expect(result.conflicts).toEqual([{ testFile: 'test/notifications.test.ts', patched: ['fetch'] }]);
    expect(result.status).toBe('partial');
    expect(exitCodeOf(result)).toBe(1);
    expect(exitCodeOf(result, { strict: true })).toBe(2);
    const scores = result.findings.map((finding) => finding.severity.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    expect(app.git('status', '--porcelain')).toBe('');
  },
  RUN_TIMEOUT_MS,
);
