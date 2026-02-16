const SERVER_URL_KEY = 'relaycast_server_url';

export function getServerUrl(): string {
  if (typeof window === 'undefined') return '';
  return localStorage.getItem(SERVER_URL_KEY) || 'https://api.relaycast.dev';
}

/**
 * Authenticate via server-side endpoint which sets an httpOnly cookie.
 * Returns true on success.
 */
export async function setAuth(apiKey: string, serverUrl?: string): Promise<boolean> {
  if (serverUrl) localStorage.setItem(SERVER_URL_KEY, serverUrl);
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey, serverUrl }),
    });
    const data = await res.json();
    return data.success === true;
  } catch {
    return false;
  }
}

/**
 * Clear auth by calling server-side logout (removes httpOnly cookie).
 */
export async function clearAuth(): Promise<void> {
  localStorage.removeItem(SERVER_URL_KEY);
  try {
    await fetch('/api/auth/logout', { method: 'POST' });
  } catch {
    // Best effort
  }
}

/**
 * Check if user is authenticated by querying the server.
 * The httpOnly cookie is sent automatically.
 */
export async function isAuthenticated(): Promise<boolean> {
  try {
    const res = await fetch('/api/auth/check');
    return res.ok;
  } catch {
    return false;
  }
}
