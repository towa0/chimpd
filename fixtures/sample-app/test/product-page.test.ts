import { afterAll, beforeAll, expect, it } from 'vitest';
import { productPage } from '../src/product-page.js';
import { startServer, type TestServer } from './helpers/server.js';

let server: TestServer;

beforeAll(async () => {
  server = await startServer({ 'GET /stock/A1': { body: { quantity: 4 } } });
});

afterAll(() => server.close());

it('renders a product page for the requested sku', async () => {
  const page = await productPage(server.url, 'A1');
  expect(page.sku).toBe('A1');
});
