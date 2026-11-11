import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { removeTree, type MutantRecord } from '../../src/core/index.js';
import { boundaryRanges, computeBoundary, summarizeTestOnly, type Boundary } from '../../src/test-only-scoper/index.js';
import { repoRoot } from '../helpers/temp-repo.js';

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) removeTree(dir);
});

function project(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'chimpd-graph-'));
  temps.push(dir);
  const all = { 'tsconfig.json': JSON.stringify({ compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext' } }), ...files };
  for (const [file, content] of Object.entries(all)) {
    const target = path.join(dir, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return dir;
}

function boundary(dir: string, tests: string[], depth = 2, fileCap = 25): Boundary {
  return computeBoundary({ targetRoot: dir, changedTestFiles: tests, depth, fileCap });
}

function files(result: Boundary): [string, number][] {
  return result.files.map((entry) => [entry.file, entry.distance]);
}

describe('source boundary', () => {
  const chain = {
    'test/a.test.ts': "import { a } from '../src/a.js';\na();\n",
    'src/a.ts': "import { b } from './b.js';\nexport const a = () => b();\n",
    'src/b.ts': "import { c } from './c.js';\nexport const b = () => c();\n",
    'src/c.ts': 'export const c = () => 1;\n',
  };

  it('follows imports to the configured depth', () => {
    const dir = project(chain);
    expect(files(boundary(dir, ['test/a.test.ts'], 1))).toEqual([['src/a.ts', 1]]);
    expect(files(boundary(dir, ['test/a.test.ts'], 2))).toEqual([
      ['src/a.ts', 1],
      ['src/b.ts', 2],
    ]);
    expect(files(boundary(dir, ['test/a.test.ts'], 3))).toHaveLength(3);
  });

  it('ignores type-only imports and exports', () => {
    const dir = project({
      'test/a.test.ts': [
        "import type { T } from '../src/types.js';",
        "import { type U, type V } from '../src/more-types.js';",
        "import { used, type W } from '../src/mixed.js';",
        "export type { X } from '../src/exported-types.js';",
        'export const value: T | U | V | W = used;',
      ].join('\n'),
      'src/types.ts': 'export type T = number;\n',
      'src/more-types.ts': 'export type U = number;\nexport type V = number;\n',
      'src/mixed.ts': 'export type W = number;\nexport const used = 1;\n',
      'src/exported-types.ts': 'export type X = number;\n',
    });
    expect(files(boundary(dir, ['test/a.test.ts']))).toEqual([['src/mixed.ts', 1]]);
  });

  it('walks through barrels without counting or listing them', () => {
    const dir = project({
      'test/a.test.ts': "import { a } from '../src/index.js';\na();\n",
      'src/index.ts': "export * from './a.js';\nexport { helper } from './lib/index.js';\n",
      'src/lib/index.ts': "export { helper } from './helper.js';\n",
      'src/a.ts': 'export const a = () => 1;\n',
      'src/lib/helper.ts': 'export const helper = () => 2;\n',
    });
    expect(files(boundary(dir, ['test/a.test.ts'], 1))).toEqual([
      ['src/a.ts', 1],
      ['src/lib/helper.ts', 1],
    ]);
  });

  it('excludes modules the test mocks, in every vi.mock form, and what only they reach', () => {
    const dir = project({
      'test/a.test.ts': [
        "import { vi } from 'vitest';",
        "import { a } from '../src/a.js';",
        "import { client } from '../src/client.js';",
        "import { other } from '../src/other.js';",
        "import { late } from '../src/late.js';",
        "vi.mock('../src/client.js');",
        "vi.mock(import('../src/other.js'), () => ({ other: 1 }));",
        "vi.doMock('../src/late.js');",
        'a(client, other, late);',
      ].join('\n'),
      'src/a.ts': "import { shared } from './shared.js';\nexport const a = (...args: unknown[]) => [shared, args];\n",
      'src/client.ts': "import { transport } from './transport.js';\nimport { shared } from './shared.js';\nexport const client = [transport, shared];\n",
      'src/transport.ts': 'export const transport = 1;\n',
      'src/shared.ts': 'export const shared = 1;\n',
      'src/other.ts': 'export const other = 1;\n',
      'src/late.ts': 'export const late = 1;\n',
    });
    const result = boundary(dir, ['test/a.test.ts']);
    expect(files(result)).toEqual([
      ['src/a.ts', 1],
      ['src/shared.ts', 2],
    ]);
    expect(result.mocked).toEqual([
      { testFile: 'test/a.test.ts', file: 'src/client.ts' },
      { testFile: 'test/a.test.ts', file: 'src/late.ts' },
      { testFile: 'test/a.test.ts', file: 'src/other.ts' },
    ]);
  });

  it('keeps a module one test mocks when another changed test imports it for real', () => {
    const dir = project({
      'test/mocking.test.ts': "import { vi } from 'vitest';\nimport { client } from '../src/client.js';\nvi.mock('../src/client.js');\nclient;\n",
      'test/real.test.ts': "import { client } from '../src/client.js';\nclient;\n",
      'src/client.ts': 'export const client = 1;\n',
    });
    const result = boundary(dir, ['test/mocking.test.ts', 'test/real.test.ts']);
    expect(files(result)).toEqual([['src/client.ts', 1]]);
    expect(result.mocked).toEqual([{ testFile: 'test/mocking.test.ts', file: 'src/client.ts' }]);
  });

  it('includes only first-party TypeScript source', () => {
    const dir = project({
      'test/a.test.ts': [
        "import { a } from '../src/a.js';",
        "import '../src/ambient.js';",
        "import { other } from './other.test.js';",
        "import { describe } from 'vitest';",
        "import fs from 'node:fs';",
        "import dep from 'dep';",
        "import { missing } from '../src/missing.js';",
        'a(other, describe, fs, dep, missing);',
      ].join('\n'),
      'test/other.test.ts': "import { hidden } from '../src/hidden.js';\nexport const other = hidden;\n",
      'src/a.ts': 'export const a = (...args: unknown[]) => args;\n',
      'src/ambient.d.ts': 'export {};\n',
      'src/hidden.ts': 'export const hidden = 1;\n',
      'node_modules/dep/package.json': JSON.stringify({ name: 'dep', type: 'module', exports: './index.ts' }),
      'node_modules/dep/index.ts': 'export default 1;\n',
    });
    expect(files(boundary(dir, ['test/a.test.ts']))).toEqual([['src/a.ts', 1]]);
  });

  it('resolves tsconfig paths and honors rootDir and outDir', () => {
    const dir = project({
      'tsconfig.json': JSON.stringify({
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'Bundler',
          rootDir: 'app',
          outDir: 'app/build',
          paths: { '@lib/*': ['./app/lib/*'] },
        },
      }),
      'app/test/a.test.ts': [
        "import { helper } from '@lib/helper';",
        "import { built } from '../build/built';",
        "import { outside } from '../../tools/outside';",
        'helper(built, outside);',
      ].join('\n'),
      'app/lib/helper.ts': 'export const helper = (...args: unknown[]) => args;\n',
      'app/build/built.ts': 'export const built = 1;\n',
      'tools/outside.ts': 'export const outside = 1;\n',
    });
    const result = boundary(dir, ['app/test/a.test.ts']);
    expect(files(result)).toEqual([['app/lib/helper.ts', 1]]);
    expect(result.sourceRoot).toBe('app');
  });

  it('follows dynamic imports with a literal specifier', () => {
    const dir = project({
      'test/a.test.ts': "const { lazy } = await import('../src/lazy.js');\nlazy();\n",
      'src/lazy.ts': 'export const lazy = () => 1;\n',
    });
    expect(files(boundary(dir, ['test/a.test.ts']))).toEqual([['src/lazy.ts', 1]]);
  });

  it('survives import cycles and reports the shortest distance', () => {
    const dir = project({
      'test/a.test.ts': "import { a } from '../src/a.js';\nimport { c } from '../src/c.js';\na(c);\n",
      'src/a.ts': "import { b } from './b.js';\nexport const a = (x: unknown) => [b, x];\n",
      'src/b.ts': "import { a } from './a.js';\nimport { c } from './c.js';\nexport const b = [a, c];\n",
      'src/c.ts': 'export const c = 1;\n',
    });
    expect(files(boundary(dir, ['test/a.test.ts'], 5))).toEqual([
      ['src/a.ts', 1],
      ['src/c.ts', 1],
      ['src/b.ts', 2],
    ]);
  });

  it('truncates at the file cap, closest first and then by path, and reports the count', () => {
    const dir = project({
      'test/a.test.ts': "import '../src/z.js';\nimport '../src/m.js';\n",
      'src/z.ts': "import './deep-a.js';\nexport {};\nexport const z = 1;\n",
      'src/m.ts': "import './deep-b.js';\nexport const m = 1;\n",
      'src/deep-a.ts': 'export const deepA = 1;\n',
      'src/deep-b.ts': 'export const deepB = 1;\n',
    });
    const result = boundary(dir, ['test/a.test.ts'], 2, 3);
    expect(files(result)).toEqual([
      ['src/m.ts', 1],
      ['src/z.ts', 1],
      ['src/deep-a.ts', 2],
    ]);
    expect(result.truncated).toBe(1);
    expect(boundary(dir, ['test/a.test.ts'], 2, 10).truncated).toBe(0);
  });

  it('turns the boundary into whole-file ranges', () => {
    const dir = project(chain);
    expect(boundaryRanges(dir, boundary(dir, ['test/a.test.ts'], 1))).toEqual([
      { file: 'src/a.ts', startLine: 1, endLine: 3, kind: 'test-boundary', staticRegion: false },
    ]);
  });
});

describe('source boundary on the sample app', () => {
  const fixture = path.join(repoRoot, 'fixtures/sample-app');

  it('excludes the HTTP client the pricing test mocks', () => {
    const result = boundary(fixture, ['test/pricing.test.ts']);
    expect(files(result)).toEqual([['src/pricing.ts', 1]]);
    expect(result.mocked).toEqual([{ testFile: 'test/pricing.test.ts', file: 'src/clients/rates.ts' }]);
  });

  it('reaches deeper modules only at depth two', () => {
    expect(files(boundary(fixture, ['test/checkout.test.ts'], 1))).toEqual([
      ['src/checkout.ts', 1],
      ['test/helpers/server.ts', 1],
    ]);
    expect(files(boundary(fixture, ['test/checkout.test.ts'], 2))).toEqual([
      ['src/checkout.ts', 1],
      ['test/helpers/server.ts', 1],
      ['src/discount.ts', 2],
      ['src/telemetry.ts', 2],
    ]);
  });
});

describe('test-only summary', () => {
  let column = 0;
  function mutant(overrides: Partial<MutantRecord>): MutantRecord {
    column += 1;
    return {
      file: 'src/a.ts',
      start: { line: 1, column },
      end: { line: 1, column: column + 1 },
      mutatorName: 'BooleanLiteral',
      replacement: 'false',
      status: 'Survived',
      statusReason: null,
      coveredBy: [],
      killedBy: [],
      static: false,
      sourceHash: 'hash',
      scopeKind: 'test-boundary',
      ...overrides,
    };
  }

  const tests = [
    { id: 'test/new.test.ts#one', file: 'test/new.test.ts' },
    { id: 'test/new.test.ts#two', file: 'test/new.test.ts' },
    { id: 'test/also-new.test.ts#three', file: 'test/also-new.test.ts' },
    { id: 'test/old.test.ts#four', file: 'test/old.test.ts' },
  ];
  const changed = ['test/new.test.ts', 'test/also-new.test.ts'];

  it('keeps boundary mutants a changed test covers and counts covered against killed', () => {
    const killedByNew = mutant({ status: 'Killed', coveredBy: ['test/new.test.ts#one'], killedBy: ['test/new.test.ts#one'] });
    const killedByOld = mutant({
      status: 'Killed',
      coveredBy: ['test/new.test.ts#two', 'test/old.test.ts#four'],
      killedBy: ['test/old.test.ts#four'],
    });
    const survivor = mutant({ coveredBy: ['test/new.test.ts#one', 'test/also-new.test.ts#three'] });
    const onlyOld = mutant({ coveredBy: ['test/old.test.ts#four'] });
    const uncovered = mutant({ status: 'NoCoverage' });
    const pending = mutant({ status: 'NotTested', coveredBy: ['test/also-new.test.ts#three'] });

    const report = summarizeTestOnly([killedByNew, killedByOld, survivor, onlyOld, uncovered, pending], tests, changed);

    expect(report.mutants).toEqual([killedByNew, killedByOld, survivor, pending]);
    expect(report.droppedUncovered).toBe(2);
    expect(report.perTestFile).toEqual([
      { testFile: 'test/also-new.test.ts', covered: 2, killed: 0 },
      { testFile: 'test/new.test.ts', covered: 3, killed: 1 },
    ]);
    expect(report.total).toEqual({ covered: 4, killed: 1, notTested: 1 });
    expect(report.coveredNotKilled).toEqual([survivor]);
  });

  it('never drops diff-scoped mutants, covered by a changed test or not', () => {
    const changedLine = mutant({ scopeKind: 'changed', coveredBy: ['test/old.test.ts#four'] });
    const expanded = mutant({ scopeKind: 'enclosing-function', status: 'NoCoverage' });
    const report = summarizeTestOnly([changedLine, expanded], tests, changed);
    expect(report.mutants).toEqual([changedLine, expanded]);
    expect(report.droppedUncovered).toBe(0);
    expect(report.total).toEqual({ covered: 0, killed: 0, notTested: 0 });
  });

  it('reads the test file from the id when the test list does not have it', () => {
    const survivor = mutant({ coveredBy: ['test/new.test.ts#unlisted'] });
    expect(summarizeTestOnly([survivor], [], changed).coveredNotKilled).toEqual([survivor]);
  });
});
