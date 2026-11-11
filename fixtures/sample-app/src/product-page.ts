import { checkStock, type Stock } from './clients/inventory.js';

export interface ProductPage {
  sku: string;
  stock: Stock;
}

export async function productPage(baseUrl: string, sku: string): Promise<ProductPage> {
  return { sku, stock: await checkStock(baseUrl, sku) };
}
