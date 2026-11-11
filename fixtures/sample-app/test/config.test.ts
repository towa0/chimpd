import { expect, it } from 'vitest';
import { REQUEST_BUDGET_MS, RETRY_LIMIT, SERVICE_NAME } from '../src/config.js';

it('exposes the computed configuration', () => {
  expect(RETRY_LIMIT).toBe(3);
  expect(REQUEST_BUDGET_MS).toBe(3000);
  expect(SERVICE_NAME).toBe('sample-app');
});
