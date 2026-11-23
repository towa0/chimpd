const ATTEMPTS = 3;

async function searchOnce(url: string): Promise<string[] | null> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(200) });
    return response.ok ? ((await response.json()) as string[]) : null;
  } catch {
    return null;
  }
}

export async function searchProducts(baseUrl: string, query: string): Promise<string[]> {
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    const found = await searchOnce(`${baseUrl}/search?q=${encodeURIComponent(query)}`);
    if (found !== null) return found;
  }
  return [];
}
