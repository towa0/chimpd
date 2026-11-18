import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { callSiteKey, parseStack, projectFrames } from '../../src/fault-recon/call-site.js';
import { toPosix } from '../../src/core/index.js';

const root = path.resolve('/work/app');
const at = (file: string): string => toPosix(path.join(root, file));

describe('parseStack', () => {
  it('reads named, anonymous and async frames', () => {
    const stack = [
      'Error',
      `    at checkStock (${at('src/clients/inventory.ts')}:7:28)`,
      `    at ${at('test/product-page.test.ts')}:14:22`,
      `    at async productPage (${at('src/product-page.ts')}:9:24)`,
    ].join('\n');
    expect(parseStack(stack)).toEqual([
      { file: at('src/clients/inventory.ts'), line: 7, column: 28, functionName: 'checkStock' },
      { file: at('test/product-page.test.ts'), line: 14, column: 22, functionName: null },
      { file: at('src/product-page.ts'), line: 9, column: 24, functionName: 'productPage' },
    ]);
  });

  it('accepts file URLs and drops query strings', () => {
    const url = pathToFileURL(path.join(root, 'src/a.ts')).href;
    const frames = parseStack(`    at run (${url}?v=123:3:5)`);
    expect(frames).toEqual([{ file: at('src/a.ts'), line: 3, column: 5, functionName: 'run' }]);
  });

  it('skips runtime internals and frames without a file', () => {
    const stack = [
      '    at node:internal/process/task_queues:103:5',
      '    at new Promise (<anonymous>)',
      '    at Array.map (native)',
    ].join('\n');
    expect(parseStack(stack)).toEqual([]);
  });
});

describe('projectFrames', () => {
  const frame = (file: string) => ({ file: at(file), line: 1, column: 1, functionName: null });

  it('keeps source files inside the target, innermost first, with repo-relative paths', () => {
    const frames = [frame('src/clients/rates.ts'), frame('src/pricing.ts')];
    expect(projectFrames(frames, root).map((entry) => entry.file)).toEqual(['src/clients/rates.ts', 'src/pricing.ts']);
  });

  it('drops tests, dependencies, the work directory and files outside the target', () => {
    const frames = [
      frame('test/pricing.test.ts'),
      frame('src/__tests__/helper.ts'),
      frame('node_modules/undici/index.js'),
      frame('.chimpd/fault-1/setup.mjs'),
      { file: toPosix(path.resolve('/work/other/src/a.ts')), line: 1, column: 1, functionName: null },
    ];
    expect(projectFrames(frames, root)).toEqual([]);
  });

  it('keys a site by file, line and column', () => {
    expect(callSiteKey({ file: 'src/a.ts', line: 3, column: 9, functionName: 'run' })).toBe('src/a.ts:3:9');
  });
});
