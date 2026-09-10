/**
 * Auto-login flow for the observer dashboard.
 *
 * The dashboard supports arriving at `/observer?key=<token>` with either a
 * workspace key (`rk_live_...`) or a scoped observer token (`ot_live_...`) in
 * the URL. This module owns the "read the key, POST to /login, then GET the
 * session" sequence so it can be unit-tested without mounting React — the
 * component-level useEffect just calls `resolveObserverSession` and reacts to
 * the outcome.
 *
 * Keeping this shape stable is load-bearing for the "Join as observer" links
 * (which embed an `ot_live_` token in the URL) — the URL param reader has
 * regressed silently in the past because there was no direct test guarding it.
 */
export interface ObserverSessionData {
  apiKey: string;
  agentToken: string;
  /**
   * The realtime-stream credential. Intentionally NOT backfilled from the
   * workspace admin key: the socket must never carry an admin key. `null` means
   * the realtime stream stays offline until the next login.
   */
  wsToken: string | null;
  baseUrl: string;
}

export type AutoLoginOutcome =
  /** A key was present in the URL and the login call accepted it. */
  | { kind: 'authenticated'; consumedKeyParam: true; session: ObserverSessionData }
  /** No key in the URL, but an existing cookie session is still valid. */
  | { kind: 'authenticated'; consumedKeyParam: false; session: ObserverSessionData }
  /** The user must be sent to `/login` (bad key, unauthenticated, or errored). */
  | { kind: 'unauthenticated'; reason: 'invalid-key' | 'no-session' | 'error' };

export interface ResolveObserverSessionOptions {
  /** The `?key=` value from `URLSearchParams`, or null when absent. */
  keyParam: string | null;
  /**
   * Fetch implementation, injectable so tests never touch the real network and
   * production always uses the browser's `fetch`.
   */
  fetchImpl?: typeof fetch;
}

/**
 * Both credential shapes accepted by `/observer/api/auth/login`. The dashboard
 * validates the prefix client-side so an obviously-malformed URL param never
 * even reaches the login route.
 */
export function isAcceptedObserverKey(value: string | null | undefined): value is string {
  return typeof value === 'string' && (value.startsWith('rk_live_') || value.startsWith('ot_live_'));
}

/**
 * Drive the auto-login-then-session sequence.
 *
 * When `keyParam` is a valid credential, POST it to the dashboard's login
 * route to set the httpOnly cookies, then GET the session route to hydrate the
 * `RelayProvider` props. When there is no key, skip straight to the session
 * fetch (existing cookie flow). Any failure lands in `{kind: 'unauthenticated'}`
 * so the caller can redirect to `/login`.
 *
 * ORDERING IS LOAD-BEARING: a valid URL `?key=` MUST hit `/login` before
 * `/session`. Reversing the order breaks the "shared observer link on a
 * returning browser" flow — the returning browser carries cookies from a
 * prior (possibly revoked) session, so a session-first probe would 401 and
 * bounce to `/login` without ever using the URL key. The URL key must take
 * precedence over any existing cookies. Guarded by
 * `observer-auto-login.test.ts` (unit) and `RelaySessionProvider.test.tsx`
 * (integration).
 */
export async function resolveObserverSession(
  opts: ResolveObserverSessionOptions,
): Promise<AutoLoginOutcome> {
  const doFetch = opts.fetchImpl ?? fetch;
  const consumedKeyParam = isAcceptedObserverKey(opts.keyParam);

  try {
    if (consumedKeyParam) {
      const loginRes = await doFetch('/observer/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: opts.keyParam }),
      });
      let loginBody: { success?: boolean } | null = null;
      try {
        loginBody = (await loginRes.json()) as { success?: boolean };
      } catch {
        loginBody = null;
      }
      if (!loginRes.ok || loginBody?.success !== true) {
        return { kind: 'unauthenticated', reason: 'invalid-key' };
      }
    }

    const sessionRes = await doFetch('/observer/api/auth/session');
    if (!sessionRes.ok) {
      return { kind: 'unauthenticated', reason: 'no-session' };
    }
    const data = (await sessionRes.json()) as
      | (ObserverSessionData & { authenticated?: boolean })
      | null;
    if (!data?.authenticated) {
      return { kind: 'unauthenticated', reason: 'no-session' };
    }

    const session: ObserverSessionData = {
      apiKey: data.apiKey,
      agentToken: data.agentToken,
      // Never fall back to the admin/REST key for the socket — a missing stream
      // token means the realtime feed stays offline until re-login.
      wsToken: data.wsToken ?? null,
      baseUrl: data.baseUrl,
    };

    if (consumedKeyParam) {
      return { kind: 'authenticated', consumedKeyParam: true, session };
    }
    return { kind: 'authenticated', consumedKeyParam: false, session };
  } catch {
    return { kind: 'unauthenticated', reason: 'error' };
  }
}
