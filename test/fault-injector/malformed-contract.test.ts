import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  installInjection,
  MALFORMED_BODY,
  respondWithMalformedJson,
  watchJsonParse,
  type Injection,
} from '../../src/fault-injector/index.js';
import { heldFetch, heldRequest, openFetch } from '../fixtures/call-sites/selective.js';

let server: http.Server;
let url: string;
let hits = 0;

beforeAll(async () => {
  server = http.createServer((request, response) => {
    request.resume();
    hits += 1;
    response.end('{"ok":true}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/resource`;
});

afterAll(() => {
  server.closeAllConnections();
  server.close();
});

describe('malformed-json contract', () => {
  let interception: Injection;
  let parses: number;
  let restore: () => void;

  beforeEach(() => {
    hits = 0;
    parses = 0;
    restore = watchJsonParse(MALFORMED_BODY, { onParse: () => (parses += 1) });
    interception = installInjection(['fetch', 'client-request'], {
      shouldInject: (metadata) => metadata !== null && /at held(Fetch|Request) /.test(metadata.stack),
      inject: respondWithMalformedJson,
    });
  });

  afterEach(() => {
    interception.dispose();
    restore();
  });

  it('answers a targeted fetch with 200 and a body json() cannot parse', async () => {
    const response = await heldFetch(url);
    expect([response.ok, response.status, response.headers.get('content-type')]).toEqual([true, 200, 'application/json']);
    await expect(response.json()).rejects.toThrow(SyntaxError);
    expect(hits).toBe(0);
  });

  it('sees a parse of the faulted body through text() and JSON.parse', async () => {
    const text = await (await heldFetch(url)).text();
    expect(text).toBe(MALFORMED_BODY);
    expect(() => JSON.parse(text) as unknown).toThrow(SyntaxError);
    expect(parses).toBe(1);
  });

  it('answers a targeted http request with the same body, and sees JSON.parse of it', async () => {
    const request = heldRequest(url);
    const text = await new Promise<string>((resolve) => {
      request.on('response', (message: http.IncomingMessage) => {
        let body = '';
        message.on('data', (chunk: Buffer) => (body += chunk.toString()));
        message.on('end', () => resolve(body));
      });
      request.end();
    });
    expect(() => JSON.parse(text) as unknown).toThrow(SyntaxError);
    expect(parses).toBe(1);
  });

  it('ignores every other parse, and passes untargeted calls through', async () => {
    expect(JSON.parse('{"a":1}')).toEqual({ a: 1 });
    expect(await (await openFetch(url)).json()).toEqual({ ok: true });
    expect(parses).toBe(0);
    expect(hits).toBe(1);
  });

  it('puts JSON.parse back when restored', () => {
    const watched = JSON.parse;
    restore();
    expect(JSON.parse).not.toBe(watched);
    expect(() => JSON.parse(MALFORMED_BODY) as unknown).toThrow(SyntaxError);
    expect(parses).toBe(0);
  });
});
