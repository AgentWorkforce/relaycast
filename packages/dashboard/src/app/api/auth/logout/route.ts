import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { RelayCast } from '@relaycast/sdk';
import { resolveRelayServerUrlFromRequest } from '../../../../lib/relay-server';

export const runtime = 'edge';

const COOKIE_NAME = 'relaycast_key';
const AGENT_COOKIE_NAME = 'relaycast_agent_token';

/**
 * POST /api/auth/logout
 * Disables workspace stream (best-effort) and clears auth cookies.
 */
export async function POST(request: NextRequest) {
  const cookieStore = await cookies();
  const apiKey = cookieStore.get(COOKIE_NAME)?.value;

  if (apiKey?.startsWith('rk_live_')) {
    const relayServer = resolveRelayServerUrlFromRequest(request);
    const relay = new RelayCast({ apiKey, baseUrl: relayServer });
    try {
      await relay.workspace.stream.set(false);
    } catch (error) {
      // Stream toggling should not block logout.
      console.warn('[api/auth/logout] Failed to disable workspace stream:', error);
    }
  }

  cookieStore.delete(COOKIE_NAME);
  cookieStore.delete(AGENT_COOKIE_NAME);
  return NextResponse.json({ success: true });
}
