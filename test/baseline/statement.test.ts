import { describe, expect, it } from 'vitest';
import { SourceStatements } from '../../src/baseline/index.js';

const SOURCE = [
  'export function discount(total: number): number {',
  '  if (total >= 100) {',
  '    return total * 0.9;',
  '  }',
  '  return total;',
  '}',
  '',
].join('\n');

function innermost(source: string, line: number, column: number): string | undefined {
  return new SourceStatements('src/a.ts', source).enclosing(line, column)[0]?.hash;
}

describe('statement hashes', () => {
  it('lists the enclosing statements innermost first, with their lines', () => {
    const chain = new SourceStatements('src/a.ts', SOURCE).enclosing(3, 12);
    expect(chain.map(({ startLine, endLine }) => [startLine, endLine])).toEqual([
      [3, 3],
      [2, 4],
      [1, 6],
    ]);
  });

  it('keeps the hash when unrelated code moves the statement to another line', () => {
    const moved = `import { x } from './x.js';\n\nexport const y = x;\n${SOURCE}`;
    expect(innermost(moved, 6, 12)).toBe(innermost(SOURCE, 3, 12));
  });

  it('keeps the hash when only whitespace, comments or trailing commas change', () => {
    const reformatted = SOURCE.replace('    return total * 0.9;', '    return   total*0.9 ; // ten percent off');
    expect(innermost(reformatted, 3, 12)).toBe(innermost(SOURCE, 3, 12));
    const call = 'export const a = f(1, 2);\n';
    const wrapped = 'export const a = f(\n  1,\n  2,\n);\n';
    expect(innermost(wrapped, 2, 3)).toBe(innermost(call, 1, 20));
  });

  it('changes the hash when the statement itself changes', () => {
    const changed = SOURCE.replace('total * 0.9', 'total * 0.8');
    expect(innermost(changed, 3, 12)).not.toBe(innermost(SOURCE, 3, 12));
  });

  it('anchors a class property initializer on the property, not the whole class', () => {
    const source = 'export class A {\n  limit = 3 > 2;\n  other = 1;\n}\n';
    const chain = new SourceStatements('src/a.ts', source).enclosing(2, 11);
    expect(chain[0]).toMatchObject({ startLine: 2, endLine: 2 });
  });

  it('finds no statement outside the file', () => {
    expect(new SourceStatements('src/a.ts', SOURCE).enclosing(99, 1)).toEqual([]);
  });
});

describe('bruise-ignore comments', () => {
  it('reads the reason after the colon', () => {
    const source = '// bruise-ignore: equivalent mutant, the bound is checked twice\nconst a = 1;\n  //bruise-ignore:  spaced  \n';
    expect(new SourceStatements('src/a.ts', source).directives()).toEqual([
      { line: 1, reason: 'equivalent mutant, the bound is checked twice' },
      { line: 3, reason: 'spaced' },
    ]);
  });

  it('marks a comment without a reason, or with an empty one, as having none', () => {
    const source = '// bruise-ignore\n// bruise-ignore:\n// bruise-ignore:    \n// bruise-ignore because\n';
    expect(new SourceStatements('src/a.ts', source).directives().map(({ reason }) => reason)).toEqual([null, null, null, null]);
  });

  it('does not take other words or trailing comments for a directive', () => {
    const source = '// bruise-ignored: no\n// bruise-ignore-next: no\nconst a = 1; // bruise-ignore: trailing\n';
    expect(new SourceStatements('src/a.ts', source).directives()).toEqual([]);
  });
});
