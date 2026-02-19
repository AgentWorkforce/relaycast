import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { RelayCast } from '@relaycast/sdk';
import { resolveRelayServerUrlFromRequest } from '../../../../lib/relay-server';

const COOKIE_NAME = 'relaycast_key';
const AGENT_COOKIE_NAME = 'relaycast_agent_token';

/**
 * GET /api/auth/session
 * Returns session tokens for the RelayProvider.
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

  const baseUrl = resolveRelayServerUrlFromRequest(request);
  const relay = new RelayCast({ apiKey, baseUrl });

  try {
    await relay.workspace.info();
  } catch {
    return NextResponse.json(
      { authenticated: false },
      { status: 401 }
    );
  }

  return NextResponse.json({
    authenticated: true,
    apiKey,
    agentToken: agentToken ?? apiKey,
    wsToken: apiKey,
    baseUrl,
  });
}
