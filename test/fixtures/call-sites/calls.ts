import http from 'node:http';
import { get as namedGet } from 'node:http';

export function viaFetch(input: string | Request, init?: RequestInit): Promise<Response> {
  return fetch(input, init);
}

export function viaHttpRequest(url: string, options: http.RequestOptions = {}): http.ClientRequest {
  const request = http.request(url, options);
  request.on('error', () => undefined);
  return request;
}

export function viaHttpGet(url: string, options: http.RequestOptions = {}): http.ClientRequest {
  const request = http.get(url, options);
  request.on('error', () => undefined);
  return request;
}

export function viaNamedGet(url: string): http.ClientRequest {
  const request = namedGet(url);
  request.on('error', () => undefined);
  return request;
}
