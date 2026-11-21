import { afterEach, expect, it } from 'vitest';
import { exitCodeOf, runChimpd } from '../../src/orchestrator/index.js';
import { createSampleApp, type SampleApp } from '../helpers/sample-app.js';

const RUN_TIMEOUT_MS = 600_000;

let app: SampleApp | undefined;

afterEach(() => {
  app?.cleanup();
  app = undefined;
});

function appendToDiscount(sample: SampleApp, code: string): void {
  sample.write('src/discount.ts', `${sample.read('src/discount.ts')}\n${code}`);
}

it(
  'is inconclusive, never clean, when the only change is a type guard whose mutants cannot compile',
  async () => {
    app = createSampleApp();
    appendToDiscount(
      app,
      [
        'export function formatAmount(value: string | number): string {',
        "  if (typeof value !== 'string') return value.toFixed(2);",
        '  return value.toUpperCase();',
        '}',
        '',
      ].join('\n'),
    );
    app.commit('Add a type guard');
    const result = await runChimpd({ cwd: app.dir, level: 'poke' });

    expect(result.checked.mutants).toBe(0);
    expect(result.checked.invalidMutants).toBeGreaterThan(0);
    expect(result).toMatchObject({ status: 'inconclusive', statusReason: 'no mutant in scope could run' });
    expect(exitCodeOf(result)).toBe(2);
  },
  RUN_TIMEOUT_MS,
);

it(
  'lists a changed fetch call that no test reaches as not checked',
  async () => {
    app = createSampleApp();
    appendToDiscount(app, "export async function ping(): Promise<Response> {\n  return fetch('http://127.0.0.1:9/ping');\n}\n");
    app.commit('Add a ping');
    const result = await runChimpd({ cwd: app.dir, level: 'poke' });

    const line = app.lineOf('src/discount.ts', "return fetch('http://127.0.0.1:9/ping')");
    expect(result.skipped).toContainEqual({
      source: 'fault',
      file: 'src/discount.ts',
      line,
      reason: `changed call to fetch at src/discount.ts:${line} is not reached by any test`,
    });
    expect(result.status).not.toBe('completed');
    expect(exitCodeOf(result, { strict: true })).toBe(2);
  },
  RUN_TIMEOUT_MS,
);

it(
  'does not judge mutants against a suite that already fails',
  async () => {
    app = createSampleApp();
    app.edit('src/discount.ts', 'orderTotal >= 100', 'orderTotal >= 120');
    app.edit('test/discount.test.ts', 'expect(discountPercent(50)).toBe(0)', 'expect(discountPercent(50)).toBe(1)');
    app.commit('Break the suite');
    const result = await runChimpd({ cwd: app.dir, level: 'poke' });

    expect(result.phases.find((phase) => phase.name === 'mutation')).toMatchObject({
      status: 'inconclusive',
      statusReason: "the target's own tests fail before any mutant runs: There were failed tests in the initial test run.",
    });
    expect(result.findings.filter((finding) => finding.source === 'mutation')).toEqual([]);
    expect(result.skipped).toContainEqual({
      source: 'mutation',
      file: 'src/discount.ts',
      line: null,
      reason: "not mutated: the target's own tests fail before any mutant runs",
    });
    expect(exitCodeOf(result)).toBe(2);
  },
  RUN_TIMEOUT_MS,
);

it(
  'reports a mutant in a new function that no test calls as no-coverage, base 45',
  async () => {
    app = createSampleApp();
    appendToDiscount(app, 'export function half(n: number): number {\n  return n > 0 ? n / 2 : 0;\n}\n');
    app.commit('Add an untested function');
    const result = await runChimpd({ cwd: app.dir, level: 'poke' });

    const mutation = result.findings.filter((finding) => finding.source === 'mutation');
    expect(mutation.length).toBeGreaterThan(0);
    expect(mutation.map((finding) => [finding.kind, finding.severity.base, finding.mutation?.status])).toEqual(
      mutation.map(() => ['no-coverage', 45, 'NoCoverage']),
    );
  },
  RUN_TIMEOUT_MS,
);
