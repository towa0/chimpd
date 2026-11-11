import type { HttpRequestEvent } from '@mswjs/interceptors';
import { RequestController } from '@mswjs/interceptors';

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

interface HeldRequest {
  readonly controller: RequestController;
  readonly settle: () => void;
}

export class BlackHole {
  readonly #held = new Set<HeldRequest>();

  get pendingCount(): number {
    return this.#held.size;
  }

  hold(event: Pick<HttpRequestEvent, 'request' | 'controller'>): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    const held: HeldRequest = {
      controller: event.controller,
      settle: () => {
        this.#held.delete(held);
        resolve();
      },
    };
    this.#held.add(held);
    event.request.signal.addEventListener('abort', held.settle, { once: true });
    return promise;
  }

  release(): number {
    let released = 0;
    for (const held of [...this.#held]) {
      if (held.controller.readyState === RequestController.PENDING) {
        held.controller.errorWith(new BlackHoleReleased());
        released += 1;
      }
      held.settle();
    }
    return released;
  }
}
