import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { ping } from './src/ping.js';

let server: http.Server;
let url: string;

beforeAll(async () => {
  server = http.createServer((_request, response) => response.end());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(async () => {
  await ping(url);
});

afterAll(() => {
  server.closeAllConnections();
  server.close();
});

it('pings from its body', async () => {
  expect(await ping(url)).toBe(200);
});
