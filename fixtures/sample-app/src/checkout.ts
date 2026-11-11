import { applyDiscount } from './discount.js';
import { trackEvent } from './telemetry.js';

export interface Receipt {
  total: number;
}

export function checkout(baseUrl: string, orderTotal: number): Receipt {
  trackEvent(baseUrl, 'checkout');
  return { total: applyDiscount(orderTotal) };
}
