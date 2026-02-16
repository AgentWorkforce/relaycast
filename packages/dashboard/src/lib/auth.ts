/**
 * Authenticate via server-side endpoint which sets an httpOnly cookie.
 * Returns true on success.
 */
export async function setAuth(apiKey: string): Promise<boolean> {
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey }),
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
