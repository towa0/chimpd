import { describe, expect, it } from 'vitest';
import { PRESETS, priorOf, type ScopeRange } from '../../src/core/index.js';
import { scopeOf, selectCallSites } from '../../src/fault-run/select.js';
import type { CallSite, ReachingTest } from '../../src/fault-run/types.js';

function reaching(name: string, durationMs: number, file = 'test/a.test.ts'): ReachingTest {
  return { test: { id: `${file}#${name}`, file, name }, durationMs, calls: 1 };
}

function site(file: string, functionName: string, overrides: Partial<CallSite> = {}): CallSite {
  return {
    key: `${file}:3:10`,
    file,
    line: 3,
    column: 10,
    functionName,
    path: 'fetch',
    frames: [{ file, line: 3, column: 10, functionName }],
    scopeKind: 'changed',
    prior: priorOf(file, functionName),
    reachedBy: [reaching('reaches it', 5)],
    unattributedCalls: 0,
    ...overrides,
  };
}

const keys = (sites: readonly { site: CallSite }[]): string[] => sites.map((entry) => entry.site.file);

describe('selectCallSites', () => {
  it('orders sites by the severity prior, then by key', () => {
    const selection = selectCallSites(
      [
        site('src/telemetry.ts', 'trackEvent'),
        site('src/clients/profile.ts', 'fetchProfile'),
        site('src/orders/repository.ts', 'saveOrder'),
        site('src/payments/refund.ts', 'refundCharge'),
        site('src/billing/invoice-repo.ts', 'insertInvoice'),
      ],
      PRESETS[3],
    );
    expect(keys(selection.planned)).toEqual([
      'src/billing/invoice-repo.ts',
      'src/payments/refund.ts',
      'src/orders/repository.ts',
      'src/clients/profile.ts',
      'src/telemetry.ts',
    ]);
  });

  it.each([
    [1, 3],
    [2, 8],
    [3, 20],
  ] as const)('caps the faulted sites of preset %i at %i and skips the rest as over-cap', (intensity, cap) => {
    const sites = Array.from({ length: 25 }, (_, index) => site(`src/client-${String(index).padStart(2, '0')}.ts`, 'call'));
    const selection = selectCallSites(sites, PRESETS[intensity]);
    expect(selection.planned).toHaveLength(cap);
    expect(selection.skipped).toHaveLength(25 - cap);
    expect(new Set(selection.skipped.map((entry) => entry.reason))).toEqual(new Set(['over-cap']));
    expect(keys(selection.planned)).toEqual(sites.slice(0, cap).map((entry) => entry.file));
  });

  it('drops the least severe sites when the cap bites', () => {
    const selection = selectCallSites(
      [
        site('src/a.ts', 'call'),
        site('src/b.ts', 'call'),
        site('src/c.ts', 'call'),
        site('src/payments/charge.ts', 'chargeCard'),
      ],
      PRESETS[1],
    );
    expect(keys(selection.planned)).toEqual(['src/payments/charge.ts', 'src/a.ts', 'src/b.ts']);
    expect(keys(selection.skipped)).toEqual(['src/c.ts']);
  });

  it.each([
    [1, ['fast']],
    [2, ['fast', 'medium a']],
    [3, ['fast', 'medium a', 'medium b']],
  ] as const)('picks the cheapest tests for preset %i, breaking ties by file and name', (intensity, expected) => {
    const reachedBy = [
      reaching('slow', 90),
      reaching('medium b', 20),
      reaching('fast', 2, 'test/z.test.ts'),
      reaching('medium a', 20),
    ];
    const selection = selectCallSites([site('src/a.ts', 'call', { reachedBy })], PRESETS[intensity]);
    expect(selection.planned[0]?.tests.map(({ test }) => test.name)).toEqual(expected);
  });

  it('sets aside a site whose calls all happened outside a test body, without using the cap', () => {
    const selection = selectCallSites(
      [
        site('src/warmup.ts', 'warm', { reachedBy: [], unattributedCalls: 2 }),
        site('src/a.ts', 'call'),
        site('src/b.ts', 'call'),
        site('src/c.ts', 'call'),
      ],
      PRESETS[1],
    );
    expect(selection.unattributable.map((entry) => entry.file)).toEqual(['src/warmup.ts']);
    expect(selection.planned).toHaveLength(3);
    expect(selection.skipped).toEqual([]);
  });

  it('skips a site that no passing test reaches', () => {
    const orphan = site('src/payments/charge.ts', 'chargeCard', { reachedBy: [] });
    const selection = selectCallSites([orphan, site('src/a.ts', 'call')], PRESETS[1]);
    expect(selection.skipped).toEqual([{ site: orphan, reason: 'no-passing-test' }]);
    expect(keys(selection.planned)).toEqual(['src/a.ts']);
  });

  it('faults a site through its tests even when hooks also call it', () => {
    const selection = selectCallSites([site('src/a.ts', 'call', { unattributedCalls: 4 })], PRESETS[1]);
    expect(keys(selection.planned)).toEqual(['src/a.ts']);
    expect(selection.unattributable).toEqual([]);
  });
});

describe('scopeOf', () => {
  const ranges: ScopeRange[] = [
    { file: 'src/a.ts', startLine: 3, endLine: 3, kind: 'changed', staticRegion: false },
    { file: 'src/caller.ts', startLine: 1, endLine: 20, kind: 'enclosing-function', staticRegion: false },
  ];

  it('accepts a site whose innermost frame lies in a scope range', () => {
    const frames = [{ file: 'src/a.ts', line: 3, column: 10, functionName: 'call' }];
    expect(scopeOf(frames, ranges)).toEqual(ranges[0]);
  });

  it('rejects a site that only a caller frame puts in scope', () => {
    const frames = [
      { file: 'src/a.ts', line: 9, column: 10, functionName: 'call' },
      { file: 'src/caller.ts', line: 5, column: 3, functionName: 'caller' },
    ];
    expect(scopeOf(frames, ranges)).toBeNull();
  });

  it('rejects a call with no project frame', () => {
    expect(scopeOf([], ranges)).toBeNull();
  });
});
