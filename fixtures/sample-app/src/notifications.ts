export async function sendNotification(baseUrl: string, message: string): Promise<boolean> {
  const response = await fetch(`${baseUrl}/notifications`, {
    method: 'POST',
    body: JSON.stringify({ message }),
  });
  return response.ok;
}
