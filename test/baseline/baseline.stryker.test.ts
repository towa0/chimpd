import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { BASELINE_FILE, parseBaseline } from '../../src/baseline/index.js';
import { runCli } from '../../src/cli/run.js';
import { createSampleApp, history, type SampleApp } from '../helpers/sample-app.js';

const RUN_TIMEOUT_MS = 900_000;

let app: SampleApp | undefined;

afterEach(() => {
  app?.cleanup();
  app = undefined;
});

async function cli(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const code = await runCli(argv, { stdout: (text) => (stdout += text), stderr: (text) => (stderr += text) });
  return { code, stdout, stderr };
}

it(
  'baselines a survivor, ignores it on the next runs even after unrelated edits, and prunes it once a test kills it',
  async () => {
    app = createSampleApp();
    history.boundaryChange(app);
    const flags = ['--level', 'poke', '--seed', '5', '--cwd', app.dir];

    const first = await cli(['run', ...flags]);
    expect(first.code).toBe(1);

    const written = await cli(['baseline', ...flags]);
    expect(written.code).toBe(0);
    const entries = parseBaseline(fs.readFileSync(path.join(app.dir, BASELINE_FILE), 'utf8'));
    expect(entries).toMatchObject([{ source: 'mutation', file: 'src/discount.ts', mutator: 'EqualityOperator', replacement: 'orderTotal > 120', reason: null }]);

    const ignored = await cli(['run', ...flags]);
    expect(ignored.stdout).toContain('1 finding ignored (baseline: 1, inline: 0)');
    expect(ignored.stdout).toContain('Result: clean, everything in scope was checked; 1 finding ignored (exit 0)');
    expect(ignored.code).toBe(0);

    app.write('src/discount.ts', `// Discounts for large orders.\n\n${app.read('src/discount.ts')}`);
    app.commit('Document the discount');
    const moved = await cli(['run', '--json', ...flags]);
    const report = JSON.parse(moved.stdout) as { exitCode: number; findings: unknown[]; ignored: { line: number; ignoredBy: string }[] };
    expect(report).toMatchObject({ exitCode: 0, findings: [], ignored: [{ line: 4, ignoredBy: 'baseline' }] });

    app.edit('test/discount.test.ts', "  it('applies the discount", "  it('gives the discount from 120 on', () => {\n    expect(discountPercent(120)).toBe(10);\n  });\n\n  it('applies the discount");
    app.commit('Pin the discount threshold');
    const stale = await cli(['run', ...flags]);
    expect(stale.stdout).toContain('Stale baseline entries (1), matching nothing in scope any more; chimpd baseline --prune removes them:');
    expect(stale.code).toBe(0);

    const pruned = await cli(['baseline', '--prune', ...flags]);
    expect(pruned.code).toBe(0);
    expect(pruned.stdout).toContain('0 entries, 0 added, 0 kept, 1 pruned');
    expect(parseBaseline(fs.readFileSync(path.join(app.dir, BASELINE_FILE), 'utf8'))).toEqual([]);
  },
  RUN_TIMEOUT_MS,
);
