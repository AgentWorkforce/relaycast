const STORAGE_KEY = 'relaycast_api_key';
const SERVER_URL_KEY = 'relaycast_server_url';

export function getApiKey(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(STORAGE_KEY);
}

export function getServerUrl(): string {
  if (typeof window === 'undefined') return '';
  return localStorage.getItem(SERVER_URL_KEY) || 'https://api.relaycast.dev';
}

export function setAuth(apiKey: string, serverUrl?: string): void {
  localStorage.setItem(STORAGE_KEY, apiKey);
  if (serverUrl) localStorage.setItem(SERVER_URL_KEY, serverUrl);
}

export function clearAuth(): void {
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem(SERVER_URL_KEY);
}

export function isAuthenticated(): boolean {
  const key = getApiKey();
  return !!key && key.startsWith('rk_live_');
}

export async function validateApiKey(apiKey: string, serverUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${serverUrl}/v1/workspace`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    return res.ok;
  } catch {
    return false;
  }
}
