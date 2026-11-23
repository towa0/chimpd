import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface TestServer {
  url: string;
  /** Method and path of every request whose response has been sent. */
  handled: string[];
  close(): Promise<void>;
}

export type Routes = Record<string, { status?: number; body: unknown }>;

export async function startServer(routes: Routes): Promise<TestServer> {
  const handled: string[] = [];
  const server = http.createServer((request, response) => {
    request.resume();
    response.on('finish', () => handled.push(`${request.method} ${request.url}`));
    const route = routes[`${request.method} ${request.url}`];
    response.writeHead(route?.status ?? (route ? 200 : 404), { 'content-type': 'application/json' });
    response.end(JSON.stringify(route?.body ?? null));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    handled,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
