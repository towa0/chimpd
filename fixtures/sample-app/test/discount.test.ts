import { describe, expect, it } from 'vitest';
import { applyDiscount, discountPercent } from '../src/discount.js';

describe('discount', () => {
  it('gives no discount on small orders', () => {
    expect(discountPercent(50)).toBe(0);
  });

  it('gives ten percent on large orders', () => {
    expect(discountPercent(250)).toBe(10);
  });

  it('applies the discount to the total', () => {
    expect(applyDiscount(200)).toBe(180);
  });
});
