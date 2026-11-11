export interface Profile {
  id: string;
  name: string;
}

export async function fetchProfile(baseUrl: string, id: string): Promise<Profile> {
  const response = await fetch(`${baseUrl}/profiles/${id}`);
  if (!response.ok) {
    throw new Error(`profile request failed with ${response.status}`);
  }
  return (await response.json()) as Profile;
}
