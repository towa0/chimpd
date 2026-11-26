import type { HttpRequestEvent } from '@mswjs/interceptors';
import { ClientRequestInterceptor } from '@mswjs/interceptors/ClientRequest';
import { FetchInterceptor } from '@mswjs/interceptors/fetch';
import http from 'node:http';
import { installCallCapture, metadataFor, type CallCapture, type CallMetadata } from './call-capture.js';
import { watchFetchResponse, watchHttpResponse, type ResponseWatch } from './response-use.js';
import type { InterceptionPath } from './interception.js';

export type InjectedEvent = Pick<HttpRequestEvent, 'request' | 'controller' | 'initiator'>;

/** Answers one targeted call at once, through the event's controller; returns the error it raised, if it raised one. */
export type Injector = (event: InjectedEvent) => Error | undefined;

export interface InjectionOptions {
  /** Decides per call whether it gets the fault; a call that does not reaches the network untouched. */
  readonly shouldInject: (metadata: CallMetadata | null) => boolean;
  readonly inject: Injector;
  readonly onCall?: (metadata: CallMetadata) => void;
  /** Sees every call that got the fault, after it was answered, with the error the fault raised, if any. */
  readonly onInjected?: (event: InjectedEvent, metadata: CallMetadata | null, raised: Error | undefined) => void;
  /** Watches what the code does with the response of each faulted call; the watch starts before the code sees it. */
  readonly onResponse?: (metadata: CallMetadata, watch: ResponseWatch) => void;
}

export interface Injection {
  readonly wrappers: CallCapture['wrappers'];
  dispose(): void;
}

/**
 * Unlike the black hole, nothing claims the connection: the HTTP interceptors complete a call
 * they answer themselves, and every other call opens its real connection.
 */
export function installInjection(paths: readonly InterceptionPath[], options: InjectionOptions): Injection {
  const interceptors = paths.map((path) => (path === 'fetch' ? new FetchInterceptor() : new ClientRequestInterceptor()));
  for (const interceptor of interceptors) {
    interceptor.apply();
    interceptor.on('request', (event) => {
      const metadata = metadataFor(event.initiator);
      if (!options.shouldInject(metadata)) return;
      const raised = options.inject(event);
      options.onInjected?.(event, metadata, raised);
    });
  }
  const { onResponse } = options;
  const capture = installCallCapture({
    ...(options.onCall === undefined ? {} : { onCall: options.onCall }),
    needsFreshConnection: options.shouldInject,
    ...(onResponse === undefined
      ? {}
      : {
          responses: {
            watches: options.shouldInject,
            onResponse: (metadata: CallMetadata, response: Response | http.IncomingMessage) =>
              onResponse(metadata, response instanceof http.IncomingMessage ? watchHttpResponse(response) : watchFetchResponse(response)),
          },
        }),
  });
  let disposed = false;
  return {
    wrappers: capture.wrappers,
    dispose() {
      if (disposed) return;
      disposed = true;
      capture.restore();
      for (const interceptor of interceptors) interceptor.dispose();
    },
  };
}
