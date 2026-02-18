import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { RelayCast } from '@relaycast/sdk';

const COOKIE_NAME = 'relaycast_key';
const AGENT_COOKIE_NAME = 'relaycast_agent_token';

/**
 * GET /api/auth/session
 * Returns session tokens for the RelayProvider.
 * Called by the client on mount/refresh.
 * Also ensures the observer agent is joined to all channels.
 */
export async function GET() {
  const cookieStore = await cookies();
  const apiKey = cookieStore.get(COOKIE_NAME)?.value;
  const agentToken = cookieStore.get(AGENT_COOKIE_NAME)?.value;

  if (!apiKey || !agentToken) {
    return NextResponse.json(
      { authenticated: false },
      { status: 401 }
    );
  }

  const baseUrl = process.env.RELAY_SERVER_URL || 'http://localhost:3890';

  // Ensure observer is joined to all channels (handles channels created since login)
  try {
    const relay = new RelayCast({ apiKey, baseUrl });
    const observerClient = relay.as(agentToken);
    const channels = await relay.channels.list();
    await Promise.allSettled(
      channels.map((ch) => observerClient.channels.join(ch.name))
    );
  } catch {
    // Non-fatal: tokens may be expired, will be caught by RelayProvider
  }

  return NextResponse.json({
    authenticated: true,
    apiKey,
    agentToken,
    baseUrl,
  });
}
