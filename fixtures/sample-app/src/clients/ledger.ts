import http from 'node:http';

export interface LedgerEntry {
  account: string;
  amount: number;
}

export function postLedgerEntry(baseUrl: string, entry: LedgerEntry): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      `${baseUrl}/ledger`,
      { method: 'POST', headers: { 'content-type': 'application/json' } },
      (response) => {
        response.resume();
        response.on('end', () => resolve(response.statusCode ?? 0));
      },
    );
    request.on('error', reject);
    request.end(JSON.stringify(entry));
  });
}
