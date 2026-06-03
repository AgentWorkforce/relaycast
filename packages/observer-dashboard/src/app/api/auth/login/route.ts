import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { RelayCast, RelayError } from '@relaycast/sdk';
import {
  resolveRelayServerCandidatesFromRequest,
  selectEngineForKey,
} from '../../../../lib/relay-server';

export const runtime = 'edge';

const COOKIE_NAME = 'relaycast_key';
const AGENT_COOKIE_NAME = 'relaycast_agent_token';
const ENGINE_COOKIE_NAME = 'relaycast_engine';
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

/**
 * POST /api/auth/login
 * Validates the API key against the candidate engines (gateway first, api
 * fallback), remembers the resolved engine, and sets httpOnly cookies.
 * WebSocket stream authenticates directly with the workspace key.
 */
export async function POST(request: NextRequest) {
  try {
    const { apiKey } = await request.json();

    if (!apiKey || !apiKey.startsWith('rk_live_')) {
      return NextResponse.json(
        { success: false, error: 'Invalid API key format' },
        { status: 400 }
      );
    }

    // Always probe the server-configured candidates (prevents SSRF). The first
    // engine that accepts the key wins; gateway is tried before legacy api.
    const candidates = resolveRelayServerCandidatesFromRequest(request);
    const { baseUrl: relayServer } = await selectEngineForKey(candidates, apiKey);

    if (!relayServer) {
      return NextResponse.json(
        { success: false, error: 'Invalid API key' },
        { status: 401 }
      );
    }

    const relay = new RelayCast({ apiKey, baseUrl: relayServer });

    // Enable workspace stream for this workspace so observer dashboard
    // receives realtime event fanout.
    try {
      await relay.workspace.stream.set(true);
    } catch (error) {
      // Best-effort: dashboard can still load and show in-app recovery controls.
      const relayError = error instanceof RelayError ? error : null;
      console.warn('[api/auth/login] Failed to enable workspace stream', {
        detail: relayError
          ? `${relayError.code} (${relayError.status}): ${relayError.message}`
          : error instanceof Error
            ? error.message
            : String(error),
        baseUrl: relayServer,
        host: request.headers.get('host'),
        observerHost: request.headers.get('x-relaycast-observer-host'),
        forwardedHost: request.headers.get('x-forwarded-host'),
      });
    }

    const cookieStore = await cookies();
    const cookieOptions = {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax' as const,
      path: '/',
      maxAge: COOKIE_MAX_AGE,
    };

    cookieStore.set(COOKIE_NAME, apiKey, cookieOptions);

    // Agent cookie remains for compatibility with existing client shape.
    // Workspace keys are accepted by read-only endpoints used in dashboard.
    cookieStore.set(AGENT_COOKIE_NAME, apiKey, cookieOptions);

    // Remember the resolved engine so session/check/logout target it directly
    // without re-probing both engines on every request.
    cookieStore.set(ENGINE_COOKIE_NAME, relayServer, cookieOptions);

    return NextResponse.json({
      success: true,
      apiKey,
      agentToken: apiKey,
      wsToken: apiKey,
      baseUrl: relayServer,
    });
  } catch (error) {
    console.error('[api/auth/login] Error:', error);
    return NextResponse.json(
      { success: false, error: 'Login failed' },
      { status: 500 }
    );
  }
}
