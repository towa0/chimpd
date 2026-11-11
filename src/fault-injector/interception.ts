import { ClientRequestInterceptor } from '@mswjs/interceptors/ClientRequest';
import { FetchInterceptor } from '@mswjs/interceptors/fetch';
import { BlackHole } from './blackhole.js';

export type InterceptionPath = 'fetch' | 'client-request';

export interface BlackHoleInterception {
  readonly blackHole: BlackHole;
  dispose(): void;
}

export function installBlackHole(paths: readonly InterceptionPath[]): BlackHoleInterception {
  const blackHole = new BlackHole();
  const interceptors = paths.map((path) =>
    path === 'fetch' ? new FetchInterceptor() : new ClientRequestInterceptor(),
  );
  for (const interceptor of interceptors) {
    interceptor.apply();
    interceptor.on('request', (event) => blackHole.hold(event));
  }
  return {
    blackHole,
    dispose() {
      blackHole.release();
      for (const interceptor of interceptors) interceptor.dispose();
    },
  };
}
