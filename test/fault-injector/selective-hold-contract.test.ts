import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { installBlackHole, type BlackHoleInterception } from '../../src/fault-injector/index.js';
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

function elapsedUntil(register: (done: () => void) => void): Promise<number> {
  const startedAt = performance.now();
  return new Promise((resolve) => register(() => resolve(performance.now() - startedAt)));
}

describe('selective hold contract', () => {
  let interception: BlackHoleInterception;

  beforeEach(() => {
    hits = 0;
    interception = installBlackHole(['fetch', 'client-request'], {
      shouldHold: (metadata) => metadata !== null && /at held(Fetch|Request) /.test(metadata.stack),
    });
  });

  afterEach(() => {
    interception.dispose();
  });

  it('holds the targeted http call with its socket timeout armed while another reaches the server', async () => {
    const held = heldRequest(url, { timeout: 50 });
    const timedOutAfter = elapsedUntil((done) => held.once('timeout', done));
    held.end();

    expect(await openRequest(url)).toBe(200);
    const elapsedMs = await timedOutAfter;
    expect(elapsedMs).toBeGreaterThanOrEqual(49);
    expect(elapsedMs).toBeLessThanOrEqual(500);
    expect(hits).toBe(1);
    expect(interception.blackHole.pendingCount).toBe(1);
    held.destroy();
  });

  it('holds the targeted http call when an untargeted one used the same host first', async () => {
    expect(await openRequest(url)).toBe(200);
    expect(await openRequest(url)).toBe(200);

    const held = heldRequest(url);
    const timedOutAfter = elapsedUntil((done) => held.setTimeout(50, done));
    held.end();
    const elapsedMs = await timedOutAfter;
    expect(elapsedMs).toBeGreaterThanOrEqual(49);
    expect(elapsedMs).toBeLessThanOrEqual(500);

    expect(await openRequest(url)).toBe(200);
    expect(hits).toBe(3);
    held.destroy();
  });

  it('holds the targeted fetch while another reaches the server', async () => {
    const held = heldFetch(url, { signal: AbortSignal.timeout(50) });
    const open = await openFetch(url);
    expect(open.status).toBe(200);
    expect(await open.text()).toBe('ok');
    await expect(held).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(hits).toBe(1);
  });

  it('lets an untargeted fetch through after a targeted one was held', async () => {
    const held = heldFetch(url, { signal: AbortSignal.timeout(50) });
    await expect(held).rejects.toMatchObject({ name: 'TimeoutError' });
    expect((await openFetch(url)).status).toBe(200);
    expect((await openFetch(url)).status).toBe(200);
    expect(hits).toBe(2);
  });

  it('records only the held requests', async () => {
    const held = heldRequest(url);
    held.end();
    await openRequest(url);
    await (await openFetch(url)).text();
    const deadline = performance.now() + 2000;
    while (interception.blackHole.pendingCount < 1) {
      if (performance.now() > deadline) throw new Error('the targeted request never reached the black hole');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const { observations } = interception.blackHole;
    expect(observations).toHaveLength(1);
    expect(observations[0]?.stack).toContain('heldRequest');
    expect(observations[0]?.outcome).toBe('pending');
    held.destroy();
  });
});
