import { fetchExchangeRate } from './clients/rates.js';

export async function priceIn(baseUrl: string, amount: number, currency: string): Promise<number> {
  const rate = await fetchExchangeRate(baseUrl, currency);
  return Math.round(amount * rate * 100) / 100;
}
