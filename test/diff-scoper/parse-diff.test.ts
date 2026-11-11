import { describe, expect, it } from 'vitest';
import { parseUnifiedDiff, unquoteGitPath } from '../../src/diff-scoper/index.js';

function diffOf(...lines: string[]): string {
  return `${lines.join('\n')}\n`;
}

describe('parseUnifiedDiff', () => {
  it('reads hunks, defaulting omitted line counts to one', () => {
    const [file] = parseUnifiedDiff(
      diffOf(
        'diff --git a/src/a.ts b/src/a.ts',
        'index 1111111..2222222 100644',
        '--- a/src/a.ts',
        '+++ b/src/a.ts',
        '@@ -3 +3 @@ export function f() {',
        '-  return 1;',
        '+  return 2;',
        '@@ -10,0 +11,2 @@',
        '+const a = 1;',
        '+const b = 2;',
        '@@ -20,3 +22,0 @@',
        '-x',
        '-y',
        '-z',
      ),
    );
    expect(file).toMatchObject({ oldPath: 'src/a.ts', newPath: 'src/a.ts', binary: false });
    expect(file?.hunks).toEqual([
      { oldStart: 3, oldLines: 1, newStart: 3, newLines: 1 },
      { oldStart: 10, oldLines: 0, newStart: 11, newLines: 2 },
      { oldStart: 20, oldLines: 3, newStart: 22, newLines: 0 },
    ]);
  });

  it('does not mistake removed or added content for file headers', () => {
    const files = parseUnifiedDiff(
      diffOf(
        'diff --git a/notes.ts b/notes.ts',
        '--- a/notes.ts',
        '+++ b/notes.ts',
        '@@ -1,2 +1,2 @@',
        '--- a/fake.ts',
        '-diff --git a/x b/x',
        '+++ b/fake.ts',
        '+@@ -9 +9 @@',
        '@@ -8 +8 @@',
        '-old',
        '+new',
      ),
    );
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ oldPath: 'notes.ts', newPath: 'notes.ts' });
    expect(files[0]?.hunks).toHaveLength(2);
  });

  it('reads renames with and without content changes', () => {
    const files = parseUnifiedDiff(
      diffOf(
        'diff --git a/src/old.ts b/src/new.ts',
        'similarity index 100%',
        'rename from src/old.ts',
        'rename to src/new.ts',
        'diff --git a/src/before.ts b/src/after.ts',
        'similarity index 90%',
        'rename from src/before.ts',
        'rename to src/after.ts',
        '--- a/src/before.ts',
        '+++ b/src/after.ts',
        '@@ -2 +2 @@',
        '-a',
        '+b',
      ),
    );
    expect(files).toMatchObject([
      { oldPath: 'src/old.ts', newPath: 'src/new.ts', hunks: [] },
      { oldPath: 'src/before.ts', newPath: 'src/after.ts', hunks: [{ newStart: 2, newLines: 1 }] },
    ]);
  });

  it('reads added, deleted, and binary files', () => {
    const files = parseUnifiedDiff(
      diffOf(
        'diff --git a/src/added.ts b/src/added.ts',
        'new file mode 100644',
        '--- /dev/null',
        '+++ b/src/added.ts',
        '@@ -0,0 +1 @@',
        '+export {};',
        'diff --git a/src/gone.ts b/src/gone.ts',
        'deleted file mode 100644',
        '--- a/src/gone.ts',
        '+++ /dev/null',
        '@@ -1 +0,0 @@',
        '-export {};',
        'diff --git a/logo.png b/logo.png',
        'Binary files a/logo.png and b/logo.png differ',
      ),
    );
    expect(files).toMatchObject([
      { oldPath: null, newPath: 'src/added.ts' },
      { oldPath: 'src/gone.ts', newPath: null },
      { binary: true, hunks: [] },
    ]);
  });

  it('strips the tab git appends to paths with spaces', () => {
    const [file] = parseUnifiedDiff(
      diffOf(
        'diff --git a/src/my file.ts b/src/my file.ts',
        '--- a/src/my file.ts\t',
        '+++ b/src/my file.ts\t',
        '@@ -1 +1 @@',
        '-a',
        '+b',
      ),
    );
    expect(file).toMatchObject({ oldPath: 'src/my file.ts', newPath: 'src/my file.ts' });
  });

  it('marks submodules and symlinks by their file mode', () => {
    const files = parseUnifiedDiff(
      diffOf(
        'diff --git a/vendor/lib b/vendor/lib',
        'index 1111111..2222222 160000',
        '--- a/vendor/lib',
        '+++ b/vendor/lib',
        '@@ -1 +1 @@',
        '-Subproject commit 1111111111111111111111111111111111111111',
        '+Subproject commit 2222222222222222222222222222222222222222',
        'diff --git a/src/alias.ts b/src/alias.ts',
        'new file mode 120000',
        'index 0000000..3333333',
        '--- /dev/null',
        '+++ b/src/alias.ts',
        '@@ -0,0 +1 @@',
        '+shapes.ts',
        'diff --git a/src/plain.ts b/src/plain.ts',
        'index 4444444..5555555 100644',
        '--- a/src/plain.ts',
        '+++ b/src/plain.ts',
        '@@ -1 +1 @@',
        '-a',
        '+b',
      ),
    );
    expect(files.map((file) => file.entryType)).toEqual(['submodule', 'symlink', 'file']);
  });

  it('unquotes paths that git wraps in quotes', () => {
    expect(unquoteGitPath('src/plain.ts')).toBe('src/plain.ts');
    expect(unquoteGitPath('"src/tab\\there.ts"')).toBe('src/tab\there.ts');
    expect(unquoteGitPath('"src/say \\"hi\\".ts"')).toBe('src/say "hi".ts');
    expect(unquoteGitPath('"src/back\\\\slash.ts"')).toBe('src/back\\slash.ts');
    expect(unquoteGitPath('"src/prijs-\\303\\251.ts"')).toBe('src/prijs-é.ts');
    const [file] = parseUnifiedDiff(
      diffOf(
        'diff --git "a/src/say \\"hi\\".ts" "b/src/say \\"hi\\".ts"',
        '--- "a/src/say \\"hi\\".ts"',
        '+++ "b/src/say \\"hi\\".ts"',
        '@@ -1 +1 @@',
        '-a',
        '+b',
      ),
    );
    expect(file).toMatchObject({ oldPath: 'src/say "hi".ts', newPath: 'src/say "hi".ts' });
  });

  it('returns nothing for an empty diff', () => {
    expect(parseUnifiedDiff('')).toEqual([]);
  });
});
