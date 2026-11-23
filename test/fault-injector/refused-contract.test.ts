import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { installInjection, refuseConnection, type Injection } from '../../src/fault-injector/index.js';
import { heldFetch, heldRequest, openFetch, openRequest } from '../fixtures/call-sites/selective.js';

let server: http.Server;
let url: string;
let closedUrl: string;
let hits = 0;

function listen(target: http.Server): Promise<number> {
  return new Promise((resolve) => target.listen(0, '127.0.0.1', () => resolve((target.address() as AddressInfo).port)));
}

beforeAll(async () => {
  server = http.createServer((request, response) => {
    request.resume();
    hits += 1;
    response.end('ok');
  });
  url = `http://127.0.0.1:${await listen(server)}/resource`;
  const closed = http.createServer();
  const port = await listen(closed);
  await new Promise<void>((resolve) => closed.close(() => resolve()));
  closedUrl = `http://127.0.0.1:${port}/resource`;
});

afterAll(() => {
  server.closeAllConnections();
  server.close();
});

interface Shape {
  readonly name: string;
  readonly code: unknown;
  readonly errno: unknown;
  readonly syscall: unknown;
  readonly message: string;
}

function shapeOf(error: unknown, port: string): Shape {
  const value = error as { name: string; message: string; code?: unknown; errno?: unknown; syscall?: unknown };
  return { name: value.name, code: value.code, errno: value.errno, syscall: value.syscall, message: value.message.replace(port, 'PORT') };
}

function portOf(target: string): string {
  return new URL(target).port;
}

async function fetchFailure(call: () => Promise<Response>): Promise<{ error: Error; cause: unknown }> {
  const error = await call().then(
    () => {
      throw new Error('expected the fetch to reject');
    },
    (rejection: unknown) => rejection as Error,
  );
  return { error, cause: error.cause };
}

function requestFailure(request: http.ClientRequest): Promise<unknown> {
  return new Promise((resolve) => {
    request.removeAllListeners('error');
    request.on('error', resolve);
    request.end();
  });
}

describe('connection-refused contract', () => {
  let interception: Injection;

  beforeEach(() => {
    hits = 0;
    interception = installInjection(['fetch', 'client-request'], {
      shouldInject: (metadata) => metadata !== null && /at held(Fetch|Request) /.test(metadata.stack),
      inject: refuseConnection,
    });
  });

  afterEach(() => {
    interception.dispose();
  });

  it('rejects a targeted fetch exactly as a refused connection does', async () => {
    const injected = await fetchFailure(() => heldFetch(url));
    interception.dispose();
    const real = await fetchFailure(() => fetch(closedUrl));
    expect(injected.error).toBeInstanceOf(TypeError);
    expect(injected.error.message).toBe(real.error.message);
    expect(shapeOf(injected.cause, portOf(url))).toEqual(shapeOf(real.cause, portOf(closedUrl)));
    expect(hits).toBe(0);
  });

  it('emits the error event of a refused connection on a targeted http request', async () => {
    const injected = await requestFailure(heldRequest(url));
    interception.dispose();
    const real = await requestFailure(http.request(closedUrl));
    expect(shapeOf(injected, portOf(url))).toEqual(shapeOf(real, portOf(closedUrl)));
    expect((injected as { code?: unknown }).code).toBe('ECONNREFUSED');
    expect(hits).toBe(0);
  });

  it('lets every call it does not target reach the real server', async () => {
    expect((await openFetch(url)).status).toBe(200);
    expect(await openRequest(url)).toBe(200);
    await expect(heldFetch(url)).rejects.toThrow('fetch failed');
    expect(hits).toBe(2);
  });

  it('refuses each targeted attempt, so a retry is refused again', async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) await expect(heldFetch(url)).rejects.toThrow('fetch failed');
    expect(hits).toBe(0);
  });

  it('passes everything through once disposed', async () => {
    interception.dispose();
    expect((await heldFetch(url)).status).toBe(200);
    expect(hits).toBe(1);
  });
});
