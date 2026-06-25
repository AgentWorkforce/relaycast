import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
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
    const {
      baseUrl: relayServer,
      rejectedAny,
      inconclusiveAny,
    } = await selectEngineForKey(candidates, apiKey);

    if (!relayServer) {
      if (!rejectedAny || inconclusiveAny) {
        return NextResponse.json(
          { success: false, error: 'Unable to validate API key' },
          { status: 503 }
        );
      }

      return NextResponse.json(
        { success: false, error: 'Invalid API key' },
        { status: 401 }
      );
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
