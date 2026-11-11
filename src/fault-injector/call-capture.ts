import { AsyncLocalStorage } from 'node:async_hooks';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import { realNow } from './real-clock.js';

export interface CallMetadata {
  readonly path: 'fetch' | 'http';
  readonly stack: string;
  readonly createdAt: number;
  readonly signal: AbortSignal | null;
  /** null when a Request object was passed to fetch: every Request carries a signal of its own. */
  readonly signalAttached: boolean | null;
  readonly signalDeadlineMs: number | null;
  readonly timeoutOptionMs: number | null;
}

export interface SocketTimeout {
  readonly ms: number;
  readonly armedAt: number;
}

type Callable = (...args: never[]) => unknown;

const CAPTURED_STACK_FRAMES = 50;

const signalDeadlines = new WeakMap<AbortSignal, number>();
const httpCalls = new WeakMap<http.ClientRequest, CallMetadata>();
const requestTimeouts = new WeakMap<http.ClientRequest, SocketTimeout>();
const fetchCalls = new AsyncLocalStorage<CallMetadata>();

function captureStack(below: Callable): string {
  const holder: { stack?: string } = {};
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = CAPTURED_STACK_FRAMES;
  Error.captureStackTrace(holder, below);
  Error.stackTraceLimit = limit;
  return holder.stack ?? '';
}

function deadlineOf(signal: AbortSignal | null): number | null {
  return signal === null ? null : (signalDeadlines.get(signal) ?? null);
}

function positiveMs(value: unknown): number | null {
  return typeof value === 'number' && value > 0 ? value : null;
}

function captureFetch(input: unknown, init: unknown, below: Callable): CallMetadata {
  const initSignal = (init as { signal?: unknown } | undefined)?.signal;
  const fromInit = initSignal instanceof AbortSignal ? initSignal : null;
  const fromRequest = input instanceof Request ? input.signal : null;
  const signal = fromInit ?? fromRequest;
  return {
    path: 'fetch',
    stack: captureStack(below),
    createdAt: realNow(),
    signal,
    signalAttached: fromInit !== null ? true : fromRequest !== null ? null : false,
    signalDeadlineMs: deadlineOf(signal),
    timeoutOptionMs: null,
  };
}

function httpOptions(args: readonly unknown[]): { signal?: unknown; timeout?: unknown } {
  const options = args.find(
    (arg) => typeof arg === 'object' && arg !== null && !(arg instanceof URL),
  );
  return options ?? {};
}

function captureHttp(args: readonly unknown[], below: Callable): CallMetadata {
  const options = httpOptions(args);
  const signal = options.signal instanceof AbortSignal ? options.signal : null;
  return {
    path: 'http',
    stack: captureStack(below),
    createdAt: realNow(),
    signal,
    signalAttached: signal !== null,
    signalDeadlineMs: deadlineOf(signal),
    timeoutOptionMs: positiveMs(options.timeout),
  };
}

function keepIdentity<T extends Callable>(wrapper: Callable, original: T): T {
  Object.defineProperty(wrapper, 'name', { value: original.name, configurable: true });
  Object.defineProperty(wrapper, 'length', { value: original.length, configurable: true });
  return wrapper as T;
}

function wrapFetch(original: typeof fetch): typeof fetch {
  const wrapper = function (this: unknown, ...args: unknown[]): Promise<Response> {
    const metadata = captureFetch(args[0], args[1], wrapper);
    return fetchCalls.run(metadata, () => Reflect.apply(original, this, args) as Promise<Response>);
  };
  return keepIdentity(wrapper, original);
}

function wrapHttpCall<T extends typeof http.request>(original: T): T {
  const wrapper = function (this: unknown, ...args: unknown[]): http.ClientRequest {
    const metadata = captureHttp(args, wrapper);
    const request = Reflect.apply(original, this, args) as http.ClientRequest;
    httpCalls.set(request, metadata);
    return request;
  };
  return keepIdentity(wrapper, original);
}

type SetTimeout = http.ClientRequest['setTimeout'];

function wrapSetTimeout(original: SetTimeout): SetTimeout {
  const wrapper = function (this: http.ClientRequest, ...args: unknown[]): http.ClientRequest {
    const ms = positiveMs(args[0]);
    if (ms === null) requestTimeouts.delete(this);
    else requestTimeouts.set(this, { ms, armedAt: realNow() });
    return Reflect.apply(original, this, args) as http.ClientRequest;
  };
  return keepIdentity(wrapper, original);
}

function wrapSignalTimeout(original: typeof AbortSignal.timeout): typeof AbortSignal.timeout {
  const wrapper = function (this: unknown, ...args: unknown[]): AbortSignal {
    const signal = Reflect.apply(original, this, args) as AbortSignal;
    const ms = positiveMs(args[0]);
    if (ms !== null) signalDeadlines.set(signal, ms);
    return signal;
  };
  return keepIdentity(wrapper, original);
}

function wrapSignalAny(original: typeof AbortSignal.any): typeof AbortSignal.any {
  const wrapper = function (this: unknown, ...args: unknown[]): AbortSignal {
    const signal = Reflect.apply(original, this, args) as AbortSignal;
    const sources: unknown[] = Array.isArray(args[0]) ? args[0] : [];
    const deadlines = sources
      .map((source) => (source instanceof AbortSignal ? signalDeadlines.get(source) : undefined))
      .filter((ms): ms is number => ms !== undefined);
    if (deadlines.length > 0) signalDeadlines.set(signal, Math.min(...deadlines));
    return signal;
  };
  return keepIdentity(wrapper, original);
}

// Wrappers re-apply these with the caller's receiver, so the unbound references are intended.
function detach<T, K extends keyof T>(owner: T, key: K): T[K] {
  return owner[key];
}

export interface CallCapture {
  readonly wrappers: {
    readonly fetch: typeof fetch;
    readonly httpRequest: typeof http.request;
    readonly httpGet: typeof http.get;
    readonly httpsRequest: typeof https.request;
    readonly httpsGet: typeof https.get;
  };
  restore(): void;
}

export function installCallCapture(): CallCapture {
  const original = {
    fetch: globalThis.fetch,
    httpRequest: http.request,
    httpGet: http.get,
    httpsRequest: https.request,
    httpsGet: https.get,
    setTimeout: detach(http.ClientRequest.prototype, 'setTimeout'),
    signalTimeout: detach(AbortSignal, 'timeout'),
    signalAny: detach(AbortSignal, 'any'),
  };
  const wrappers = {
    fetch: wrapFetch(original.fetch),
    httpRequest: wrapHttpCall(original.httpRequest),
    httpGet: wrapHttpCall(original.httpGet),
    httpsRequest: wrapHttpCall(original.httpsRequest),
    httpsGet: wrapHttpCall(original.httpsGet),
  };

  globalThis.fetch = wrappers.fetch;
  http.request = wrappers.httpRequest;
  http.get = wrappers.httpGet;
  https.request = wrappers.httpsRequest;
  https.get = wrappers.httpsGet;
  http.ClientRequest.prototype.setTimeout = wrapSetTimeout(original.setTimeout);
  AbortSignal.timeout = wrapSignalTimeout(original.signalTimeout);
  AbortSignal.any = wrapSignalAny(original.signalAny);
  // Named imports of node:http bind to export slots that only this call refreshes.
  syncBuiltinESMExports();

  return {
    wrappers,
    restore() {
      globalThis.fetch = original.fetch;
      http.request = original.httpRequest;
      http.get = original.httpGet;
      https.request = original.httpsRequest;
      https.get = original.httpsGet;
      http.ClientRequest.prototype.setTimeout = original.setTimeout;
      AbortSignal.timeout = original.signalTimeout;
      AbortSignal.any = original.signalAny;
      syncBuiltinESMExports();
    },
  };
}

export function metadataFor(initiator: unknown): CallMetadata | null {
  if (initiator instanceof http.ClientRequest) return httpCalls.get(initiator) ?? null;
  if (initiator instanceof Request) return fetchCalls.getStore() ?? null;
  return null;
}

export function socketTimeoutFor(initiator: unknown, metadata: CallMetadata | null): SocketTimeout | null {
  if (!(initiator instanceof http.ClientRequest)) return null;
  const explicit = requestTimeouts.get(initiator);
  if (explicit !== undefined) return explicit;
  if (metadata === null || metadata.timeoutOptionMs === null) return null;
  return { ms: metadata.timeoutOptionMs, armedAt: metadata.createdAt };
}
