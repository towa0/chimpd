import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { installInjection, respondWithServerError, type Injection, type ResponseWatch } from '../../src/fault-injector/index.js';
import { heldFetch, heldRequest, openFetch, openRequest } from '../fixtures/call-sites/selective.js';

let server: http.Server;
let url: string;
let hits = 0;

beforeAll(async () => {
  server = http.createServer((request, response) => {
    request.resume();
    hits += 1;
    response.end('ok');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/resource`;
});

afterAll(() => {
  server.closeAllConnections();
  server.close();
});

function body(message: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let text = '';
    message.on('data', (chunk: Buffer) => (text += chunk.toString()));
    message.on('end', () => resolve(text));
  });
}

describe('http-500 contract', () => {
  let interception: Injection;
  let watches: ResponseWatch[];

  beforeEach(() => {
    hits = 0;
    watches = [];
    interception = installInjection(['fetch', 'client-request'], {
      shouldInject: (metadata) => metadata !== null && /at held(Fetch|Request) /.test(metadata.stack),
      inject: respondWithServerError,
      onResponse: (_metadata, watch) => watches.push(watch),
    });
  });

  afterEach(() => {
    interception.dispose();
  });

  it('answers a targeted fetch with a 500 and a short body, and watches what the caller does with it', async () => {
    const response = await heldFetch(url);
    expect([response.ok, response.status]).toEqual([false, 500]);
    expect(await response.text()).toBe('Internal Server Error');
    expect(watches.map((watch) => watch.use())).toEqual([{ statusRead: true, bodyConsumed: true, bodyBeforeStatus: false }]);
    expect(hits).toBe(0);
  });

  it('sees a fetch body read before the status', async () => {
    const response = await heldFetch(url);
    await response.text();
    expect(watches.map((watch) => watch.use())).toEqual([{ statusRead: false, bodyConsumed: true, bodyBeforeStatus: true }]);
  });

  it('answers a targeted http request with a 500 and watches its statusCode and data', async () => {
    const request = heldRequest(url);
    const message = await new Promise<http.IncomingMessage>((resolve) => {
      request.on('response', resolve);
      request.end();
    });
    expect(message.statusCode).toBe(500);
    expect(await body(message)).toBe('Internal Server Error');
    expect(watches.map((watch) => watch.use())).toEqual([{ statusRead: true, bodyConsumed: true, bodyBeforeStatus: false }]);
    expect(hits).toBe(0);
  });

  it('lets every call it does not target reach the real server, unwatched', async () => {
    expect((await openFetch(url)).status).toBe(200);
    expect(await openRequest(url)).toBe(200);
    expect(hits).toBe(2);
    expect(watches).toEqual([]);
  });
});
