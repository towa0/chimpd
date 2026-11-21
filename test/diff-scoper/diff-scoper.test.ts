import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ScopeMode, ScopeRange } from '../../src/core/index.js';
import { scopeDiff, type DiffScope } from '../../src/diff-scoper/index.js';
import { createSampleApp, history } from '../helpers/sample-app.js';
import { createTempRepo, type TempRepo } from '../helpers/temp-repo.js';

const SHAPES = [
  /*  1 */ 'export const LIMIT = 10;',
  /*  2 */ 'export const DOUBLE = LIMIT * 2;',
  /*  3 */ '',
  /*  4 */ 'export function clamp(value: number): number {',
  /*  5 */ '  if (value > LIMIT) {',
  /*  6 */ '    return LIMIT;',
  /*  7 */ '  }',
  /*  8 */ '  return value;',
  /*  9 */ '}',
  /* 10 */ '',
  /* 11 */ 'export const scale = (value: number): number => {',
  /* 12 */ '  const factor = 2;',
  /* 13 */ '  return value * factor;',
  /* 14 */ '};',
  /* 15 */ '',
  /* 16 */ 'export class Counter {',
  /* 17 */ '  count = 0;',
  /* 18 */ '',
  /* 19 */ '  increment(by: number): number {',
  /* 20 */ '    const steps = [by].map((step) => {',
  /* 21 */ '      return step + 1;',
  /* 22 */ '    });',
  /* 23 */ '    this.count += steps.length;',
  /* 24 */ '    return this.count;',
  /* 25 */ '  }',
  /* 26 */ '}',
  /* 27 */ '',
  /* 28 */ "export const LABELS = ['a', 'b'].map((label) => label.toUpperCase());",
  '',
].join('\n');

const FILE = 'src/shapes.ts';

// Windows needs a privilege to create file symlinks; the tests that need one skip without it.
function canCreateFileSymlinks(): boolean {
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'chimpd-symlink-probe-'));
  try {
    fs.writeFileSync(path.join(probe, 'target'), '');
    fs.symlinkSync('target', path.join(probe, 'link'), 'file');
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(probe, { recursive: true, force: true });
  }
}

const repos: TempRepo[] = [];

afterEach(() => {
  for (const repo of repos.splice(0)) repo.cleanup();
});

function shapesRepo(): TempRepo {
  const repo = createTempRepo();
  repos.push(repo);
  repo.write(FILE, SHAPES);
  repo.write('src/shapes.test.ts', "import './shapes.js';\n");
  repo.write('README.md', 'shapes\n');
  repo.branch('origin/main', repo.commit('Add shapes'));
  return repo;
}

function scope(repo: TempRepo, mode: ScopeMode = 'changed-lines'): Promise<DiffScope> {
  return scopeDiff({ repoRoot: repo.dir, mode });
}

function range(
  startLine: number,
  endLine: number,
  kind: ScopeRange['kind'],
  staticRegion: boolean,
  file = FILE,
): ScopeRange {
  return { file, startLine, endLine, kind, staticRegion };
}

describe('merge-base resolution', () => {
  it('diffs against the merge base, not the tip of the base branch', async () => {
    const repo = createTempRepo();
    repos.push(repo);
    repo.write(FILE, SHAPES);
    const branchPoint = repo.commit('Add shapes');
    repo.write('src/main-only.ts', 'export const MAIN = 1;\n');
    repo.branch('origin/main', repo.commit('Advance main'));

    repo.switchToNew('feature', branchPoint);
    repo.edit(FILE, 'return value;', 'return value + 0;');
    const head = repo.commit('Change clamp');

    const result = await scope(repo);
    expect(result).toMatchObject({ base: 'origin/main', mergeBase: branchPoint, head, dirty: false });
    expect(result.changedSourceFiles).toEqual([FILE]);
    expect(result.ignoredFiles).toEqual([]);
    expect(result.ranges).toEqual([range(8, 8, 'changed', false)]);
  });

  it('accepts another base ref', async () => {
    const repo = shapesRepo();
    repo.edit(FILE, 'return value;', 'return value + 0;');
    const middle = repo.commit('Change clamp');
    repo.branch('reviewed', middle);
    repo.edit(FILE, 'const factor = 2;', 'const factor = 3;');
    repo.commit('Change scale');

    const result = await scopeDiff({ repoRoot: repo.dir, mode: 'changed-lines', base: 'reviewed' });
    expect(result.mergeBase).toBe(middle);
    expect(result.ranges).toEqual([range(12, 12, 'changed', false)]);
  });

  it('fails loudly when the base ref does not exist', async () => {
    const repo = shapesRepo();
    await expect(scopeDiff({ repoRoot: repo.dir, mode: 'changed-lines', base: 'origin/missing' })).rejects.toThrow(
      /merge-base origin\/missing HEAD failed/,
    );
  });

  it('includes uncommitted changes to tracked files and flags the tree as dirty', async () => {
    const repo = shapesRepo();
    repo.edit(FILE, 'return value;', 'return value + 0;');
    const result = await scope(repo);
    expect(result.dirty).toBe(true);
    expect(result.head).toBe(repo.head());
    expect(result.ranges).toEqual([range(8, 8, 'changed', false)]);
  });

  it('treats untracked files as fully changed, under the same file rules', async () => {
    const repo = shapesRepo();
    repo.write('src/fresh.ts', 'export const FRESH = 1;\n\nexport function fresh(): number {\n  return FRESH;\n}\n');
    repo.write('src/fresh.test.ts', 'export {};\n');
    repo.write('notes.txt', 'untracked\n');
    repo.write('.gitignore', 'ignored.ts\n');
    repo.write('ignored.ts', 'export const IGNORED = 1;\n');
    const result = await scope(repo, 'enclosing-functions');
    expect(result.dirty).toBe(true);
    expect(result.changedSourceFiles).toEqual(['src/fresh.ts']);
    expect(result.changedTestFiles).toEqual(['src/fresh.test.ts']);
    expect(result.ignoredFiles).toEqual([
      { file: '.gitignore', reason: 'not-typescript' },
      { file: 'notes.txt', reason: 'not-typescript' },
    ]);
    expect(result.ranges).toEqual([
      range(1, 2, 'changed', true, 'src/fresh.ts'),
      range(3, 5, 'changed', false, 'src/fresh.ts'),
      range(3, 5, 'enclosing-function', false, 'src/fresh.ts'),
      range(6, 6, 'changed', true, 'src/fresh.ts'),
    ]);
  });

  it('reports a clean tree after a commit', async () => {
    const repo = shapesRepo();
    repo.edit(FILE, 'return value;', 'return value + 0;');
    repo.commit('Change clamp');
    expect((await scope(repo)).dirty).toBe(false);
  });
});

describe('renames', () => {
  it('ignores a rename without content changes', async () => {
    const repo = shapesRepo();
    repo.rename(FILE, 'src/geometry.ts');
    repo.commit('Rename shapes');
    const result = await scope(repo);
    expect(result.ranges).toEqual([]);
    expect(result.changedSourceFiles).toEqual([]);
    expect(result.ignoredFiles).toEqual([]);
  });

  it('scopes an edited, renamed file under its new path', async () => {
    const repo = shapesRepo();
    repo.rename(FILE, 'src/lib/geometry.ts');
    repo.edit('src/lib/geometry.ts', 'return value;', 'return value + 0;');
    repo.commit('Rename and change shapes');
    const result = await scope(repo);
    expect(result.changedSourceFiles).toEqual(['src/lib/geometry.ts']);
    expect(result.ranges).toEqual([range(8, 8, 'changed', false, 'src/lib/geometry.ts')]);
  });
});

describe('whitespace-only changes', () => {
  it('ignores them by default', async () => {
    const repo = shapesRepo();
    repo.edit(FILE, '  return value;', '      return   value;');
    repo.commit('Reindent');
    const result = await scope(repo);
    expect(result.ranges).toEqual([]);
    expect(result.changedSourceFiles).toEqual([]);
  });

  it('reports them when whitespace is not ignored', async () => {
    const repo = shapesRepo();
    repo.edit(FILE, '  return value;', '      return   value;');
    repo.commit('Reindent');
    const result = await scopeDiff({ repoRoot: repo.dir, mode: 'changed-lines', ignoreWhitespace: false });
    expect(result.ranges).toEqual([range(8, 8, 'changed', false)]);
  });
});

describe('deletion-only hunks', () => {
  it.each<ScopeMode>(['changed-lines', 'enclosing-functions'])(
    'expand to the enclosing function in %s mode',
    async (mode) => {
      const repo = shapesRepo();
      repo.edit(FILE, '  if (value > LIMIT) {\n    return LIMIT;\n  }\n', '');
      repo.commit('Drop the clamp');
      const result = await scope(repo, mode);
      expect(result.ranges).toEqual([range(4, 6, 'deletion-expanded', false)]);
      expect(result.notes).toEqual([]);
    },
  );

  it('expand to the smallest function around the deletion', async () => {
    const repo = shapesRepo();
    repo.edit(FILE, '      return step + 1;\n', '');
    repo.commit('Empty the callback');
    expect((await scope(repo)).ranges).toEqual([range(20, 21, 'deletion-expanded', false)]);
  });

  it('fall on the next top-level statement, static when it is top-level code', async () => {
    const repo = shapesRepo();
    repo.edit(FILE, 'export const LIMIT = 10;\n', '');
    repo.commit('Drop LIMIT');
    expect((await scope(repo)).ranges).toEqual([range(1, 1, 'deletion-expanded', true)]);
  });

  it('fall on the next top-level statement, not static when it is a function', async () => {
    const repo = shapesRepo();
    repo.edit(FILE, 'export const DOUBLE = LIMIT * 2;\n', '');
    repo.commit('Drop DOUBLE');
    expect((await scope(repo)).ranges).toEqual([range(3, 8, 'deletion-expanded', false)]);
  });

  it('fall on the previous top-level statement at the end of the file', async () => {
    const repo = shapesRepo();
    repo.edit(FILE, "\nexport const LABELS = ['a', 'b'].map((label) => label.toUpperCase());\n", '');
    repo.commit('Drop LABELS');
    expect((await scope(repo)).ranges).toEqual([range(16, 26, 'deletion-expanded', false)]);
  });

  it('fall on a multi-line top-level statement that contains the deletion', async () => {
    const repo = shapesRepo();
    repo.write('src/table.ts', 'export const TABLE = {\n  a: 1,\n  b: 2,\n  c: 3,\n};\n');
    repo.commit('Add a table');
    repo.branch('origin/main', repo.head());
    repo.edit('src/table.ts', '  b: 2,\n', '');
    repo.commit('Drop b');
    expect((await scope(repo)).ranges).toEqual([range(1, 4, 'deletion-expanded', true, 'src/table.ts')]);
  });

  it('fall on the next class member when a member is deleted', async () => {
    const repo = shapesRepo();
    repo.edit(FILE, '  count = 0;\n\n', '');
    repo.edit(FILE, '    this.count += steps.length;\n    return this.count;\n', '    return steps.length;\n');
    repo.commit('Drop the counter field');
    expect((await scope(repo)).ranges).toEqual([
      range(17, 22, 'deletion-expanded', false),
      range(21, 21, 'changed', false),
    ]);
  });

  it('fall on the previous class member when the last member is deleted', async () => {
    const repo = shapesRepo();
    const method = SHAPES.split('\n').slice(17, 25).join('\n');
    repo.edit(FILE, `${method}\n`, '');
    repo.commit('Drop increment');
    expect((await scope(repo)).ranges).toEqual([range(17, 17, 'deletion-expanded', false)]);
  });

  it('leave a note when a class keeps no members', async () => {
    const repo = shapesRepo();
    const body = SHAPES.split('\n').slice(16, 25).join('\n');
    repo.edit(FILE, `${body}\n`, '');
    repo.commit('Empty the class');
    const result = await scope(repo);
    expect(result.ranges).toEqual([]);
    expect(result.notes).toEqual([{ file: FILE, line: 16, message: 'deleted class members, nothing to mutate' }]);
  });

  it('leave a note when no statement remains', async () => {
    const repo = shapesRepo();
    repo.write(FILE, '');
    repo.commit('Empty shapes');
    const result = await scope(repo);
    expect(result.ranges).toEqual([]);
    expect(result.notes).toEqual([{ file: FILE, line: 1, message: 'deleted top-level code, nothing to mutate' }]);
  });
});

describe('enclosing-function expansion', () => {
  async function changed(from: string, to: string, mode: ScopeMode): Promise<readonly ScopeRange[]> {
    const repo = shapesRepo();
    repo.edit(FILE, from, to);
    repo.commit('Change');
    return (await scope(repo, mode)).ranges;
  }

  it('keeps raw changed lines in changed-lines mode', async () => {
    expect(await changed('return value;', 'return value + 0;', 'changed-lines')).toEqual([
      range(8, 8, 'changed', false),
    ]);
  });

  it('adds the enclosing function declaration', async () => {
    expect(await changed('return value;', 'return value + 0;', 'enclosing-functions')).toEqual([
      range(4, 9, 'enclosing-function', false),
      range(8, 8, 'changed', false),
    ]);
  });

  it('treats a function assigned to a const as one unit', async () => {
    expect(await changed('const factor = 2;', 'const factor = 3;', 'enclosing-functions')).toEqual([
      range(11, 14, 'enclosing-function', false),
      range(12, 12, 'changed', false),
    ]);
    expect(await changed('(value: number): number => {', '(value: number, _extra = 0): number => {', 'enclosing-functions')).toEqual([
      range(11, 11, 'changed', false),
      range(11, 14, 'enclosing-function', false),
    ]);
  });

  it('picks the smallest enclosing function', async () => {
    expect(await changed('return step + 1;', 'return step + 2;', 'enclosing-functions')).toEqual([
      range(20, 22, 'enclosing-function', false),
      range(21, 21, 'changed', false),
    ]);
  });

  it('expands to a method', async () => {
    expect(await changed('return this.count;', 'return this.count + 0;', 'enclosing-functions')).toEqual([
      range(19, 25, 'enclosing-function', false),
      range(24, 24, 'changed', false),
    ]);
  });

  it('reports one function once for several hunks inside it', async () => {
    const repo = shapesRepo();
    repo.edit(FILE, 'return LIMIT;', 'return LIMIT - 0;');
    repo.edit(FILE, 'return value;', 'return value + 0;');
    repo.commit('Change clamp twice');
    expect((await scope(repo, 'enclosing-functions')).ranges).toEqual([
      range(4, 9, 'enclosing-function', false),
      range(6, 6, 'changed', false),
      range(8, 8, 'changed', false),
    ]);
  });

  it('does not expand top-level code', async () => {
    expect(await changed('LIMIT * 2;', 'LIMIT * 3;', 'enclosing-functions')).toEqual([range(2, 2, 'changed', true)]);
  });
});

describe('static-region marking', () => {
  it('marks module top-level lines as static', async () => {
    const repo = shapesRepo();
    repo.edit(FILE, 'LIMIT = 10;', 'LIMIT = 11;');
    repo.edit(FILE, 'label.toUpperCase()', 'label.toLowerCase()');
    repo.commit('Change constants');
    expect((await scope(repo)).ranges).toEqual([range(1, 1, 'changed', true), range(28, 28, 'changed', true)]);
  });

  it('does not mark class members as static', async () => {
    const repo = shapesRepo();
    repo.edit(FILE, 'count = 0;', 'count = 1;');
    repo.commit('Change the initial count');
    expect((await scope(repo, 'enclosing-functions')).ranges).toEqual([range(17, 17, 'changed', false)]);
  });

  it('splits a hunk that spans static and function lines', async () => {
    const repo = shapesRepo();
    repo.edit(
      FILE,
      'export const DOUBLE = LIMIT * 2;\n\nexport function clamp(value: number): number {',
      'export const TRIPLE = LIMIT * 3;\nexport const EXTRA = 1;\nexport function clamp(input: number, value = input): number {',
    );
    repo.commit('Change a constant and clamp');
    expect((await scope(repo)).ranges).toEqual([range(2, 3, 'changed', true), range(4, 4, 'changed', false)]);
  });

  it('marks an added top-level constant in the sample app', async () => {
    const app = createSampleApp();
    repos.push(app);
    history.staticChange(app);
    const line = app.lineOf('src/config.ts', 'BACKOFF_MS');
    expect((await scope(app, 'enclosing-functions')).ranges).toEqual([
      range(line, line, 'changed', true, 'src/config.ts'),
    ]);
  });
});

describe('unusual paths and entries', () => {
  it.each(['src/prijsberekening-é.ts', 'src/price list.ts', 'src/日本語/値.ts'])('scopes %s', async (file) => {
    const repo = shapesRepo();
    repo.write(file, 'export function price(): number {\n  return 1;\n}\n');
    repo.commit('Add a file');
    repo.branch('origin/main', repo.head());
    repo.edit(file, 'return 1;', 'return 2;');
    repo.commit('Change the price');
    const result = await scope(repo, 'enclosing-functions');
    expect(result.changedSourceFiles).toEqual([file]);
    expect(result.ranges).toEqual([
      range(1, 3, 'enclosing-function', false, file),
      range(2, 2, 'changed', false, file),
    ]);
  });

  it('scopes an untracked file with a non-ASCII name', async () => {
    const repo = shapesRepo();
    repo.write('src/prijsberekening-é.ts', 'export const PRIJS = 1;\n');
    const result = await scope(repo);
    expect(result.changedSourceFiles).toEqual(['src/prijsberekening-é.ts']);
  });

  it('skips a changed submodule with a reason', async () => {
    const repo = shapesRepo();
    const nested = repo.embedRepository('vendor/widgets.ts');
    nested.commit('index.ts', 'export const A = 1;\n');
    repo.commit('Add a submodule');
    repo.branch('origin/main', repo.head());
    nested.commit('index.ts', 'export const A = 2;\n');
    repo.commit('Update the submodule');
    const result = await scope(repo);
    expect(result.ignoredFiles).toEqual([{ file: 'vendor/widgets.ts', reason: 'submodule' }]);
    expect(result.changedSourceFiles).toEqual([]);
    expect(result.ranges).toEqual([]);
  });

  it('skips an untracked nested repository with a reason', async () => {
    const repo = shapesRepo();
    repo.embedRepository('vendor/gadgets').commit('index.ts', 'export const A = 1;\n');
    const result = await scope(repo);
    expect(result.ignoredFiles).toEqual([{ file: 'vendor/gadgets', reason: 'submodule' }]);
    expect(result.changedSourceFiles).toEqual([]);
  });

  it.skipIf(!canCreateFileSymlinks())('skips a symlinked source file with a reason', async () => {
    const repo = shapesRepo();
    fs.symlinkSync('shapes.ts', path.join(repo.dir, 'src/alias.ts'), 'file');
    repo.commit('Add a link');
    const result = await scope(repo);
    expect(result.ignoredFiles).toEqual([{ file: 'src/alias.ts', reason: 'symlink' }]);
    expect(result.changedSourceFiles).toEqual([]);
  });

  it.skipIf(!canCreateFileSymlinks())('skips an untracked symlinked source file with a reason', async () => {
    const repo = shapesRepo();
    fs.symlinkSync('shapes.ts', path.join(repo.dir, 'src/alias.ts'), 'file');
    const result = await scope(repo);
    expect(result.ignoredFiles).toEqual([{ file: 'src/alias.ts', reason: 'symlink' }]);
  });
});

describe('test and source file separation', () => {
  it('lists changed test files without scoping them', async () => {
    const repo = shapesRepo();
    repo.edit('src/shapes.test.ts', "import './shapes.js';", "import './shapes.js';\nexport {};");
    repo.write('src/__tests__/extra.ts', 'export {};\n');
    repo.write('test/more.spec.tsx', 'export {};\n');
    repo.commit('Change tests');
    const result = await scope(repo, 'enclosing-functions');
    expect(result.changedTestFiles).toEqual(['src/__tests__/extra.ts', 'src/shapes.test.ts', 'test/more.spec.tsx']);
    expect(result.changedSourceFiles).toEqual([]);
    expect(result.ranges).toEqual([]);
  });

  it('separates source and test changes made together', async () => {
    const repo = shapesRepo();
    repo.edit(FILE, 'return value;', 'return value + 0;');
    repo.edit('src/shapes.test.ts', "import './shapes.js';", "import './shapes.js';\nexport {};");
    repo.commit('Change source and test');
    const result = await scope(repo);
    expect(result.changedSourceFiles).toEqual([FILE]);
    expect(result.changedTestFiles).toEqual(['src/shapes.test.ts']);
    expect(result.ranges.map((entry) => entry.file)).toEqual([FILE]);
  });

  it('reports files it does not scope, with a reason', async () => {
    const repo = shapesRepo();
    repo.write('README.md', 'changed\n');
    repo.write('src/types.d.ts', 'export declare const X: number;\n');
    repo.write('src/script.js', 'export {};\n');
    repo.remove('src/shapes.test.ts');
    repo.commit('Change other files');
    const result = await scope(repo);
    expect(result.ignoredFiles).toEqual([
      { file: 'README.md', reason: 'not-typescript' },
      { file: 'src/script.js', reason: 'not-typescript' },
      { file: 'src/shapes.test.ts', reason: 'deleted' },
      { file: 'src/types.d.ts', reason: 'declaration-file' },
    ]);
    expect(result.changedSourceFiles).toEqual([]);
    expect(result.changedTestFiles).toEqual([]);
  });

  it('keeps tooling and config files out of scope, with a reason', async () => {
    const repo = shapesRepo();
    for (const file of [
      'vitest.config.ts',
      'vite.config.mts',
      'eslint.config.ts',
      'stryker.config.mts',
      'stryker.conf.ts',
      'packages/web/tailwind.config.ts',
      'vitest.workspace.ts',
    ]) {
      repo.write(file, 'export default {};\n');
    }
    repo.write('src/config.ts', 'export const LIMIT = 3;\n');
    repo.commit('Change tooling');
    const result = await scope(repo);
    expect(result.ignoredFiles.filter((entry) => entry.reason === 'config-file').map((entry) => entry.file)).toEqual([
      'eslint.config.ts',
      'packages/web/tailwind.config.ts',
      'stryker.conf.ts',
      'stryker.config.mts',
      'vite.config.mts',
      'vitest.config.ts',
      'vitest.workspace.ts',
    ]);
    expect(result.changedSourceFiles).toEqual(['src/config.ts']);
    expect(result.ranges.map((entry) => entry.file)).toEqual(['src/config.ts']);
  });

  it('scopes the sample app boundary change to the changed line', async () => {
    const app = createSampleApp();
    repos.push(app);
    history.boundaryChange(app);
    history.weakTest(app);
    const line = app.lineOf('src/discount.ts', 'orderTotal >= 120');
    const result = await scope(app, 'enclosing-functions');
    expect(result.changedSourceFiles).toEqual(['src/discount.ts']);
    expect(result.changedTestFiles).toEqual(['test/refund-cap.test.ts']);
    expect(result.ranges).toEqual([
      range(1, 6, 'enclosing-function', false, 'src/discount.ts'),
      range(line, line, 'changed', false, 'src/discount.ts'),
    ]);
  });
});
