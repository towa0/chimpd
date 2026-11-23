export function recordAudit(baseUrl: string, action: string): void {
  void fetch(`${baseUrl}/audit`, { method: 'POST', body: JSON.stringify({ action }) }).then((response) => response.json());
}
