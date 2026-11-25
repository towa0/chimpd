import type { InjectedFaultKind } from '../core/index.js';
import type { Injector } from './inject.js';
import { respondWithMalformedJson } from './malformed-json.js';
import { refuseConnection } from './refused.js';
import { respondWithServerError } from './server-error.js';

/** The fault kinds bruise can inject, each with the injector that answers a targeted call. */
export const INJECTORS: Readonly<Partial<Record<InjectedFaultKind, Injector>>> = {
  'connection-refused': refuseConnection,
  'http-500': respondWithServerError,
  'malformed-json': respondWithMalformedJson,
};
