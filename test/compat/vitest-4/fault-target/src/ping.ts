export async function ping(baseUrl: string): Promise<number> {
  const response = await fetch(`${baseUrl}/ping`);
  return response.status;
}
