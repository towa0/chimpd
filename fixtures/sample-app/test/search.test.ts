import { afterAll, beforeAll, expect, it } from 'vitest';
import { searchProducts } from '../src/clients/search.js';
import { startServer, type TestServer } from './helpers/server.js';

let server: TestServer;

beforeAll(async () => {
  server = await startServer({ 'GET /search?q=chair': { body: ['chair'] } });
});

afterAll(() => server.close());

it('always returns a list of products', async () => {
  expect(Array.isArray(await searchProducts(server.url, 'chair'))).toBe(true);
});
