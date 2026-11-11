import { afterAll, beforeAll, expect, it } from 'vitest';
import { postLedgerEntry } from '../src/clients/ledger.js';
import { startServer, type TestServer } from './helpers/server.js';

let server: TestServer;

beforeAll(async () => {
  server = await startServer({ 'POST /ledger': { status: 201, body: { ok: true } } });
});

afterAll(() => server.close());

it('posts a ledger entry', async () => {
  expect(await postLedgerEntry(server.url, { account: 'cash', amount: 12 })).toBe(201);
});
