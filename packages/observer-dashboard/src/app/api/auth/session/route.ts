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
 * GET /api/auth/session
 * Returns session tokens for the RelayProvider, resolving the engine the
 * workspace lives on (the remembered one first, then gateway/api fallback).
 * Called by the client on mount/refresh.
 */
export async function GET(request: NextRequest) {
  const cookieStore = await cookies();
  const apiKey = cookieStore.get(COOKIE_NAME)?.value;
  const agentToken = cookieStore.get(AGENT_COOKIE_NAME)?.value;

  if (!apiKey) {
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
  const {
    baseUrl,
    rejectedAny,
    inconclusiveAny,
  } = await selectEngineForKey(
    orderByRemembered(candidates, remembered),
    apiKey
  );

  if (!baseUrl) {
    if (!rejectedAny || inconclusiveAny) {
      return NextResponse.json(
        { authenticated: false, error: 'Unable to validate session' },
        { status: 503 }
      );
    }

    return NextResponse.json(
      { authenticated: false },
      { status: 401 }
    );
  }

  if (baseUrl !== remembered) {
    cookieStore.set(ENGINE_COOKIE_NAME, baseUrl, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: COOKIE_MAX_AGE,
    });
  }

  return NextResponse.json({
    authenticated: true,
    apiKey,
    agentToken: agentToken ?? apiKey,
    wsToken: apiKey,
    baseUrl,
  });
}
