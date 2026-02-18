import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';

const COOKIE_NAME = 'relaycast_key';
const AGENT_COOKIE_NAME = 'relaycast_agent_token';

/**
 * POST /api/auth/logout
 * Clears both auth cookies.
 */
export async function POST() {
  const cookieStore = await cookies();
  cookieStore.delete(COOKIE_NAME);
  cookieStore.delete(AGENT_COOKIE_NAME);
  return NextResponse.json({ success: true });
}
