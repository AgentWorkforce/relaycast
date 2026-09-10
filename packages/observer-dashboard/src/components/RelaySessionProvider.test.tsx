// @vitest-environment jsdom

/**
 * Integration cover for the `?key=<token>` auto-login flow at the component
 * boundary. The unit tests in `../lib/observer-auto-login.test.ts` pin the
 * request/response contract; this test pins the wiring — that
 * `useSearchParams` is actually read, that the login POST fires with the key
 * from the URL, and that the authenticated children render instead of the
 * spinner. If a future refactor drops the URL reader, drops the `<Suspense>`
 * wrap, or accidentally regresses the effect to skip the login POST, this
 * test fails.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

// Mock `next/navigation` so we don't need a real Next.js route tree. The key
// piece is `useSearchParams` returning an object whose `.get('key')` yields
// the ot_live_ token; the rest of the router is a no-op stub. Both the router
// object and the searchParams object are stable references — the real Next
// hooks return stable identities per navigation, and if we return a fresh
// object each render the provider's useEffect fires in a loop.
const routerReplace = vi.fn();
const stableRouter = {
  replace: routerReplace,
  push: () => undefined,
  prefetch: () => undefined,
  back: () => undefined,
  forward: () => undefined,
  refresh: () => undefined,
};
vi.mock('next/navigation', () => ({
  useRouter: () => stableRouter,
  useSearchParams: () => currentSearchParams,
}));

// Mock the RelayProvider so it does not try to open a real websocket in jsdom.
// The `data-testid` marker is what the test asserts against to confirm the
// authenticated children are rendered.
vi.mock('@relaycast/react', () => ({
  RelayProvider: ({ children, apiKey }: { children: ReactNode; apiKey: string }) => (
    <div data-testid="relay-provider" data-api-key={apiKey}>
      {children}
    </div>
  ),
}));

let currentSearchParams: URLSearchParams = new URLSearchParams();
function setSearchParams(qs: string) {
  currentSearchParams = new URLSearchParams(qs);
}

import { RelaySessionProvider } from './RelaySessionProvider';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('RelaySessionProvider auto-login from ?key=', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    routerReplace.mockReset();
    currentSearchParams = new URLSearchParams();
  });

  it('reads ot_live_ from the URL, POSTs to /login, and renders authenticated children', async () => {
    setSearchParams('key=ot_live_192c87a128285f51a33ba902680ef67a56e6edc2cc79fbe3');

    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      if (url.endsWith('/observer/api/auth/login')) {
        return jsonResponse({ success: true });
      }
      if (url.endsWith('/observer/api/auth/session')) {
        return jsonResponse({
          authenticated: true,
          apiKey: 'ot_live_from_login',
          agentToken: 'ot_live_from_login',
          wsToken: 'ot_live_from_login',
          baseUrl: 'https://cast.agentrelay.com',
        });
      }
      throw new Error(`Unexpected fetch to ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => {
      render(
        <RelaySessionProvider>
          <div data-testid="dashboard-child">dashboard</div>
        </RelaySessionProvider>,
      );
    });

    // The RelayProvider mock renders once the auto-login flow reaches
    // `authenticated`. If the URL reader regresses (key ignored, effect skipped,
    // or router bounces to /login before the POST fires) this wait times out.
    await waitFor(() => {
      expect(screen.getByTestId('relay-provider')).toBeTruthy();
    });
    expect(screen.getByTestId('dashboard-child')).toBeTruthy();
    expect(screen.getByTestId('relay-provider').getAttribute('data-api-key')).toBe(
      'ot_live_from_login',
    );

    // Login POST must include the exact URL-provided token.
    const loginCall = fetchMock.mock.calls.find(
      ([url]) => typeof url === 'string' && url.endsWith('/observer/api/auth/login'),
    );
    expect(loginCall).toBeDefined();
    expect(loginCall?.[1]?.body).toBe(
      JSON.stringify({
        apiKey: 'ot_live_192c87a128285f51a33ba902680ef67a56e6edc2cc79fbe3',
      }),
    );

    // Once authenticated, the URL is cleaned so bookmarks / refresh don't
    // re-POST the key on every reload.
    await waitFor(() => {
      expect(routerReplace).toHaveBeenCalledWith('/');
    });
  });

  it('URL key still takes precedence when the browser has stale session cookies (returning-user shared-link scenario)', async () => {
    // Repro guard for "shared observer links fail on any browser that has
    // ever logged in before". The browser carries stale httpOnly cookies for
    // a revoked session; if the provider probed /session first it would 401
    // and bounce to /login without ever POSTing the URL key. The mock below
    // fails the test loudly if the provider ever calls /session before the
    // URL-key login POST.
    setSearchParams('key=ot_live_shared_link_token');

    const callOrder: string[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      if (url.endsWith('/observer/api/auth/session') && callOrder.length === 0) {
        // Simulated stale-cookies path: /session probed with no prior /login
        // would return 401 in production. Surface this as a test failure so
        // an ordering regression is caught here, not in the field.
        throw new Error(
          '/session probed before /login — URL key must take precedence over stale cookies',
        );
      }
      if (url.endsWith('/observer/api/auth/login') && init?.method === 'POST') {
        callOrder.push('login');
        return jsonResponse({ success: true });
      }
      if (url.endsWith('/observer/api/auth/session')) {
        callOrder.push('session');
        // Post-login /session returns the fresh identity the login route
        // just installed (login's Set-Cookie overwrote the stale cookies).
        return jsonResponse({
          authenticated: true,
          apiKey: 'ot_live_shared_link_token',
          agentToken: 'ot_live_shared_link_token',
          wsToken: 'ot_live_shared_link_token',
          baseUrl: 'https://cast.agentrelay.com',
        });
      }
      throw new Error(`Unexpected fetch to ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => {
      render(
        <RelaySessionProvider>
          <div data-testid="dashboard-child">dashboard</div>
        </RelaySessionProvider>,
      );
    });

    await waitFor(() => {
      expect(screen.getByTestId('relay-provider')).toBeTruthy();
    });
    // The RelayProvider must receive the FRESH URL-supplied identity, not any
    // remnant of the (revoked) cookie session.
    expect(screen.getByTestId('relay-provider').getAttribute('data-api-key')).toBe(
      'ot_live_shared_link_token',
    );
    // Ordering is load-bearing.
    expect(callOrder).toEqual(['login', 'session']);
    // Must not bounce to /login mid-flow.
    expect(routerReplace).not.toHaveBeenCalledWith('/login');
  });

  it('bounces to /login when the URL key is rejected by /login', async () => {
    setSearchParams('key=ot_live_bad');

    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      if (url.endsWith('/observer/api/auth/login')) {
        return new Response(JSON.stringify({ success: false }), { status: 401 });
      }
      throw new Error(`Unexpected fetch to ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => {
      render(
        <RelaySessionProvider>
          <div data-testid="dashboard-child">dashboard</div>
        </RelaySessionProvider>,
      );
    });

    await waitFor(() => {
      expect(routerReplace).toHaveBeenCalledWith('/login');
    });
    expect(screen.queryByTestId('relay-provider')).toBeNull();
  });
});
