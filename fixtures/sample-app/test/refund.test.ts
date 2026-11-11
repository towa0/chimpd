import { expect, it } from 'vitest';
import { refundableAmount } from '../src/payments/refund.js';

it('refunds the requested amount when enough remains', () => {
  expect(refundableAmount({ id: 'ch_1', amount: 100, refunded: 20 }, 30)).toBe(30);
});
