import type { InjectedEvent } from './inject.js';

/** A body cut off mid-object; it is unique, so a parse of exactly this text is a parse of the faulted body. */
export const MALFORMED_BODY = '{"bruise-malformed-json":';

export function respondWithMalformedJson(event: InjectedEvent): undefined {
  event.controller.respondWith(new Response(MALFORMED_BODY, { status: 200, headers: { 'content-type': 'application/json' } }));
}

export interface ParseWatch {
  /** Called each time JSON.parse is handed the body. */
  readonly onParse?: () => void;
  /** Called with the error JSON.parse threw for the body, before it is thrown on. */
  readonly onError?: (error: unknown) => void;
}

/** Watches JSON.parse being handed exactly this body, until the returned function restores it. */
export function watchJsonParse(body: string, watch: ParseWatch): () => void {
  const original = JSON.parse;
  const wrapper = function (this: unknown, ...args: unknown[]): unknown {
    if (args.length === 0 || String(args[0]).trim() !== body) return Reflect.apply(original, this, args);
    watch.onParse?.();
    try {
      return Reflect.apply(original, this, args);
    } catch (error) {
      watch.onError?.(error);
      throw error;
    }
  };
  JSON.parse = wrapper as typeof JSON.parse;
  return () => {
    if (JSON.parse === wrapper) JSON.parse = original;
  };
}
