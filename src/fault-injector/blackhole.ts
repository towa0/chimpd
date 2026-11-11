import type { HttpRequestEvent } from '@mswjs/interceptors';
import { RequestController } from '@mswjs/interceptors';
import http from 'node:http';
import type { AbortKind, DeadlineMechanism } from '../core/index.js';
import { metadataFor, socketTimeoutFor, type CallMetadata } from './call-capture.js';
import { realNow } from './real-clock.js';

export class BlackHoleReleased extends Error {
  override readonly name = 'ChimpdBlackHoleReleased';

  constructor() {
    super('chimpd released a black-holed request');
  }
}

const MAX_CAUSE_DEPTH = 5;

export function isSentinel(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (current instanceof BlackHoleReleased) return true;
    if (!(current instanceof Error)) return false;
    current = current.cause;
  }
  return false;
}

export interface RequestObservation {
  readonly method: string;
  readonly url: string;
  readonly path: 'fetch' | 'http' | 'unknown';
  readonly stack: string | null;
  readonly signalAttached: boolean | null;
  readonly signalDeadlineMs: number | null;
  readonly socketTimeoutMs: number | null;
  readonly outcome: 'pending' | 'aborted' | 'released';
  readonly firedMechanism: DeadlineMechanism | null;
  readonly abortKind: AbortKind | null;
  readonly rawError: unknown;
}

interface Settlement {
  readonly outcome: 'pending' | 'aborted' | 'released';
  readonly firedMechanism: DeadlineMechanism | null;
  readonly abortKind: AbortKind | null;
  readonly rawError: unknown;
}

const PENDING: Settlement = { outcome: 'pending', firedMechanism: null, abortKind: null, rawError: null };

// A socket timer armed at armedAt cannot fire earlier than this, allowing for millisecond rounding.
const TIMER_ROUNDING_MS = 1;

interface HeldRequest {
  readonly event: Pick<HttpRequestEvent, 'request' | 'controller' | 'initiator'>;
  readonly metadata: CallMetadata | null;
  settlement: Settlement;
  readonly settle: () => void;
}

function isTimeoutReason(reason: unknown): boolean {
  return reason instanceof Error && reason.name === 'TimeoutError';
}

function classifyTeardown(held: HeldRequest): Settlement {
  const { initiator } = held.event;
  const signal = held.metadata?.signal ?? null;
  if (signal?.aborted) {
    return {
      outcome: 'aborted',
      firedMechanism: 'signal',
      abortKind: isTimeoutReason(signal.reason) ? 'timeout' : 'abort',
      rawError: signal.reason,
    };
  }
  const rawError = initiator instanceof http.ClientRequest ? initiator.errored : null;
  const socketTimeout = socketTimeoutFor(initiator, held.metadata);
  if (socketTimeout !== null && realNow() - socketTimeout.armedAt >= socketTimeout.ms - TIMER_ROUNDING_MS) {
    return { outcome: 'aborted', firedMechanism: 'socket-timeout', abortKind: 'timeout', rawError };
  }
  return { outcome: 'aborted', firedMechanism: null, abortKind: 'abort', rawError };
}

function observe(held: HeldRequest): RequestObservation {
  const { metadata, settlement, event } = held;
  return {
    method: event.request.method,
    url: event.request.url,
    path: metadata?.path ?? 'unknown',
    stack: metadata?.stack ?? null,
    signalAttached: metadata?.signalAttached ?? null,
    signalDeadlineMs: metadata?.signalDeadlineMs ?? null,
    socketTimeoutMs: socketTimeoutFor(event.initiator, metadata)?.ms ?? null,
    ...settlement,
  };
}

export class BlackHole {
  readonly #all: HeldRequest[] = [];
  readonly #pending = new Set<HeldRequest>();

  get pendingCount(): number {
    return this.#pending.size;
  }

  get observations(): readonly RequestObservation[] {
    return this.#all.map(observe);
  }

  hold(event: Pick<HttpRequestEvent, 'request' | 'controller' | 'initiator'>): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    const held: HeldRequest = {
      event,
      metadata: metadataFor(event.initiator),
      settlement: PENDING,
      settle: () => {
        this.#pending.delete(held);
        resolve();
      },
    };
    this.#all.push(held);
    this.#pending.add(held);
    event.request.signal.addEventListener(
      'abort',
      () => {
        if (held.settlement.outcome !== 'pending') return;
        held.settlement = classifyTeardown(held);
        held.settle();
      },
      { once: true },
    );
    return promise;
  }

  release(): number {
    let released = 0;
    for (const held of [...this.#pending]) {
      if (held.event.controller.readyState === RequestController.PENDING) {
        const sentinel = new BlackHoleReleased();
        held.settlement = { outcome: 'released', firedMechanism: null, abortKind: null, rawError: sentinel };
        held.event.controller.errorWith(sentinel);
        released += 1;
      }
      held.settle();
    }
    return released;
  }
}
