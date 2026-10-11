import { classifyConnectObserverStatus, type ConnectObserverFailure } from './connect-observer';

/**
 * Authenticate via server-side endpoint which sets httpOnly cookies.
 * Returns true on success.
 */
export async function setAuth(apiKey: string, options?: { connectObserverId?: string }): Promise<boolean> {
  return (await login(apiKey, options)).ok;
}

/**
 * Logs in and says why it failed: the login route answers 401/400 when the
 * engine rejected the credential, and 503 when it could not validate it (a
 * rate limit or an engine outage), which must not read as a revoked link.
 */
export async function login(
  apiKey: string,
  options?: { connectObserverId?: string },
): Promise<{ ok: true } | { ok: false; failure: ConnectObserverFailure }> {
  let res: Response;
  try {
    res = await fetch('/observer/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apiKey,
        ...(options?.connectObserverId ? { connectObserverId: options.connectObserverId } : {}),
      }),
    });
  } catch {
    return { ok: false, failure: 'temporary' };
  }
  const data = await res.json().catch(() => null) as { success?: unknown } | null;
  if (res.ok && data?.success === true) return { ok: true };
  return { ok: false, failure: res.ok ? 'revoked' : classifyConnectObserverStatus(res.status) };
}

/**
 * Clear auth by calling server-side logout (removes httpOnly cookies).
 */
export async function clearAuth(): Promise<void> {
  try {
    await fetch('/observer/api/auth/logout', { method: 'POST' });
  } catch {
    // Best effort
  }
}
