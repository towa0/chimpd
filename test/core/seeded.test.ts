import { describe, expect, it } from 'vitest';
import { seededOrder } from '../../src/core/index.js';

const IDS = Array.from({ length: 12 }, (_, index) => `src/file-${String(index).padStart(2, '0')}.ts`);

function sortWith(seed: number | undefined, ids: readonly string[]): string[] {
  const order = seededOrder(seed);
  return ids.toSorted(order);
}

describe('seededOrder', () => {
  it('orders the same ids the same way for the same seed', () => {
    expect(sortWith(42, IDS)).toEqual(sortWith(42, IDS));
  });

  it('does not depend on the order the ids arrive in', () => {
    expect(sortWith(42, IDS.toReversed())).toEqual(sortWith(42, IDS));
  });

  it('orders the ids differently for some different seeds', () => {
    const orders = new Set([0, 1, 2, 3, 4].map((seed) => sortWith(seed, IDS).join(',')));
    expect(orders.size).toBeGreaterThan(1);
  });

  it('keeps every id exactly once', () => {
    expect(sortWith(9, IDS).toSorted()).toEqual(IDS);
  });

  it('falls back to plain text order without a seed', () => {
    expect(sortWith(undefined, IDS.toReversed())).toEqual(IDS);
  });

  it('treats seed 0 as a seed, not as no seed', () => {
    expect(sortWith(0, IDS)).not.toEqual(IDS);
  });

  it.each([-1, 1.5, 2 ** 31, Number.NaN])('rejects the seed %s', (seed) => {
    expect(() => seededOrder(seed)).toThrow(/seed must be an integer from 0 to 2147483647/);
  });
});
