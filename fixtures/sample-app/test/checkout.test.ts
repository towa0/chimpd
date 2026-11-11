import { afterAll, beforeAll, expect, it } from 'vitest';
import { checkout } from '../src/checkout.js';
import { startServer, type TestServer } from './helpers/server.js';

let server: TestServer;

beforeAll(async () => {
  server = await startServer({ 'POST /events': { status: 202, body: null } });
});

afterAll(() => server.close());

it('returns the discounted total', () => {
  expect(checkout(server.url, 200)).toEqual({ total: 180 });
});
