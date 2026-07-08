import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import {
  pickRememberedEngine,
  resolveRelayServerCandidatesFromRequest,
} from '../../../../lib/relay-server';
import { revokeObserverStreamToken } from '../../../../lib/observer-token';

export const runtime = 'edge';

const COOKIE_NAME = 'relaycast_key';
const AGENT_COOKIE_NAME = 'relaycast_agent_token';
const WS_TOKEN_COOKIE_NAME = 'relaycast_ws_token';
const WS_TOKEN_ID_COOKIE_NAME = 'relaycast_ws_token_id';
const ENGINE_COOKIE_NAME = 'relaycast_engine';

/**
 * POST /api/auth/logout
 * Revokes the observer token minted for this session (best effort) and clears
 * auth cookies.
 */
export async function POST(request: NextRequest) {
  const cookieStore = await cookies();

  // Best-effort: revoke the minted observer token so a leaked ws cookie value
  // stops working immediately instead of lingering until its 30-day expiry.
  // Only workspace-key sessions mint a token (and store its id + the admin key
  // needed to revoke it); `ot_live_` logins have no id cookie and are skipped.
  const wsTokenId = cookieStore.get(WS_TOKEN_ID_COOKIE_NAME)?.value;
  const adminKey = cookieStore.get(COOKIE_NAME)?.value;
  if (wsTokenId && adminKey?.startsWith('rk_live_')) {
    const baseUrl = pickRememberedEngine(
      cookieStore.get(ENGINE_COOKIE_NAME)?.value,
      resolveRelayServerCandidatesFromRequest(request)
    );
    if (baseUrl) {
      await revokeObserverStreamToken(baseUrl, adminKey, wsTokenId);
    }
  }

  cookieStore.delete(COOKIE_NAME);
  cookieStore.delete(AGENT_COOKIE_NAME);
  cookieStore.delete(WS_TOKEN_COOKIE_NAME);
  cookieStore.delete(WS_TOKEN_ID_COOKIE_NAME);
  cookieStore.delete(ENGINE_COOKIE_NAME);
  return NextResponse.json({ success: true });
}
