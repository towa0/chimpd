import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { recordAudit } from '../src/clients/audit.js';
import { startServer, type TestServer } from './helpers/server.js';

let server: TestServer;

beforeAll(async () => {
  server = await startServer({ 'POST /audit': { status: 201, body: { ok: true } } });
});

afterAll(async () => {
  await vi.waitFor(() => expect(server.handled).toContain('POST /audit'));
  await server.close();
});

it('records an audit entry without waiting for it', () => {
  recordAudit(server.url, 'login');
});
