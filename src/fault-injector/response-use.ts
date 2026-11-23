import type http from 'node:http';
import type { ResponseUse } from '../core/index.js';

export interface ResponseWatch {
  use(): ResponseUse;
}

class Recorder {
  #statusRead = false;
  #bodyConsumed = false;
  #bodyBeforeStatus = false;

  status(): void {
    this.#statusRead = true;
  }

  body(): void {
    if (!this.#bodyConsumed && !this.#statusRead) this.#bodyBeforeStatus = true;
    this.#bodyConsumed = true;
  }

  use(): ResponseUse {
    return { statusRead: this.#statusRead, bodyConsumed: this.#bodyConsumed, bodyBeforeStatus: this.#bodyBeforeStatus };
  }
}

const FETCH_STATUS = ['ok', 'status', 'statusText'] as const;
const FETCH_BODY = ['json', 'text', 'arrayBuffer', 'blob', 'formData', 'bytes'] as const;

type Method = (...args: unknown[]) => unknown;

// Getters and methods are re-applied with the response as receiver, so they are read unbound on purpose.
function prototypeGetter(owner: object, key: string): (() => unknown) | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(owner, key);
  return descriptor === undefined ? undefined : (Reflect.get(descriptor, 'get') as (() => unknown) | undefined);
}

/** Records reads of the status and the body on this one response, through properties on the instance. */
export function watchFetchResponse(response: Response): ResponseWatch {
  const recorder = new Recorder();
  const proto = Object.getPrototypeOf(response) as object;
  for (const key of [...FETCH_STATUS, 'body']) {
    const getter = prototypeGetter(proto, key) ?? prototypeGetter(Response.prototype, key);
    if (getter === undefined) continue;
    const mark = key === 'body' ? () => recorder.body() : () => recorder.status();
    Object.defineProperty(response, key, {
      configurable: true,
      get() {
        mark();
        return getter.call(response);
      },
    });
  }
  for (const key of FETCH_BODY) {
    const method = (proto as Record<string, unknown>)[key];
    if (typeof method !== 'function') continue;
    Object.defineProperty(response, key, {
      configurable: true,
      writable: true,
      value(this: Response, ...args: unknown[]) {
        recorder.body();
        return Reflect.apply(method as Method, this, args);
      },
    });
  }
  return recorder;
}

const BODY_EVENTS = new Set(['data', 'readable']);
const LISTENER_METHODS = ['on', 'addListener', 'once', 'prependListener', 'prependOnceListener'] as const;
// read is left alone: a stream that resume() drains calls it internally, and a discarded body is not consumed.
const READ_METHODS = ['pipe'] as const;

/** Records reads of the status and the body on this one http response, through properties on the instance. */
export function watchHttpResponse(message: http.IncomingMessage): ResponseWatch {
  const recorder = new Recorder();
  for (const key of ['statusCode', 'statusMessage'] as const) {
    let value: unknown = message[key];
    Object.defineProperty(message, key, {
      configurable: true,
      enumerable: true,
      get() {
        recorder.status();
        return value;
      },
      set(next: unknown) {
        value = next;
      },
    });
  }
  for (const key of LISTENER_METHODS) {
    const original = Reflect.get(message, key) as Method;
    Object.defineProperty(message, key, {
      configurable: true,
      writable: true,
      value(this: http.IncomingMessage, event: unknown, ...rest: unknown[]) {
        if (typeof event === 'string' && BODY_EVENTS.has(event)) recorder.body();
        return Reflect.apply(original, this, [event, ...rest]);
      },
    });
  }
  for (const key of READ_METHODS) {
    const original = Reflect.get(message, key) as Method;
    Object.defineProperty(message, key, {
      configurable: true,
      writable: true,
      value(this: http.IncomingMessage, ...args: unknown[]) {
        recorder.body();
        return Reflect.apply(original, this, args);
      },
    });
  }
  const iterate = message[Symbol.asyncIterator] as Method;
  Object.defineProperty(message, Symbol.asyncIterator, {
    configurable: true,
    writable: true,
    value(this: http.IncomingMessage) {
      recorder.body();
      return Reflect.apply(iterate, this, []);
    },
  });
  return recorder;
}
