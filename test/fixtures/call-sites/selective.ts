import http from 'node:http';

export function heldFetch(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, init);
}

export function openFetch(url: string): Promise<Response> {
  return fetch(url);
}

export function heldRequest(url: string, options: http.RequestOptions = {}): http.ClientRequest {
  const request = http.request(url, options);
  request.on('error', () => undefined);
  return request;
}

export function openRequest(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = http.request(url, (response) => {
      response.resume();
      response.on('end', () => resolve(response.statusCode ?? 0));
    });
    request.on('error', reject);
    request.end();
  });
}
