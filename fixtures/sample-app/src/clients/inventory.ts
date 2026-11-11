export type Stock =
  | { available: true; quantity: number }
  | { available: false; reason: 'timeout' | 'error' };

export async function checkStock(baseUrl: string, sku: string): Promise<Stock> {
  try {
    const response = await fetch(`${baseUrl}/stock/${sku}`, { signal: AbortSignal.timeout(100) });
    const body = (await response.json()) as { quantity: number };
    return { available: true, quantity: body.quantity };
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'TimeoutError';
    return { available: false, reason: timedOut ? 'timeout' : 'error' };
  }
}
