import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as vitestNode from 'vitest/node';
import { scopeDiff } from '../../src/diff-scoper/index.js';
import { runFaults, type FaultRunResult } from '../../src/fault-run/index.js';
import { createSampleApp, history, type SampleApp } from '../helpers/sample-app.js';

const TIMEOUT_MS = 90_000;

const NOISY_TEST = [
  "import { expect, it } from 'vitest';",
  "import { fetchProfile } from '../src/clients/profile.js';",
  '',
  "it('talks while it runs', async () => {",
  "  process.stdout.write('TARGET-RAW-STDOUT\\n');",
  "  process.stderr.write('TARGET-RAW-STDERR\\n');",
  "  console.log('TARGET-CONSOLE-LOG');",
  "  await expect(fetchProfile('http://127.0.0.1:1', 'x')).rejects.toThrow();",
  '});',
  '',
].join('\n');

let app: SampleApp;

beforeAll(() => {
  app = createSampleApp();
  history.clientChanges(app);
  app.write('test/noisy.test.ts', NOISY_TEST);
  app.commit('Add a test that writes to the terminal');
});

afterAll(() => app.cleanup());

afterEach(() => {
  vi.restoreAllMocks();
});

async function run(onTargetOutput?: (text: string) => void): Promise<FaultRunResult> {
  const scope = await scopeDiff({ repoRoot: app.dir, mode: 'enclosing-functions' });
  return runFaults({
    targetRoot: app.dir,
    configFile: path.join(app.dir, 'vitest.config.ts'),
    ranges: scope.ranges.filter((range) => range.file === 'src/clients/profile.ts'),
    intensity: 1,
    budgetMs: 60_000,
    testDeadlineMs: 400,
    vitestNode,
    ...(onTargetOutput === undefined ? {} : { onTargetOutput }),
  });
}

function written(spy: { mock: { calls: unknown[][] } }): string {
  return spy.mock.calls.map(([chunk]) => (typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8'))).join('');
}

describe('target test output', () => {
  it(
    'does not reach this process while the target tests run',
    async () => {
      const stdout = vi.spyOn(process.stdout, 'write');
      const stderr = vi.spyOn(process.stderr, 'write');
      const result = await run();
      expect(result.status).toBe('completed');
      expect(written(stdout)).not.toContain('TARGET-');
      expect(written(stderr)).not.toContain('TARGET-');
    },
    TIMEOUT_MS,
  );

  it(
    'goes to the target output sink when one is given, and only there',
    async () => {
      const stdout = vi.spyOn(process.stdout, 'write');
      const stderr = vi.spyOn(process.stderr, 'write');
      let captured = '';
      await run((text) => {
        captured += text;
      });
      expect(captured).toContain('TARGET-RAW-STDOUT\n');
      expect(captured).toContain('TARGET-RAW-STDERR\n');
      expect(written(stdout)).not.toContain('TARGET-');
      expect(written(stderr)).not.toContain('TARGET-');
    },
    TIMEOUT_MS,
  );
});
