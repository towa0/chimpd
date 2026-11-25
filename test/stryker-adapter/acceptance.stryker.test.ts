import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Intensity, MutantRecord } from '../../src/core/index.js';
import { scopeDiff } from '../../src/diff-scoper/index.js';
import { runMutation, type MutationResult } from '../../src/stryker-adapter/index.js';
import { createSampleApp, history, type SampleApp } from '../helpers/sample-app.js';
import { repoNodeModules } from '../helpers/temp-repo.js';

const RUN_TIMEOUT_MS = 180_000;

const apps: SampleApp[] = [];

afterEach(() => {
  for (const app of apps.splice(0)) app.cleanup();
});

function sampleApp(): SampleApp {
  const app = createSampleApp();
  apps.push(app);
  return app;
}

async function mutate(app: SampleApp, intensity: Intensity, ignoreStatic = true): Promise<MutationResult> {
  const scope = await scopeDiff({ repoRoot: app.dir, mode: intensity === 1 ? 'changed-lines' : 'enclosing-functions' });
  return runMutation({ targetRoot: app.dir, ranges: scope.ranges, intensity, ignoreStatic, budgetMs: 150_000 });
}

function key(mutant: MutantRecord): string {
  return [mutant.file, mutant.start.line, mutant.start.column, mutant.end.line, mutant.end.column, mutant.mutatorName, mutant.replacement].join('|');
}

describe('stryker adapter on the sample app', () => {
  it(
    'reports the surviving boundary mutant, reproducibly, without touching the target',
    async () => {
      const app = sampleApp();
      history.boundaryChange(app);
      const line = app.lineOf('src/discount.ts', 'orderTotal >= 120');

      const first = await mutate(app, 1);

      expect(first.batches).toMatchObject([{ outcome: 'completed', files: ['src/discount.ts'], planned: 4, tested: 4 }]);
      expect(first.mutants.filter((mutant) => mutant.status === 'Survived')).toEqual([
        expect.objectContaining({
          file: 'src/discount.ts',
          start: { line, column: 7 },
          end: { line, column: 24 },
          mutatorName: 'EqualityOperator',
          replacement: 'orderTotal > 120',
          status: 'Survived',
          killedBy: [],
          static: false,
          scopeKind: 'changed',
        }),
      ]);
      expect(first.mutants.map((mutant) => [mutant.replacement, mutant.status, mutant.statusReason, mutant.killedBy])).toEqual([
        [
          'false',
          'Killed',
          null,
          [
            'test/checkout.test.ts#returns the discounted total',
            'test/discount.test.ts#discount > applies the discount to the total',
            'test/discount.test.ts#discount > gives ten percent on large orders',
          ],
        ],
        ['true', 'Killed', null, ['test/discount.test.ts#discount > gives no discount on small orders']],
        [
          'orderTotal < 120',
          'Killed',
          null,
          [
            'test/checkout.test.ts#returns the discounted total',
            'test/discount.test.ts#discount > applies the discount to the total',
            'test/discount.test.ts#discount > gives no discount on small orders',
            'test/discount.test.ts#discount > gives ten percent on large orders',
          ],
        ],
        ['orderTotal > 120', 'Survived', null, []],
      ]);
      expect(first.mutants.every((mutant) => /^[0-9a-f]{64}$/.test(mutant.sourceHash))).toBe(true);
      expect(first.notTested).toEqual({ reason: 'budget', mutants: 0, unplannedFiles: [] });
      expect(first.checker).toMatchObject({ enabled: true, typescriptVersion: '6.0.3' });
      expect(first.strykerVersion).toBe('10.1.1');
      expect(first.targetConfigIgnored).toBeNull();
      expect(first.excludedByPreset).toBe(0);

      const survivor = first.mutants.find((mutant) => mutant.status === 'Survived');
      expect(survivor?.coveredBy).toEqual([
        'test/checkout.test.ts#returns the discounted total',
        'test/discount.test.ts#discount > applies the discount to the total',
        'test/discount.test.ts#discount > gives no discount on small orders',
        'test/discount.test.ts#discount > gives ten percent on large orders',
      ]);
      expect(first.tests.map((test) => test.file)).toEqual([
        'test/checkout.test.ts',
        'test/discount.test.ts',
        'test/discount.test.ts',
        'test/discount.test.ts',
      ]);

      expect(app.git('status', '--porcelain')).toBe('');
      expect(fs.readdirSync(path.join(app.dir, '.bruise')).sort()).toEqual(['.gitignore']);
      expect(fs.existsSync(path.join(app.dir, 'reports'))).toBe(false);
      expect(fs.existsSync(path.join(app.dir, '.stryker-tmp'))).toBe(false);
      expect(fs.existsSync(path.join(repoNodeModules, 'vitest/package.json'))).toBe(true);

      const second = await mutate(app, 1);
      expect(second.mutants).toEqual(first.mutants);
      expect(second.tests).toEqual(first.tests);
    },
    RUN_TIMEOUT_MS * 2,
  );

  it(
    'lists no mutant twice for overlapping ranges and classifies each by its narrowest range',
    async () => {
      const app = sampleApp();
      history.boundaryChange(app);
      const line = app.lineOf('src/discount.ts', 'orderTotal >= 120');

      const result = await mutate(app, 2);

      const keys = result.mutants.map(key);
      expect(new Set(keys).size).toBe(keys.length);
      expect(result.mutants.length).toBeGreaterThan(4);
      expect(result.outOfScope).toBe(0);
      for (const mutant of result.mutants) {
        expect(mutant.scopeKind, key(mutant)).toBe(mutant.start.line === line ? 'changed' : 'enclosing-function');
      }
      expect(new Set(result.mutants.map((mutant) => mutant.scopeKind))).toEqual(new Set(['changed', 'enclosing-function']));
      expect(result.mutants.filter((mutant) => mutant.status === 'Survived').map((mutant) => mutant.replacement)).toContain(
        'orderTotal > 120',
      );
    },
    RUN_TIMEOUT_MS,
  );

  it(
    'ignores the target Stryker config, survives a type error, and mutates oddly named files',
    async () => {
      const app = sampleApp();
      history.boundaryChange(app);
      app.write(
        'stryker.config.json',
        JSON.stringify({
          reporters: ['html', 'json', 'clear-text'],
          incremental: true,
          thresholds: { high: 100, low: 100, break: 100 },
          mutate: ['src/**/*.ts'],
          tempDirName: 'target-tmp',
        }),
      );
      app.write('src/broken.ts', "export const broken: number = 'not a number';\n");
      app.write('src/[id] (copy) {x}.ts', 'export function weird(value: number): boolean {\n  return value > 3;\n}\n');
      app.write(
        'test/weird.test.ts',
        [
          "import { expect, it } from 'vitest';",
          "import { weird } from '../src/[id] (copy) {x}.js';",
          '',
          "it('is weird', () => {",
          '  expect(weird(5)).toBe(true);',
          '});',
          '',
        ].join('\n'),
      );
      app.commit('Add a Stryker config, a type error, and an oddly named file');
      const exitCodeBefore = process.exitCode;

      const result = await mutate(app, 1);

      expect(result.targetConfigIgnored).toBe('stryker.config.json');
      expect(result.batches).toMatchObject([{ outcome: 'completed', error: null }]);
      expect(result.batches[0]?.files).toEqual(['src/[id] (copy) {x}.ts', 'src/broken.ts', 'src/discount.ts']);
      expect(process.exitCode).toBe(exitCodeBefore);
      for (const leftover of ['reports', 'target-tmp', '.stryker-tmp', 'stryker.log']) {
        expect(fs.existsSync(path.join(app.dir, leftover)), leftover).toBe(false);
      }
      expect(fs.readdirSync(path.join(app.dir, '.bruise')).sort()).toEqual(['.gitignore']);
      expect(app.git('status', '--porcelain')).toBe('');

      expect(result.checker).toMatchObject({
        enabled: false,
        reason: "type checker disabled: target does not type-check under bruise's TypeScript 6.0.3",
      });

      const weird = result.mutants.filter((mutant) => mutant.file === 'src/[id] (copy) {x}.ts');
      expect(weird.map((mutant) => [mutant.start.line, mutant.replacement, mutant.status])).toEqual([
        [1, '{}', 'Killed'],
        [2, 'false', 'Killed'],
        [2, 'true', 'Survived'],
        [2, 'value <= 3', 'Killed'],
        [2, 'value >= 3', 'Survived'],
      ]);
      expect(result.mutants.filter((mutant) => mutant.file === 'src/broken.ts')).toEqual([]);
      expect(result.excludedByPreset).toBe(1);
      expect(result.mutants.filter((mutant) => mutant.status === 'Survived').map((mutant) => mutant.replacement)).toContain(
        'orderTotal > 120',
      );
    },
    RUN_TIMEOUT_MS,
  );

  it(
    'skips static mutants with a count when ignoreStatic is on',
    async () => {
      const app = sampleApp();
      history.staticChange(app);

      const result = await mutate(app, 3, true);

      expect(result.batches).toMatchObject([{ outcome: 'completed', files: ['src/config.ts'] }]);
      expect(result.mutants.length).toBeGreaterThan(0);
      expect(result.mutants.every((mutant) => mutant.static && mutant.status === 'Ignored')).toBe(true);
      expect(result.staticSkipped).toEqual({
        count: result.mutants.length,
        reason: 'static mutants are skipped because ignoreStatic is on',
      });
      expect(app.git('status', '--porcelain')).toBe('');
    },
    RUN_TIMEOUT_MS,
  );

  it(
    'tests static mutants when ignoreStatic is off, and runs without the type checker',
    async () => {
      const app = sampleApp();
      history.staticChange(app);
      app.remove('tsconfig.json');
      app.commit('Remove the tsconfig');

      const result = await mutate(app, 3, false);

      expect(result.checker).toMatchObject({ enabled: false, reason: 'type checker disabled: tsconfig.json not found' });
      expect(result.batches).toMatchObject([{ outcome: 'completed' }]);
      expect(result.staticSkipped.count).toBe(0);
      expect(result.mutants.every((mutant) => mutant.static)).toBe(true);
      expect(result.mutants.map((mutant) => mutant.status)).toContain('Survived');
      expect(result.mutants.map((mutant) => mutant.status)).not.toContain('Ignored');
    },
    RUN_TIMEOUT_MS,
  );
});
