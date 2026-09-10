/**
 * Guardrails for the `?key=<token>` auto-login flow.
 *
 * The observer dashboard supports arriving at `/observer?key=ot_live_...` (or
 * `rk_live_...`) — the "Join as observer" links depend on this shape and it
 * has silently regressed before. These tests pin every branch of
 * `resolveObserverSession` so a future refactor that drops the URL reader
 * or reshapes the login/session round-trip fails loudly.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isAcceptedObserverKey,
  resolveObserverSession,
} from './observer-auto-login';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function stubFetchSequence(...responses: Array<Response | Error>) {
  const fetchMock = vi.fn<typeof fetch>();
  for (const response of responses) {
    if (response instanceof Error) {
      fetchMock.mockRejectedValueOnce(response);
    } else {
      fetchMock.mockResolvedValueOnce(response);
    }
  }
  return fetchMock;
}

describe('isAcceptedObserverKey', () => {
  it('accepts workspace and observer tokens', () => {
    expect(isAcceptedObserverKey('rk_live_abc')).toBe(true);
    expect(isAcceptedObserverKey('ot_live_xyz')).toBe(true);
  });

  it('rejects anything else, including nullish values', () => {
    expect(isAcceptedObserverKey(null)).toBe(false);
    expect(isAcceptedObserverKey(undefined)).toBe(false);
    expect(isAcceptedObserverKey('')).toBe(false);
    expect(isAcceptedObserverKey('rk_test_abc')).toBe(false);
    expect(isAcceptedObserverKey('ot_test_abc')).toBe(false);
    expect(isAcceptedObserverKey('Bearer ot_live_abc')).toBe(false);
  });
});

describe('resolveObserverSession', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('auto-logs-in with an ot_live_ token from the URL and hydrates the session', async () => {
    const fetchImpl = stubFetchSequence(
      jsonResponse({ success: true }),
      jsonResponse({
        authenticated: true,
        apiKey: 'ot_live_from_url',
        agentToken: 'ot_live_from_url',
        wsToken: 'ot_live_from_url',
        baseUrl: 'https://cast.agentrelay.com',
      }),
    );

    const outcome = await resolveObserverSession({
      keyParam: 'ot_live_192c87a128285f51a33ba902680ef67a56e6edc2cc79fbe3',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    // The login POST must fire with the exact URL-provided token — this is the
    // reader that regressed silently in the past.
    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      '/observer/api/auth/login',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          apiKey: 'ot_live_192c87a128285f51a33ba902680ef67a56e6edc2cc79fbe3',
        }),
      }),
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(2, '/observer/api/auth/session');
    expect(outcome).toEqual({
      kind: 'authenticated',
      consumedKeyParam: true,
      session: {
        apiKey: 'ot_live_from_url',
        agentToken: 'ot_live_from_url',
        wsToken: 'ot_live_from_url',
        baseUrl: 'https://cast.agentrelay.com',
      },
    });
  });

  it('auto-logs-in with an rk_live_ workspace key from the URL', async () => {
    const fetchImpl = stubFetchSequence(
      jsonResponse({ success: true }),
      jsonResponse({
        authenticated: true,
        apiKey: 'rk_live_admin',
        agentToken: 'rk_live_admin',
        // Login route mints a scoped `ot_live_` token for the stream so the
        // socket never carries the admin key.
        wsToken: 'ot_live_minted_for_stream',
        baseUrl: 'https://cast.agentrelay.com',
      }),
    );

    const outcome = await resolveObserverSession({
      keyParam: 'rk_live_admin',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(outcome).toMatchObject({
      kind: 'authenticated',
      consumedKeyParam: true,
      session: { wsToken: 'ot_live_minted_for_stream' },
    });
  });

  it('signals unauthenticated when the login POST rejects the URL key', async () => {
    const fetchImpl = stubFetchSequence(
      new Response(JSON.stringify({ success: false, error: 'Invalid API key' }), {
        status: 401,
      }),
    );

    const outcome = await resolveObserverSession({
      keyParam: 'ot_live_bad',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    // Must not fall through to the session route on a rejected login — that
    // would either 401 or return the previous session's identity.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ kind: 'unauthenticated', reason: 'invalid-key' });
  });

  it('signals unauthenticated when login returns 200 but success=false', async () => {
    const fetchImpl = stubFetchSequence(jsonResponse({ success: false }));

    const outcome = await resolveObserverSession({
      keyParam: 'ot_live_stale',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(outcome).toEqual({ kind: 'unauthenticated', reason: 'invalid-key' });
  });

  it('skips the login POST when no key is present and returns the existing session', async () => {
    const fetchImpl = stubFetchSequence(
      jsonResponse({
        authenticated: true,
        apiKey: 'rk_live_from_cookie',
        agentToken: 'rk_live_from_cookie',
        wsToken: 'ot_live_from_cookie',
        baseUrl: 'https://cast.agentrelay.com',
      }),
    );

    const outcome = await resolveObserverSession({
      keyParam: null,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith('/observer/api/auth/session');
    expect(outcome).toEqual({
      kind: 'authenticated',
      consumedKeyParam: false,
      session: {
        apiKey: 'rk_live_from_cookie',
        agentToken: 'rk_live_from_cookie',
        wsToken: 'ot_live_from_cookie',
        baseUrl: 'https://cast.agentrelay.com',
      },
    });
  });

  it('ignores an obviously-malformed key param and probes the session cookie instead', async () => {
    // e.g. `?key=` followed by a stray value from a bookmark or referer; the
    // dashboard should not POST that upstream, but must still probe the
    // existing cookie session so a returning user is not falsely bounced.
    const fetchImpl = stubFetchSequence(
      jsonResponse({
        authenticated: true,
        apiKey: 'rk_live_from_cookie',
        agentToken: 'rk_live_from_cookie',
        wsToken: null,
        baseUrl: 'https://cast.agentrelay.com',
      }),
    );

    const outcome = await resolveObserverSession({
      keyParam: 'not-a-token',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith('/observer/api/auth/session');
    expect(outcome).toMatchObject({
      kind: 'authenticated',
      consumedKeyParam: false,
      session: { wsToken: null },
    });
  });

  it('signals unauthenticated when the session probe returns 401', async () => {
    const fetchImpl = stubFetchSequence(
      new Response(JSON.stringify({ authenticated: false }), { status: 401 }),
    );

    const outcome = await resolveObserverSession({
      keyParam: null,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(outcome).toEqual({ kind: 'unauthenticated', reason: 'no-session' });
  });

  it('signals unauthenticated when the session probe returns 200 but authenticated=false', async () => {
    const fetchImpl = stubFetchSequence(jsonResponse({ authenticated: false }));

    const outcome = await resolveObserverSession({
      keyParam: null,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(outcome).toEqual({ kind: 'unauthenticated', reason: 'no-session' });
  });

  it('never falls back to the admin key when the session omits wsToken', async () => {
    // Sessions created before the minted-token cookie existed have no wsToken;
    // the resolver must leave it null so the socket declines to connect rather
    // than opening with the admin/REST key.
    const fetchImpl = stubFetchSequence(
      jsonResponse({
        authenticated: true,
        apiKey: 'rk_live_legacy',
        agentToken: 'rk_live_legacy',
        // wsToken intentionally absent
        baseUrl: 'https://cast.agentrelay.com',
      }),
    );

    const outcome = await resolveObserverSession({
      keyParam: null,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    if (outcome.kind !== 'authenticated') {
      throw new Error('expected authenticated outcome');
    }
    expect(outcome.session.wsToken).toBeNull();
  });

  it('collapses network errors into an unauthenticated outcome so the UI can redirect', async () => {
    const fetchImpl = stubFetchSequence(new Error('network down'));

    const outcome = await resolveObserverSession({
      keyParam: 'ot_live_abc',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(outcome).toEqual({ kind: 'unauthenticated', reason: 'error' });
  });

  it('shared observer link auto-logs-in even when the browser already has stale cookies for a revoked session', async () => {
    // Repro guard for the "shared link fails on returning browsers" report:
    // the browser has cookies from a prior (now-revoked) session, so a naive
    // session-first flow would 401 and bounce to /login without ever using
    // the URL key. The URL key MUST take precedence — we assert the login
    // POST fires first (with the fresh URL key), the follow-up session GET
    // returns the *new* identity (because login overwrote the cookies), and
    // no unauthenticated outcome slips through.
    //
    // We simulate the request sequence directly: fetch #1 is the login POST
    // (must fire before any session probe), fetch #2 is the session GET
    // (must see the new identity established by login).
    const callOrder: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      if (url === '/observer/api/auth/login') {
        callOrder.push('login');
        // Login accepts the URL key and (in production) overwrites the stale
        // cookies via Set-Cookie. Signal success back to the resolver.
        return jsonResponse({ success: true });
      }
      if (url === '/observer/api/auth/session') {
        if (callOrder.length === 0) {
          // If, hypothetically, session were probed BEFORE login, the stale
          // cookies would come back as 401. Fail the test loudly so any future
          // ordering regression is caught here rather than in production.
          throw new Error(
            'session probed before login — URL key must take precedence over stale cookies',
          );
        }
        callOrder.push('session');
        // Post-login session probe. In production the browser now carries
        // the fresh cookies; we return the fresh identity that the login
        // route just installed.
        return jsonResponse({
          authenticated: true,
          apiKey: 'ot_live_fresh_from_url',
          agentToken: 'ot_live_fresh_from_url',
          wsToken: 'ot_live_fresh_from_url',
          baseUrl: 'https://cast.agentrelay.com',
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const outcome = await resolveObserverSession({
      keyParam: 'ot_live_fresh_from_url',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    // The URL key wins over the (stale) cookie session.
    expect(outcome).toEqual({
      kind: 'authenticated',
      consumedKeyParam: true,
      session: {
        apiKey: 'ot_live_fresh_from_url',
        agentToken: 'ot_live_fresh_from_url',
        wsToken: 'ot_live_fresh_from_url',
        baseUrl: 'https://cast.agentrelay.com',
      },
    });

    // Ordering is load-bearing: login FIRST, then session. Reversing this
    // is the exact regression the report describes.
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('/observer/api/auth/login');
    expect(fetchImpl.mock.calls[1]?.[0]).toBe('/observer/api/auth/session');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
