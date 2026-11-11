export async function fetchExchangeRate(baseUrl: string, currency: string): Promise<number> {
  const response = await fetch(`${baseUrl}/rates/${currency}`);
  const body = (await response.json()) as { rate: number };
  return body.rate;
}
