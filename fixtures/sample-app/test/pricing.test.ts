import { expect, it, vi } from 'vitest';
import { priceIn } from '../src/pricing.js';

vi.mock('../src/clients/rates.js', () => ({
  fetchExchangeRate: vi.fn(() => Promise.resolve(1.5)),
}));

it('converts an amount with the exchange rate', async () => {
  expect(await priceIn('http://rates.invalid', 10, 'EUR')).toBe(15);
});
