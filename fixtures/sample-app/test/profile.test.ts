import { afterAll, beforeAll, expect, it } from 'vitest';
import { fetchProfile } from '../src/clients/profile.js';
import { startServer, type TestServer } from './helpers/server.js';

let server: TestServer;

beforeAll(async () => {
  server = await startServer({ 'GET /profiles/7': { body: { id: '7', name: 'Ada' } } });
});

afterAll(() => server.close());

it('loads a profile', async () => {
  expect(await fetchProfile(server.url, '7')).toEqual({ id: '7', name: 'Ada' });
});
