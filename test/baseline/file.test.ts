import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BASELINE_FILE,
  BaselineError,
  loadBaseline,
  parseBaseline,
  serializeBaseline,
  type BaselineEntry,
} from '../../src/baseline/index.js';
import { createTempRepo, type TempRepo } from '../helpers/temp-repo.js';

const MUTATION: BaselineEntry = {
  source: 'mutation',
  file: 'src/a.ts',
  mutator: 'EqualityOperator',
  replacement: 'a > b',
  statement: '0123456789abcdef',
  reason: 'equivalent: a equals b never reaches here',
};

const FAULT: BaselineEntry = { source: 'fault', file: 'src/b.ts', function: 'load', kind: 'fire-and-forget', reason: null };

const repos: TempRepo[] = [];

afterEach(() => {
  for (const repo of repos.splice(0)) repo.cleanup();
});

function repo(): TempRepo {
  const created = createTempRepo();
  repos.push(created);
  created.write('README.md', '# a\n');
  created.commit('Base');
  return created;
}

function baselineText(value: unknown): string {
  return JSON.stringify(value);
}

describe('parseBaseline', () => {
  it('reads both kinds of entry, with the reason optional', () => {
    const withoutReason = { source: 'fault', file: 'src/b.ts', function: 'load', kind: 'fire-and-forget' };
    expect(parseBaseline(baselineText({ version: 1, entries: [MUTATION, withoutReason] }))).toEqual([MUTATION, FAULT]);
  });

  it('accepts every fault finding kind, the connection-refused one included', () => {
    const refusal = { ...FAULT, kind: 'refusal-mishandled' };
    expect(parseBaseline(baselineText({ version: 1, entries: [refusal] }))).toEqual([refusal]);
  });

  it('round-trips through serializeBaseline, sorted by file', () => {
    const text = serializeBaseline([FAULT, MUTATION]);
    expect(parseBaseline(text)).toEqual([MUTATION, FAULT]);
    expect(text.endsWith('\n')).toBe(true);
    expect(JSON.parse(text)).toMatchObject({ version: 1 });
  });

  it.each([
    ['{ not json', /bruise-baseline\.json is not valid JSON: /],
    ['[]', /bruise-baseline\.json must hold a JSON object/],
    [baselineText({ entries: [] }), /has version undefined; this version of bruise reads baseline version 1/],
    [baselineText({ version: 2, entries: [] }), /has version 2; this version of bruise reads baseline version 1/],
    [baselineText({ version: '1', entries: [] }), /has version "1"; this version of bruise reads baseline version 1/],
    [baselineText({ version: 1 }), /"entries" must be an array/],
    [baselineText({ version: 1, entries: [], extra: true }), /unknown field "extra"/],
    [baselineText({ version: 1, entries: ['x'] }), /entry 1 is not an object/],
    [baselineText({ version: 1, entries: [{ ...MUTATION, source: 'lint' }] }), /entry 1: "source" must be "mutation" or "fault"/],
    [baselineText({ version: 1, entries: [{ ...MUTATION, statement: '' }] }), /entry 1: "statement" must be a non-empty string/],
    [baselineText({ version: 1, entries: [{ ...MUTATION, line: 3 }] }), /entry 1: unknown field "line"/],
    [baselineText({ version: 1, entries: [MUTATION, { ...FAULT, kind: 'slow' }] }), /entry 2: "kind" must be one of/],
    [baselineText({ version: 1, entries: [{ ...FAULT, reason: 3 }] }), /entry 1: "reason" must be a string or null/],
  ])('rejects %s', (text, message) => {
    expect(() => parseBaseline(text)).toThrow(BaselineError);
    expect(() => parseBaseline(text)).toThrow(message);
  });
});

describe('loadBaseline', () => {
  it('finds no baseline when the file does not exist', async () => {
    const target = repo();
    expect(await loadBaseline(target.dir)).toMatchObject({ present: false, entries: [], prefix: '' });
  });

  it('reads the file at the repository root, also for a target in a subdirectory', async () => {
    const target = repo();
    target.write(BASELINE_FILE, serializeBaseline([{ ...MUTATION, file: 'packages/api/src/a.ts' }]));
    target.write('packages/api/package.json', '{}\n');
    const loaded = await loadBaseline(path.join(target.dir, 'packages/api'));
    expect(loaded).toMatchObject({ present: true, prefix: 'packages/api' });
    expect(loaded.entries).toHaveLength(1);
    expect(fs.realpathSync.native(loaded.path)).toBe(fs.realpathSync.native(path.join(target.dir, BASELINE_FILE)));
  });

  it('fails on a corrupt file instead of ignoring it', async () => {
    const target = repo();
    target.write(BASELINE_FILE, '{"version": 1, "entries": [');
    await expect(loadBaseline(target.dir)).rejects.toThrow(BaselineError);
  });

  it('fails on an unknown version instead of ignoring it', async () => {
    const target = repo();
    target.write(BASELINE_FILE, baselineText({ version: 9, entries: [] }));
    await expect(loadBaseline(target.dir)).rejects.toThrow('has version 9; this version of bruise reads baseline version 1');
  });
});
