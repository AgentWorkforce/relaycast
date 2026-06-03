import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import {
  orderByRemembered,
  pickRememberedEngine,
  resolveRelayServerCandidatesFromRequest,
  selectEngineForKey,
} from '../../../../lib/relay-server';

export const runtime = 'edge';

const COOKIE_NAME = 'relaycast_key';
const AGENT_COOKIE_NAME = 'relaycast_agent_token';
const ENGINE_COOKIE_NAME = 'relaycast_engine';
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

/**
 * GET /api/auth/check
 * Validates the auth cookie against the candidate engines (remembered one
 * first, then gateway/api fallback).
 */
export async function GET(request: NextRequest) {
  const cookieStore = await cookies();
  const cookie = cookieStore.get(COOKIE_NAME);

  if (!cookie?.value || !cookie.value.startsWith('rk_live_')) {
    return NextResponse.json(
      { authenticated: false },
      { status: 401 }
    );
  }

  const candidates = resolveRelayServerCandidatesFromRequest(request);
  const remembered = pickRememberedEngine(
    cookieStore.get(ENGINE_COOKIE_NAME)?.value,
    candidates
  );
  const { baseUrl, reachedAny } = await selectEngineForKey(
    orderByRemembered(candidates, remembered),
    cookie.value
  );

  if (baseUrl) {
    if (baseUrl !== remembered) {
      cookieStore.set(ENGINE_COOKIE_NAME, baseUrl, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/',
        maxAge: COOKIE_MAX_AGE,
      });
    }
    return NextResponse.json({ authenticated: true });
  }

  if (reachedAny) {
    // An engine responded and rejected the key — it is revoked or invalid.
    cookieStore.delete(COOKIE_NAME);
    cookieStore.delete(AGENT_COOKIE_NAME);
    cookieStore.delete(ENGINE_COOKIE_NAME);
    return NextResponse.json(
      { authenticated: false },
      { status: 401 }
    );
  }

  // No engine reachable — allow the session to continue
  // (downstream API calls will fail with proper errors).
  return NextResponse.json({ authenticated: true });
}
