import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  installBlackHole,
  isSentinel,
  type BlackHoleInterception,
  type RequestObservation,
} from '../../src/fault-injector/index.js';
import { viaFetch, viaHttpGet, viaHttpRequest, viaNamedGet } from '../fixtures/call-sites/calls.js';

const HOST = 'http://blackhole.chimpd.invalid';
const earlyRequest = new Request(`${HOST}/early`, { signal: new AbortController().signal });
const RequestBeforeInstall = Request;
const prototypeBeforeInstall = Request.prototype;
const staticsBeforeInstall = Object.getOwnPropertyDescriptors(Request);

function constructWithoutNew(constructor: unknown): unknown {
  try {
    (constructor as (input: string) => unknown)(`${HOST}/no-new`);
  } catch (error) {
    return error;
  }
  throw new Error('expected a call without new to throw');
}

const errorBeforeInstall = constructWithoutNew(Request);

const callsFile = fileURLToPath(new URL('../fixtures/call-sites/calls.ts', import.meta.url));

let nextId = 0;
function uniqueUrl(base = HOST): string {
  nextId += 1;
  return `${base}/resource?id=${nextId}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function lineOf(snippet: string): number {
  const lines = readFileSync(callsFile, 'utf8').split('\n');
  const index = lines.findIndex((line) => line.includes(snippet));
  if (index === -1) throw new Error(`"${snippet}" not found in ${callsFile}`);
  return index + 1;
}

describe('observability contract', () => {
  let interception: BlackHoleInterception;

  beforeEach(() => {
    interception = installBlackHole(['fetch', 'client-request']);
  });

  afterEach(() => {
    interception.dispose();
  });

  async function observed(
    url: string,
    predicate: (observation: RequestObservation) => boolean = () => true,
  ): Promise<RequestObservation> {
    const deadline = performance.now() + 2000;
    for (;;) {
      const match = interception.blackHole.observations.find((entry) => entry.url === url);
      if (match && predicate(match)) return match;
      if (performance.now() > deadline) {
        throw new Error(`no matching observation for ${url}: ${JSON.stringify(match)}`);
      }
      await sleep(5);
    }
  }

  function quietFetch(input: string | Request, init?: RequestInit): void {
    viaFetch(input, init).catch(() => undefined);
  }

  describe('signal observability', () => {
    it('reports a signal passed in fetch init', async () => {
      const url = uniqueUrl();
      quietFetch(url, { signal: new AbortController().signal });
      expect(await observed(url)).toMatchObject({ path: 'fetch', signalAttached: true });
    });

    it('reports no signal for fetch without one', async () => {
      const url = uniqueUrl();
      quietFetch(url);
      expect(await observed(url)).toMatchObject({ path: 'fetch', signalAttached: false });
    });

    it('reports whether a Request passed to fetch was built with a signal', async () => {
      const withSignal = uniqueUrl();
      const withoutSignal = uniqueUrl();
      quietFetch(new Request(withSignal, { signal: new AbortController().signal }));
      quietFetch(new Request(withoutSignal));
      expect(await observed(withSignal)).toMatchObject({ path: 'fetch', signalAttached: true });
      expect(await observed(withoutSignal)).toMatchObject({ path: 'fetch', signalAttached: false });
    });

    it('inherits the signal of a Request copied with new Request(existing)', async () => {
      const copiedWith = uniqueUrl();
      const copiedWithout = uniqueUrl();
      const detached = uniqueUrl();
      const replaced = uniqueUrl();
      const signal = new AbortController().signal;
      quietFetch(new Request(new Request(copiedWith, { signal })));
      quietFetch(new Request(new Request(copiedWithout)));
      quietFetch(new Request(new Request(detached, { signal }), { signal: null }));
      quietFetch(new Request(new Request(replaced), { signal }));
      expect(await observed(copiedWith)).toMatchObject({ signalAttached: true });
      expect(await observed(copiedWithout)).toMatchObject({ signalAttached: false });
      expect(await observed(detached)).toMatchObject({ signalAttached: false });
      expect(await observed(replaced)).toMatchObject({ signalAttached: true });
    });

    it('lets fetch init override the signal of a Request input', async () => {
      const url = uniqueUrl();
      quietFetch(new Request(url), { signal: AbortSignal.timeout(6000) });
      expect(await observed(url)).toMatchObject({ signalAttached: true, signalDeadlineMs: 6000 });
    });

    it('reports unknown for a Request built before the wrappers were installed', async () => {
      quietFetch(earlyRequest);
      expect(await observed(earlyRequest.url)).toMatchObject({ path: 'fetch', signalAttached: null });
    });

    it('reports a signal passed in http.request options', async () => {
      const url = uniqueUrl();
      viaHttpRequest(url, { signal: new AbortController().signal }).end();
      expect(await observed(url)).toMatchObject({ path: 'http', signalAttached: true });
    });

    it('reports no signal for http.request and http.get without one', async () => {
      const requestUrl = uniqueUrl();
      const getUrl = uniqueUrl();
      viaHttpRequest(requestUrl).end();
      viaHttpGet(getUrl);
      expect(await observed(requestUrl)).toMatchObject({ path: 'http', signalAttached: false });
      expect(await observed(getUrl)).toMatchObject({ path: 'http', signalAttached: false });
    });
  });

  describe('deadline tags', () => {
    it('recognizes AbortSignal.timeout(100) in fetch init with its deadline', async () => {
      const url = uniqueUrl();
      quietFetch(url, { signal: AbortSignal.timeout(100) });
      expect(await observed(url)).toMatchObject({ signalAttached: true, signalDeadlineMs: 100 });
    });

    it('recognizes AbortSignal.timeout(100) in http.request options with its deadline', async () => {
      const url = uniqueUrl();
      viaHttpRequest(url, { signal: AbortSignal.timeout(100) }).end();
      expect(await observed(url)).toMatchObject({ signalAttached: true, signalDeadlineMs: 100 });
    });

    it('carries the shortest deadline through AbortSignal.any', async () => {
      const url = uniqueUrl();
      const signal = AbortSignal.any([
        new AbortController().signal,
        AbortSignal.timeout(5000),
        AbortSignal.timeout(100),
      ]);
      quietFetch(url, { signal });
      expect(await observed(url)).toMatchObject({ signalAttached: true, signalDeadlineMs: 100 });
    });

    it('records no deadline for a plain controller signal', async () => {
      const url = uniqueUrl();
      quietFetch(url, { signal: new AbortController().signal });
      expect(await observed(url)).toMatchObject({ signalAttached: true, signalDeadlineMs: null });
    });

    it('recognizes AbortSignal.timeout(100) given to a Request, directly and through a copy', async () => {
      const copyUrl = uniqueUrl();
      quietFetch(new Request(new Request(copyUrl, { signal: AbortSignal.timeout(100) })));
      expect(await observed(copyUrl)).toMatchObject({ signalAttached: true, signalDeadlineMs: 100 });

      const url = uniqueUrl();
      const request = new Request(url, { signal: AbortSignal.timeout(100) });
      quietFetch(request);
      expect(await observed(url)).toMatchObject({ signalAttached: true, signalDeadlineMs: 100 });
      const settled = await observed(url, (entry) => entry.outcome === 'aborted');
      expect(settled).toMatchObject({ firedMechanism: 'signal', abortKind: 'timeout' });
      // Node stops propagating the timeout once the Request is garbage collected, so it must stay reachable.
      expect(request.signal.aborted).toBe(true);
    });
  });

  describe('http socket timeouts', () => {
    function settleOnTimeout(request: http.ClientRequest): Promise<number> {
      const startedAt = performance.now();
      return new Promise((resolve) => {
        request.on('timeout', () => request.destroy());
        request.on('close', () => resolve(performance.now() - startedAt));
      });
    }

    it('fires the timeout option within 50-500 ms and records it', async () => {
      const url = uniqueUrl();
      const request = viaHttpRequest(url, { timeout: 50 });
      const closed = settleOnTimeout(request);
      request.end();
      const elapsedMs = await closed;
      expect(elapsedMs).toBeGreaterThanOrEqual(49);
      expect(elapsedMs).toBeLessThanOrEqual(500);
      expect(await observed(url, (entry) => entry.outcome === 'aborted')).toMatchObject({
        socketTimeoutMs: 50,
        signalAttached: false,
        firedMechanism: 'socket-timeout',
        abortKind: 'timeout',
      });
    });

    it('fires req.setTimeout(50) within 50-500 ms and records it', async () => {
      const url = uniqueUrl();
      const request = viaHttpRequest(url);
      request.setTimeout(50);
      const closed = settleOnTimeout(request);
      request.end();
      const elapsedMs = await closed;
      expect(elapsedMs).toBeGreaterThanOrEqual(49);
      expect(elapsedMs).toBeLessThanOrEqual(500);
      expect(await observed(url, (entry) => entry.outcome === 'aborted')).toMatchObject({
        socketTimeoutMs: 50,
        signalAttached: false,
        firedMechanism: 'socket-timeout',
        abortKind: 'timeout',
      });
    });

    it('records both kinds of socket timeout while the request is pending', async () => {
      const optionUrl = uniqueUrl();
      const setTimeoutUrl = uniqueUrl();
      const noneUrl = uniqueUrl();
      viaHttpRequest(optionUrl, { timeout: 4000 }).end();
      const later = viaHttpRequest(setTimeoutUrl);
      later.end();
      later.setTimeout(3000);
      viaHttpRequest(noneUrl).end();
      expect(await observed(optionUrl)).toMatchObject({ outcome: 'pending', socketTimeoutMs: 4000 });
      expect(await observed(setTimeoutUrl)).toMatchObject({ outcome: 'pending', socketTimeoutMs: 3000 });
      expect(await observed(noneUrl)).toMatchObject({ outcome: 'pending', socketTimeoutMs: null });
    });
  });

  describe('abort kind', () => {
    it('reports a controller abort as abort on both paths', async () => {
      const fetchUrl = uniqueUrl();
      const httpUrl = uniqueUrl();
      const controller = new AbortController();
      quietFetch(fetchUrl, { signal: controller.signal });
      viaHttpRequest(httpUrl, { signal: controller.signal }).end();
      await observed(fetchUrl);
      await observed(httpUrl);
      controller.abort();
      const expected = { outcome: 'aborted', firedMechanism: 'signal', abortKind: 'abort' };
      expect(await observed(fetchUrl, (entry) => entry.outcome !== 'pending')).toMatchObject(expected);
      expect(await observed(httpUrl, (entry) => entry.outcome !== 'pending')).toMatchObject(expected);
    });

    it('reports a signal timeout as timeout on both paths', async () => {
      const fetchUrl = uniqueUrl();
      const httpUrl = uniqueUrl();
      quietFetch(fetchUrl, { signal: AbortSignal.timeout(60) });
      viaHttpRequest(httpUrl, { signal: AbortSignal.timeout(60) }).end();
      const expected = { outcome: 'aborted', firedMechanism: 'signal', abortKind: 'timeout' };
      expect(await observed(fetchUrl, (entry) => entry.outcome !== 'pending')).toMatchObject(expected);
      expect(await observed(httpUrl, (entry) => entry.outcome !== 'pending')).toMatchObject(expected);
    });

    it('reports a manual destroy as an abort with the manual-destroy mechanism', async () => {
      const url = uniqueUrl();
      const request = viaHttpRequest(url);
      request.end();
      await observed(url);
      request.destroy();
      expect(await observed(url, (entry) => entry.outcome !== 'pending')).toMatchObject({
        outcome: 'aborted',
        firedMechanism: 'manual-destroy',
        abortKind: 'abort',
      });
    });

    it('reports a released request as released with the sentinel as evidence', async () => {
      const url = uniqueUrl();
      quietFetch(url);
      await observed(url);
      interception.blackHole.release();
      const released = await observed(url, (entry) => entry.outcome === 'released');
      expect(released).toMatchObject({ firedMechanism: null, abortKind: null });
      expect(isSentinel(released.rawError)).toBe(true);
    });
  });

  describe('concurrency', () => {
    it('attributes two concurrent requests to their own metadata', async () => {
      const timedUrl = uniqueUrl();
      const plainUrl = uniqueUrl();
      quietFetch(timedUrl, { signal: AbortSignal.timeout(100) });
      quietFetch(plainUrl);
      expect(await observed(timedUrl)).toMatchObject({ signalAttached: true, signalDeadlineMs: 100 });
      expect(await observed(plainUrl)).toMatchObject({ signalAttached: false, signalDeadlineMs: null });
      expect(await observed(timedUrl, (entry) => entry.outcome === 'aborted')).toMatchObject({
        firedMechanism: 'signal',
        abortKind: 'timeout',
      });
      expect(await observed(plainUrl)).toMatchObject({ outcome: 'pending' });
    });

    it('attributes 20 interleaved requests to their own metadata', async () => {
      const expected = Array.from({ length: 20 }, (_, index) => {
        const url = uniqueUrl();
        const path = index % 2 === 0 ? ('fetch' as const) : ('http' as const);
        const deadlineMs = index % 4 < 2 ? 10_000 + index : null;
        return { url, path, deadlineMs };
      });

      await Promise.all(
        expected.map(async ({ url, path, deadlineMs }, index) => {
          await sleep(index % 3);
          const signal = deadlineMs === null ? undefined : AbortSignal.timeout(deadlineMs);
          if (path === 'fetch') quietFetch(url, signal ? { signal } : {});
          else viaHttpRequest(url, signal ? { signal } : {}).end();
        }),
      );

      for (const { url, path, deadlineMs } of expected) {
        expect(await observed(url)).toMatchObject({
          path,
          outcome: 'pending',
          signalAttached: deadlineMs !== null,
          signalDeadlineMs: deadlineMs,
        });
      }
      expect(interception.blackHole.pendingCount).toBe(20);
    });
  });

  describe('stack capture', () => {
    it.each([
      ['fetch', 'return fetch(input, init);', (url: string) => quietFetch(url)],
      ['http.request', 'http.request(url, options);', (url: string) => viaHttpRequest(url).end()],
      ['http.get', 'http.get(url, options);', (url: string) => void viaHttpGet(url)],
      ['a named import of get', 'namedGet(url);', (url: string) => void viaNamedGet(url)],
    ])('contains the calling file and line for %s', async (_label, snippet, call) => {
      const url = uniqueUrl();
      call(url);
      const { stack } = await observed(url);
      expect(stack?.replaceAll('\\', '/')).toContain(`fixtures/call-sites/calls.ts:${lineOf(snippet)}:`);
    });
  });

  describe('correlation identity', () => {
    it.each([
      ['http.request', () => http.request(uniqueUrl())],
      ['http.get', () => http.get(uniqueUrl())],
      ['https.request', () => https.request(uniqueUrl('https://blackhole.chimpd.invalid'))],
      ['https.get', () => https.get(uniqueUrl('https://blackhole.chimpd.invalid'))],
    ])('hands the listener the ClientRequest returned by %s', async (_label, start) => {
      const request = start();
      request.on('error', () => undefined);
      request.end();
      const url = `${request.protocol}//${request.host}${request.path}`;
      const { initiator } = await observed(url);
      expect(initiator).toBe(request);
    });
  });

  describe('Request wrapper transparency', () => {
    it('keeps instanceof true for Requests from every origin', async () => {
      expect(Request).not.toBe(RequestBeforeInstall);
      expect(earlyRequest instanceof Request).toBe(true);
      expect(new Request(uniqueUrl()) instanceof Request).toBe(true);
      expect(new Request(uniqueUrl()) instanceof RequestBeforeInstall).toBe(true);
      expect(new RequestBeforeInstall(uniqueUrl()) instanceof Request).toBe(true);

      const url = uniqueUrl();
      quietFetch(url);
      const { initiator } = await observed(url);
      expect(initiator instanceof Request).toBe(true);
      expect(initiator instanceof RequestBeforeInstall).toBe(true);
    });

    it('leaves the prototype and static members unchanged', () => {
      expect(Request.prototype).toBe(prototypeBeforeInstall);
      expect(Request.prototype.constructor).toBe(RequestBeforeInstall);
      expect(Object.getOwnPropertyDescriptors(Request)).toEqual(staticsBeforeInstall);
      expect(Request.name).toBe(RequestBeforeInstall.name);
      expect(Request.length).toBe(RequestBeforeInstall.length);
      expect(typeof Request).toBe('function');
      expect(Object.getPrototypeOf(new Request(uniqueUrl()))).toBe(prototypeBeforeInstall);
    });

    it('throws exactly as before when called without new', () => {
      const error = constructWithoutNew(Request);
      expect(error).toBeInstanceOf(TypeError);
      expect(Object.getPrototypeOf(error)).toBe(Object.getPrototypeOf(errorBeforeInstall));
      expect((error as Error).message).toBe((errorBeforeInstall as Error).message);
    });

    it('supports subclasses and records their signals', async () => {
      class TaggedRequest extends Request {
        readonly tag = 'tagged';
      }
      const url = uniqueUrl();
      const request = new TaggedRequest(url, { signal: AbortSignal.timeout(8000) });
      expect(request).toBeInstanceOf(TaggedRequest);
      expect(request.tag).toBe('tagged');
      quietFetch(request);
      expect(await observed(url)).toMatchObject({ signalAttached: true, signalDeadlineMs: 8000 });
    });

    it('restores the original Request on dispose', () => {
      interception.dispose();
      expect(Request).toBe(RequestBeforeInstall);
      interception = installBlackHole(['fetch', 'client-request']);
    });
  });

  describe('wrapper transparency', () => {
    it('installs the wrappers as the active entry points and restores the originals', () => {
      expect(globalThis.fetch).toBe(interception.wrappers.fetch);
      expect(http.request).toBe(interception.wrappers.httpRequest);
      expect(http.get).toBe(interception.wrappers.httpGet);
      expect(https.request).toBe(interception.wrappers.httpsRequest);
      expect(https.get).toBe(interception.wrappers.httpsGet);

      interception.dispose();
      expect(globalThis.fetch).not.toBe(interception.wrappers.fetch);
      expect(http.request).not.toBe(interception.wrappers.httpRequest);
      interception = installBlackHole(['fetch', 'client-request']);
    });

    it('returns synchronously with the same kinds of values as the originals', () => {
      const pending = fetch(uniqueUrl());
      pending.catch(() => undefined);
      expect(pending).toBeInstanceOf(Promise);

      const request = http.request(uniqueUrl());
      request.on('error', () => undefined);
      expect(request).toBeInstanceOf(http.ClientRequest);
      expect(request.setTimeout(1000)).toBe(request);
      request.end();

      expect(AbortSignal.timeout(1000)).toBeInstanceOf(AbortSignal);
      expect(AbortSignal.any([])).toBeInstanceOf(AbortSignal);
    });

    it('keeps the callback overloads of http.request and http.get working', async () => {
      const url = new URL(uniqueUrl());
      const viaOptionsOnly = http.request({ host: url.hostname, path: `${url.pathname}${url.search}` }, () => undefined);
      viaOptionsOnly.on('error', () => undefined);
      viaOptionsOnly.end();
      expect(await observed(url.href)).toMatchObject({ path: 'http', signalAttached: false });

      const second = new URL(uniqueUrl());
      const viaUrlObject = http.get(second, { signal: AbortSignal.timeout(7000) }, () => undefined);
      viaUrlObject.on('error', () => undefined);
      expect(await observed(second.href)).toMatchObject({ signalAttached: true, signalDeadlineMs: 7000 });
    });

    it('holds https requests on both paths', async () => {
      const fetchUrl = uniqueUrl('https://blackhole.chimpd.invalid');
      const httpsUrl = uniqueUrl('https://blackhole.chimpd.invalid');
      quietFetch(fetchUrl, { signal: AbortSignal.timeout(9000) });
      const request = https.request(httpsUrl, { timeout: 8000 });
      request.on('error', () => undefined);
      request.end();
      expect(await observed(fetchUrl)).toMatchObject({ path: 'fetch', outcome: 'pending', signalDeadlineMs: 9000 });
      expect(await observed(httpsUrl)).toMatchObject({ path: 'http', outcome: 'pending', socketTimeoutMs: 8000 });
    });
  });
});
