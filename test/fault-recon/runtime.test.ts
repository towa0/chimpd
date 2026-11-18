import { AsyncResource } from 'node:async_hooks';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Interceptor } from '@mswjs/interceptors';
import { SocketInterceptor } from '@mswjs/interceptors/net';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { pristineFingerprints } from '../../src/fault-recon/conflicts.js';
import { startRuntime, type RunnerPrototype, type RunnerTask } from '../../src/fault-recon/runtime.js';
import { heldFetch } from '../fixtures/call-sites/selective.js';
import { repoRoot } from '../helpers/temp-repo.js';

const SITE_FILE = 'test/fixtures/call-sites/selective.ts';
const SOCKET_PENDING = 0;

let server: http.Server;
let url: string;
let eventsDir: string;

beforeAll(async () => {
  server = http.createServer((request, response) => {
    request.resume();
    response.end('ok');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/resource`;
  eventsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chimpd-runtime-'));
});

afterAll(() => {
  server.closeAllConnections();
  server.close();
  fs.rmSync(eventsDir, { recursive: true, force: true });
});

function heldFetchSite(): string {
  const lines = fs.readFileSync(path.join(repoRoot, SITE_FILE), 'utf8').split('\n');
  const index = lines.findIndex((line) => line.includes('return fetch(url, init)'));
  return `${SITE_FILE}:${index + 1}:${(lines[index] ?? '').indexOf('fetch(') + 1}`;
}

function connectionStateIn(scope: AsyncResource, port: number): Promise<number> {
  const sockets = Interceptor.singleton(SocketInterceptor);
  return new Promise((resolve) => {
    const listener: Parameters<typeof sockets.on<'connection'>>[1] = ({ controller, socket }) => {
      sockets.removeListener('connection', listener);
      resolve(controller.readyState);
      socket.destroy();
    };
    sockets.on('connection', listener);
    scope.runInAsyncScope(() => net.connect(port, '127.0.0.1').on('error', () => undefined));
  });
}

it('does not claim a connection opened in the context of a body that has ended', async () => {
  const teardowns: (() => void)[] = [];
  const runner: RunnerPrototype = {};
  let stale: AsyncResource | undefined;
  // Request construction runs inside the call's async scope, like the reconnects a client pool makes later.
  const input = {
    toString() {
      stale ??= new AsyncResource('chimpd-stale-call');
      return url;
    },
  };
  const task: RunnerTask = { id: 'body', file: { filepath: path.join(repoRoot, 'body.ts') }, context: { skip() {} } };

  startRuntime(
    {
      afterAll: (listener) => teardowns.push(listener),
      runner,
      getTestFn: () => () => {
        void heldFetch(input as unknown as string).catch(() => undefined);
      },
    },
    {
      eventsDir,
      pristine: await pristineFingerprints(),
      mode: { kind: 'fault', targetRoot: repoRoot, siteKey: heldFetchSite(), testIds: [task.id], deadlineMs: 10_000 },
    },
  );
  try {
    await runner.runTask?.(task);
    const end = fs
      .readdirSync(eventsDir)
      .flatMap((entry) => fs.readFileSync(path.join(eventsDir, entry), 'utf8').split('\n'))
      .filter((line) => line.includes('"body-end"'));
    expect(end).toHaveLength(1);
    expect(JSON.parse(end[0] ?? '{}')).toMatchObject({ targetedCalls: 1, observations: [{ requestState: 'pending' }] });
    expect(stale).toBeDefined();

    const state = await connectionStateIn(stale as AsyncResource, (server.address() as AddressInfo).port);
    expect(state).toBe(SOCKET_PENDING);
  } finally {
    for (const teardown of teardowns) teardown();
  }
});
