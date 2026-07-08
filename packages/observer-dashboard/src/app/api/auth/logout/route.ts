import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';

export const runtime = 'edge';

const COOKIE_NAME = 'relaycast_key';
const AGENT_COOKIE_NAME = 'relaycast_agent_token';
const WS_TOKEN_COOKIE_NAME = 'relaycast_ws_token';
const ENGINE_COOKIE_NAME = 'relaycast_engine';

/**
 * POST /api/auth/logout
 * Clears auth cookies.
 */
export async function POST(_request: NextRequest) {
  const cookieStore = await cookies();

  cookieStore.delete(COOKIE_NAME);
  cookieStore.delete(AGENT_COOKIE_NAME);
  cookieStore.delete(WS_TOKEN_COOKIE_NAME);
  cookieStore.delete(ENGINE_COOKIE_NAME);
  return NextResponse.json({ success: true });
}
