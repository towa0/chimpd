import { afterEach, describe, expect, it } from 'vitest';
import type { ScopeRange } from '../../src/core/index.js';
import { findOutgoingCalls } from '../../src/diff-scoper/index.js';
import { createTempRepo, type TempRepo } from '../helpers/temp-repo.js';

const repos: TempRepo[] = [];

afterEach(() => {
  for (const repo of repos.splice(0)) repo.cleanup();
});

function repoWith(file: string, source: string): TempRepo {
  const repo = createTempRepo();
  repos.push(repo);
  repo.write(file, source);
  return repo;
}

function range(file: string, startLine: number, endLine: number): ScopeRange {
  return { file, startLine, endLine, kind: 'changed', staticRegion: false };
}

describe('findOutgoingCalls', () => {
  it('finds fetch, global fetch, and the http and https entry points under every import style', () => {
    const source = [
      "import http from 'node:http';",
      "import * as secure from 'https';",
      "import { get as httpGet, request } from 'http';",
      "const legacy = require('node:https');",
      '',
      'export async function all(): Promise<void> {',
      "  await fetch('http://a');",
      "  await globalThis.fetch('http://b');",
      "  http.request('http://c');",
      "  http.get('http://d');",
      "  secure.request('https://e');",
      "  httpGet('http://f');",
      "  request('http://g');",
      "  legacy.get('https://h');",
      '}',
      '',
    ].join('\n');
    const repo = repoWith('src/a.ts', source);
    expect(findOutgoingCalls(repo.dir, [range('src/a.ts', 1, 16)])).toEqual([
      { file: 'src/a.ts', line: 7, endLine: 7, callee: 'fetch' },
      { file: 'src/a.ts', line: 8, endLine: 8, callee: 'fetch' },
      { file: 'src/a.ts', line: 9, endLine: 9, callee: 'http.request' },
      { file: 'src/a.ts', line: 10, endLine: 10, callee: 'http.get' },
      { file: 'src/a.ts', line: 11, endLine: 11, callee: 'https.request' },
      { file: 'src/a.ts', line: 12, endLine: 12, callee: 'http.get' },
      { file: 'src/a.ts', line: 13, endLine: 13, callee: 'http.request' },
      { file: 'src/a.ts', line: 14, endLine: 14, callee: 'https.get' },
    ]);
  });

  it('keeps only calls whose callee sits on a line in scope, and spans multi-line calls', () => {
    const source = [
      "export const first = () => fetch('http://a');",
      'export const second = () =>',
      '  fetch(',
      "    'http://b',",
      '  );',
      '',
    ].join('\n');
    const repo = repoWith('src/a.ts', source);
    expect(findOutgoingCalls(repo.dir, [range('src/a.ts', 3, 3)])).toEqual([
      { file: 'src/a.ts', line: 3, endLine: 5, callee: 'fetch' },
    ]);
  });

  it('ignores methods of the same name on other objects, and members of unrelated modules', () => {
    const source = [
      "import { request } from 'undici';",
      'declare const client: { get(url: string): void; fetch(url: string): void };',
      "client.get('http://a');",
      "client.fetch('http://b');",
      "request('http://c');",
      '',
    ].join('\n');
    const repo = repoWith('src/a.ts', source);
    expect(findOutgoingCalls(repo.dir, [range('src/a.ts', 1, 6)])).toEqual([]);
  });

  it('reads tsx files', () => {
    const repo = repoWith('src/view.tsx', "export const View = () => <button onClick={() => fetch('/x')} />;\n");
    expect(findOutgoingCalls(repo.dir, [range('src/view.tsx', 1, 1)])).toEqual([
      { file: 'src/view.tsx', line: 1, endLine: 1, callee: 'fetch' },
    ]);
  });
});
