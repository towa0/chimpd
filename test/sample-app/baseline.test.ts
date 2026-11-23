import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import * as vitestNode from 'vitest/node';
import { runVitest } from '../../src/fault-recon/index.js';
import { createSampleApp, history, type SampleApp } from '../helpers/sample-app.js';

let app: SampleApp | undefined;

afterEach(() => {
  // The inner run reports through process.exitCode; it must not leak into this run.
  process.exitCode = 0;
  app?.cleanup();
  app = undefined;
});

interface Outcome {
  readonly files: number;
  readonly failed: number;
  readonly unhandled: number;
}

async function runSuite(dir: string): Promise<Outcome> {
  const vitest = await runVitest(vitestNode, {
    root: dir,
    configFile: path.join(dir, 'vitest.config.ts'),
    options: { reporters: [{}] },
  });
  try {
    return {
      files: vitest.state.getFiles().length,
      failed: vitest.state.getCountOfFailedTests(),
      unhandled: vitest.state.getUnhandledErrors().length,
    };
  } finally {
    await vitest.close();
  }
}

it('passes its own suite at the base commit', async () => {
  app = createSampleApp();
  expect(await runSuite(app.dir)).toEqual({ files: 11, failed: 0, unhandled: 0 });
});

it('still passes after every scripted commit', async () => {
  app = createSampleApp();
  history.boundaryChange(app);
  history.staticChange(app);
  history.weakTest(app);
  history.faultKindChanges(app);
  expect(await runSuite(app.dir)).toEqual({ files: 12, failed: 0, unhandled: 0 });
});
