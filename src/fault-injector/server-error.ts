import type { InjectedEvent } from './inject.js';

export const SERVER_ERROR_BODY = 'Internal Server Error';

export function respondWithServerError(event: InjectedEvent): void {
  event.controller.respondWith(
    new Response(SERVER_ERROR_BODY, { status: 500, statusText: 'Internal Server Error', headers: { 'content-type': 'text/plain' } }),
  );
}
