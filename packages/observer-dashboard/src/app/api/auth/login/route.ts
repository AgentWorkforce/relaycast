import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import {
  resolveRelayServerCandidatesFromRequest,
  selectEngineForKey,
} from '../../../../lib/relay-server';
import { mintObserverStreamToken } from '../../../../lib/observer-token';

export const runtime = 'edge';

const COOKIE_NAME = 'relaycast_key';
const AGENT_COOKIE_NAME = 'relaycast_agent_token';
const WS_TOKEN_COOKIE_NAME = 'relaycast_ws_token';
const ENGINE_COOKIE_NAME = 'relaycast_engine';
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

/**
 * POST /api/auth/login
 * Validates the API key against the candidate engines (gateway first, api
 * fallback), remembers the resolved engine, and sets httpOnly cookies.
 *
 * Accepts either a full workspace key (`rk_live_...`) or a scoped, read-only
 * observer token (`ot_live_...`). The credential is used for read-only REST
 * (the engine enforces observer scope restrictions on every request), but the
 * realtime endpoint (`GET /v1/ws`) accepts *only* an observer token with
 * `stream:read`. So when the login credential is a workspace key we mint (or
 * reuse) a scoped observer token here and use that as the stream credential;
 * an `ot_live_` login already works on the stream directly.
 */
export async function POST(request: NextRequest) {
  try {
    const { apiKey } = await request.json();

    if (typeof apiKey !== 'string' || (!apiKey.startsWith('rk_live_') && !apiKey.startsWith('ot_live_'))) {
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

    // The workspace stream requires an observer token. A workspace-key login
    // mints one on the operator's behalf; an observer-token login is already a
    // valid stream credential. On mint failure, fall back to the login
    // credential so REST-only login still succeeds (the stream will be refused
    // by the engine, but that is no worse than not attempting the mint).
    let wsToken = apiKey;
    if (apiKey.startsWith('rk_live_')) {
      const minted = await mintObserverStreamToken(relayServer, apiKey);
      if (minted) {
        wsToken = minted;
      } else {
        console.error(
          '[api/auth/login] Failed to mint observer stream token for workspace key'
        );
      }
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
    // Both workspace keys and observer tokens are accepted by the read-only
    // endpoints used in this dashboard.
    cookieStore.set(AGENT_COOKIE_NAME, apiKey, cookieOptions);

    // Stream credential (observer token) kept separate from the REST key so the
    // realtime socket never carries a workspace admin key.
    cookieStore.set(WS_TOKEN_COOKIE_NAME, wsToken, cookieOptions);

    // Remember the resolved engine so session/check/logout target it directly
    // without re-probing both engines on every request.
    cookieStore.set(ENGINE_COOKIE_NAME, relayServer, cookieOptions);

    return NextResponse.json({
      success: true,
      apiKey,
      agentToken: apiKey,
      wsToken,
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
