import { AsyncLocalStorage } from 'node:async_hooks';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import { realNow } from '../core/index.js';

export interface CallMetadata {
  readonly path: 'fetch' | 'http';
  readonly stack: string;
  readonly createdAt: number;
  readonly signal: AbortSignal | null;
  /** null when fetch received a Request built before the Request wrapper was installed. */
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
const openingCalls = new AsyncLocalStorage<CallMetadata>();

interface RequestSignalRecord {
  readonly signalAttached: boolean;
  readonly signalDeadlineMs: number | null;
}

// Values hold no object references, so a recorded Request is collected exactly as before.
const requestSignals = new WeakMap<Request, RequestSignalRecord>();

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

function signalRecord(input: unknown, init: unknown): RequestSignalRecord | undefined {
  const initSignal = (init as { signal?: unknown } | undefined)?.signal;
  if (initSignal instanceof AbortSignal) {
    return { signalAttached: true, signalDeadlineMs: deadlineOf(initSignal) };
  }
  // An explicit null detaches the signal of the Request being copied.
  if (initSignal !== null && input instanceof Request) return requestSignals.get(input);
  return { signalAttached: false, signalDeadlineMs: null };
}

function captureFetch(input: unknown, init: unknown, below: Callable): CallMetadata {
  const initSignal = (init as { signal?: unknown } | undefined)?.signal;
  const record = signalRecord(input, init);
  return {
    path: 'fetch',
    stack: captureStack(below),
    createdAt: realNow(),
    signal: initSignal instanceof AbortSignal ? initSignal : input instanceof Request ? input.signal : null,
    signalAttached: record?.signalAttached ?? null,
    signalDeadlineMs: record?.signalDeadlineMs ?? null,
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

type OnCall = ((metadata: CallMetadata) => void) | undefined;

function wrapFetch(original: typeof fetch, onCall: OnCall): typeof fetch {
  const wrapper = function (this: unknown, ...args: unknown[]): Promise<Response> {
    const metadata = captureFetch(args[0], args[1], wrapper);
    onCall?.(metadata);
    return fetchCalls.run(metadata, () => Reflect.apply(original, this, args) as Promise<Response>);
  };
  return keepIdentity(wrapper, original);
}

function wrapRequest(original: typeof Request): typeof Request {
  return new Proxy(original, {
    construct(target, args: unknown[], newTarget) {
      const request = Reflect.construct(target, args, newTarget) as Request;
      const record = signalRecord(args[0], args[1]);
      if (record !== undefined) requestSignals.set(request, record);
      return request;
    },
  });
}

// A request that reuses an idle keep-alive socket opens no connection, so nothing could claim it.
function closeIdleSockets(args: readonly unknown[], defaultAgent: http.Agent): void {
  const { agent } = httpOptions(args) as { agent?: unknown };
  if (agent === false) return;
  const target = agent instanceof http.Agent ? agent : defaultAgent;
  for (const sockets of Object.values(target.freeSockets)) {
    for (const socket of sockets ?? []) socket.destroy();
  }
}

interface HttpCallHooks {
  readonly onCall: OnCall;
  readonly needsFreshConnection: ((metadata: CallMetadata) => boolean) | undefined;
  readonly defaultAgent: () => http.Agent;
}

function wrapHttpCall<T extends typeof http.request>(original: T, hooks: HttpCallHooks): T {
  const wrapper = function (this: unknown, ...args: unknown[]): http.ClientRequest {
    const metadata = captureHttp(args, wrapper);
    hooks.onCall?.(metadata);
    if (hooks.needsFreshConnection?.(metadata) === true) closeIdleSockets(args, hooks.defaultAgent());
    const request = openingCalls.run(metadata, () => Reflect.apply(original, this, args) as http.ClientRequest);
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

export interface CallCaptureOptions {
  readonly onCall?: (metadata: CallMetadata) => void;
  /** Calls for which an http request must open its own connection instead of reusing an idle one. */
  readonly needsFreshConnection?: (metadata: CallMetadata) => boolean;
}

export function installCallCapture(options: CallCaptureOptions = {}): CallCapture {
  const { onCall, needsFreshConnection } = options;
  const plain: HttpCallHooks = { onCall, needsFreshConnection, defaultAgent: () => http.globalAgent };
  const secure: HttpCallHooks = { onCall, needsFreshConnection, defaultAgent: () => https.globalAgent };
  const original = {
    fetch: globalThis.fetch,
    Request: globalThis.Request,
    httpRequest: http.request,
    httpGet: http.get,
    httpsRequest: https.request,
    httpsGet: https.get,
    setTimeout: detach(http.ClientRequest.prototype, 'setTimeout'),
    signalTimeout: detach(AbortSignal, 'timeout'),
    signalAny: detach(AbortSignal, 'any'),
  };
  const wrappers = {
    fetch: wrapFetch(original.fetch, onCall),
    httpRequest: wrapHttpCall(original.httpRequest, plain),
    httpGet: wrapHttpCall(original.httpGet, plain),
    httpsRequest: wrapHttpCall(original.httpsRequest, secure),
    httpsGet: wrapHttpCall(original.httpsGet, secure),
  };

  globalThis.fetch = wrappers.fetch;
  globalThis.Request = wrapRequest(original.Request);
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
      globalThis.Request = original.Request;
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

/** The call whose entry point is on the current async path, as seen by a socket it opens. */
export function callInProgress(): CallMetadata | null {
  return openingCalls.getStore() ?? fetchCalls.getStore() ?? null;
}

export function socketTimeoutFor(initiator: unknown, metadata: CallMetadata | null): SocketTimeout | null {
  if (!(initiator instanceof http.ClientRequest)) return null;
  const explicit = requestTimeouts.get(initiator);
  if (explicit !== undefined) return explicit;
  if (metadata === null || metadata.timeoutOptionMs === null) return null;
  return { ms: metadata.timeoutOptionMs, armedAt: metadata.createdAt };
}
