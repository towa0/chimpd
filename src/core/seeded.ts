import { createHash } from 'node:crypto';

export const MAX_SEED = 2 ** 31 - 1;

export function isValidSeed(seed: number): boolean {
  return Number.isInteger(seed) && seed >= 0 && seed <= MAX_SEED;
}

export function seedError(seed: number): string {
  return `seed must be an integer from 0 to ${MAX_SEED}, not ${seed}`;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Orders ids of equal rank by a hash of the seed and the id, so the order depends on the seed and
 * the ids alone, never on the order they arrive in. Without a seed it is plain text order.
 */
export function seededOrder(seed: number | undefined): (a: string, b: string) => number {
  if (seed === undefined) return compareText;
  if (!isValidSeed(seed)) throw new RangeError(seedError(seed));
  const keys = new Map<string, string>();
  const keyOf = (id: string): string => {
    let key = keys.get(id);
    if (key === undefined) {
      key = createHash('sha256').update(`${seed}\0${id}`).digest('hex');
      keys.set(id, key);
    }
    return key;
  };
  return (a, b) => compareText(keyOf(a), keyOf(b)) || compareText(a, b);
}
