import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { RelayCast } from '@relaycast/sdk';

const COOKIE_NAME = 'relaycast_key';
const AGENT_COOKIE_NAME = 'relaycast_agent_token';

/**
 * GET /api/auth/session
 * Returns session tokens for the RelayProvider.
 * Called by the client on mount/refresh.
 */
export async function GET() {
  const cookieStore = await cookies();
  const apiKey = cookieStore.get(COOKIE_NAME)?.value;
  const agentToken = cookieStore.get(AGENT_COOKIE_NAME)?.value;

  if (!apiKey) {
    return NextResponse.json(
      { authenticated: false },
      { status: 401 }
    );
  }

  const baseUrl = process.env.RELAY_SERVER_URL || 'http://localhost:3890';
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
