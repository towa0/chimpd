import { getSystemErrorMap } from 'node:util';
import type { InjectedEvent } from './inject.js';

const DEFAULT_PORTS: Readonly<Record<string, string>> = { 'http:': '80', 'https:': '443' };

function refusedErrno(): number | undefined {
  for (const [errno, [name]] of getSystemErrorMap()) if (name === 'ECONNREFUSED') return errno;
  return undefined;
}

/** The error Node raises when nothing listens on the port: the same code, errno, syscall and message. */
export function refusedConnectionError(url: string): NodeJS.ErrnoException {
  const target = new URL(url);
  const address = target.hostname.replace(/^\[|\]$/g, '');
  const port = Number(target.port || DEFAULT_PORTS[target.protocol] || '80');
  const error: NodeJS.ErrnoException & { address?: string; port?: number } = new Error(`connect ECONNREFUSED ${address}:${port}`);
  const errno = refusedErrno();
  if (errno !== undefined) error.errno = errno;
  error.code = 'ECONNREFUSED';
  error.syscall = 'connect';
  error.address = address;
  error.port = port;
  return error;
}

export function refuseConnection(event: InjectedEvent): Error {
  const error = refusedConnectionError(event.request.url);
  event.controller.errorWith(error);
  return error;
}
