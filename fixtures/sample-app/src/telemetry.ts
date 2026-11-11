export function trackEvent(baseUrl: string, name: string): void {
  void fetch(`${baseUrl}/events`, { method: 'POST', body: JSON.stringify({ name }) }).catch(() => undefined);
}
