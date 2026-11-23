import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { watchFetchResponse, watchHttpResponse } from '../../src/fault-injector/index.js';

let server: http.Server;
let url: string;

beforeAll(async () => {
  server = http.createServer((request, response) => {
    request.resume();
    response.writeHead(500, { 'content-type': 'text/plain' });
    response.end('Internal Server Error');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});

afterAll(() => {
  server.closeAllConnections();
  server.close();
});

function response(): Response {
  return new Response('Internal Server Error', { status: 500, statusText: 'Internal Server Error' });
}

function httpResponse(): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const request = http.get(url, resolve);
    request.on('error', reject);
  });
}

describe('watching a fetch response', () => {
  it('records a status check before the body', async () => {
    const target = response();
    const watch = watchFetchResponse(target);
    expect(target.ok).toBe(false);
    expect(await target.text()).toBe('Internal Server Error');
    expect(watch.use()).toEqual({ statusRead: true, bodyConsumed: true, bodyBeforeStatus: false });
  });

  it.each(['json', 'text', 'arrayBuffer', 'blob'] as const)('records %s before any status read as the body first', async (method) => {
    const target = response();
    const watch = watchFetchResponse(target);
    await Promise.resolve(target[method]()).catch(() => undefined);
    expect(target.status).toBe(500);
    expect(watch.use()).toEqual({ statusRead: true, bodyConsumed: true, bodyBeforeStatus: true });
  });

  it('counts reading the body stream as consuming it', () => {
    const target = response();
    const watch = watchFetchResponse(target);
    expect(target.body).not.toBeNull();
    expect(watch.use()).toEqual({ statusRead: false, bodyConsumed: true, bodyBeforeStatus: true });
  });

  it('records status and statusText reads, and nothing for a response left alone', () => {
    const untouched = watchFetchResponse(response());
    expect(untouched.use()).toEqual({ statusRead: false, bodyConsumed: false, bodyBeforeStatus: false });
    const target = response();
    const watch = watchFetchResponse(target);
    expect([target.status, target.statusText]).toEqual([500, 'Internal Server Error']);
    expect(watch.use()).toMatchObject({ statusRead: true, bodyConsumed: false });
  });

  it('keeps the response working as a Response', async () => {
    const target = response();
    watchFetchResponse(target);
    expect(target).toBeInstanceOf(Response);
    expect(target.headers.get('content-type')).toBe('text/plain;charset=UTF-8');
    expect(await target.clone().text()).toBe('Internal Server Error');
  });
});

describe('watching an http response', () => {
  it('records a statusCode check before the data is read', async () => {
    const message = await httpResponse();
    const watch = watchHttpResponse(message);
    expect(message.statusCode).toBe(500);
    let body = '';
    message.on('data', (chunk: Buffer) => (body += chunk.toString()));
    await new Promise((resolve) => message.on('end', resolve));
    expect(body).toBe('Internal Server Error');
    expect(watch.use()).toEqual({ statusRead: true, bodyConsumed: true, bodyBeforeStatus: false });
  });

  it('records data read before any status check as the body first', async () => {
    const message = await httpResponse();
    const watch = watchHttpResponse(message);
    const chunks: Buffer[] = [];
    for await (const chunk of message) chunks.push(chunk as Buffer);
    expect(message.statusCode).toBe(500);
    expect(watch.use()).toEqual({ statusRead: true, bodyConsumed: true, bodyBeforeStatus: true });
  });

  it('does not count a body discarded with resume() as consumed, also when the status is read at the end', async () => {
    const message = await httpResponse();
    const watch = watchHttpResponse(message);
    message.resume();
    await new Promise((resolve) => message.on('end', resolve));
    expect(watch.use()).toEqual({ statusRead: false, bodyConsumed: false, bodyBeforeStatus: false });
    expect(message.statusCode).toBe(500);
    expect(watch.use()).toEqual({ statusRead: true, bodyConsumed: false, bodyBeforeStatus: false });
  });

  it('counts piping the response as consuming its body', async () => {
    const message = await httpResponse();
    const watch = watchHttpResponse(message);
    const { Writable } = await import('node:stream');
    await new Promise((resolve) => message.pipe(new Writable({ write: (_chunk, _encoding, done) => done() })).on('finish', resolve));
    expect(watch.use()).toMatchObject({ bodyConsumed: true, bodyBeforeStatus: true });
  });
});
