import type { InjectedEvent } from './inject.js';

/** A body cut off mid-object; it is unique, so a parse of exactly this text is a parse of the faulted body. */
export const MALFORMED_BODY = '{"chimpd-malformed-json":';

export function respondWithMalformedJson(event: InjectedEvent): void {
  event.controller.respondWith(new Response(MALFORMED_BODY, { status: 200, headers: { 'content-type': 'application/json' } }));
}

/** Calls onParse each time JSON.parse is handed the malformed body, until the returned function restores it. */
export function watchJsonParse(onParse: () => void): () => void {
  const original = JSON.parse;
  const wrapper = function (this: unknown, ...args: unknown[]): unknown {
    if (args.length > 0 && String(args[0]).trim() === MALFORMED_BODY) onParse();
    return Reflect.apply(original, this, args);
  };
  JSON.parse = wrapper as typeof JSON.parse;
  return () => {
    if (JSON.parse === wrapper) JSON.parse = original;
  };
}
