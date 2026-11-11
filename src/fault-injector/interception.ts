import { Interceptor } from '@mswjs/interceptors';
import { ClientRequestInterceptor } from '@mswjs/interceptors/ClientRequest';
import { FetchInterceptor } from '@mswjs/interceptors/fetch';
import { SocketInterceptor } from '@mswjs/interceptors/net';
import { BlackHole } from './blackhole.js';
import { installCallCapture, type CallCapture } from './call-capture.js';

export type InterceptionPath = 'fetch' | 'client-request';

export interface BlackHoleInterception {
  readonly blackHole: BlackHole;
  readonly wrappers: CallCapture['wrappers'];
  dispose(): void;
}

// SocketController.PENDING; the class is not exported from the package.
const SOCKET_PENDING = 0;

export function installBlackHole(paths: readonly InterceptionPath[]): BlackHoleInterception {
  const blackHole = new BlackHole();
  const interceptors = paths.map((path) =>
    path === 'fetch' ? new FetchInterceptor() : new ClientRequestInterceptor(),
  );
  for (const interceptor of interceptors) {
    interceptor.apply();
    interceptor.on('request', (event) => blackHole.hold(event));
  }

  // Claiming completes the mock connection, so the black hole is a server that accepts and
  // then stays silent. This listener must be added after the HTTP interceptors are applied:
  // their own connection listener has to see the socket first to parse requests from it.
  const sockets = Interceptor.singleton(SocketInterceptor);
  const owner = {};
  const claim: Parameters<typeof sockets.on<'connection'>>[1] = ({ controller }) => {
    if (controller.readyState === SOCKET_PENDING) controller.claim();
  };
  sockets.apply(owner);
  sockets.on('connection', claim);

  const capture = installCallCapture();

  return {
    blackHole,
    wrappers: capture.wrappers,
    dispose() {
      blackHole.release();
      capture.restore();
      sockets.removeListener('connection', claim);
      sockets.dispose(owner);
      for (const interceptor of interceptors) interceptor.dispose();
    },
  };
}
